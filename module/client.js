import * as crypto from 'node:crypto';
import { stripVTControlCharacters as strip } from 'node:util';
import { load, file, origin, classify } from './session.js';

export class Failure extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'Failure';
    this.status = status;
  }
}

function failure(body, fallback, { status, route, redact = text => text } = {}) {
  const detail = [body?.error?.message, body?.error?.msg, typeof body?.error === 'string' ? body.error : null, body?.message, body?.msg, typeof body?.detail === 'string' ? body.detail : null].find(value => typeof value === 'string' && value.trim());
  const code = body?.error?.code ?? body?.code;
  const safe = value => strip(redact(String(value))).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500);
  const error = new Failure(`${fallback}${detail ? ' ' + safe(detail) : ''}${route ? ' (' + route + ')' : ''}`, status);
  if (typeof code === 'string' || typeof code === 'number') error.code = safe(code).slice(0, 80);
  error.route = route;
  if (error.code) error.message += ` [${error.code}]`;
  return error;
}
function network(error, url, timeout, redact) {
  const cause = error?.cause;
  const code = cause?.code || error?.code || error?.name;
  const detail = cause?.message || error?.message || 'unknown network error';
  const safe = strip(redact(String(detail))).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
  const hint = code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? ' Check DNS or your network connection.'
    : code === 'ECONNREFUSED' ? ' The remote endpoint refused the connection.'
      : error?.name === 'TimeoutError' ? ` The ${timeout}ms request timeout elapsed.` : '';
  const result = new Failure(`Qwen network request failed: ${safe}${hint} (${url.pathname})`, undefined);
  result.code = typeof code === 'string' ? code : undefined;
  result.route = url.pathname;
  result.cause = error;
  return result;
}
function validate(body, options) {
  if (Array.isArray(body?.ret) && body.ret.some((code) => /USER_VALIDATE|RGV587/.test(code))) {
    const error = new Failure('Qwen requires browser verification for this API request. Complete it in the existing Chrome tab, then retry; /session check only confirms account authentication.', 403);
    error.challenge = true;
    throw error;
  }
  if (body?.success === false || body?.error) throw failure(body, 'Qwen rejected the request.', options);
}

export function cookies(config, url, now = Date.now() / 1000) {
  const target = new URL(url);
  return config.cookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, '');
    const match = cookie.domain.startsWith('.')
      ? target.hostname === domain || target.hostname.endsWith(`.${domain}`)
      : target.hostname === domain;
    const path = cookie.path || '/';
    const scope = target.pathname === path || (target.pathname.startsWith(path) && (path.endsWith('/') || target.pathname[path.length] === '/'));
    return match && scope && (!cookie.secure || target.protocol === 'https:') &&
      (cookie.expires === -1 || cookie.expires === undefined || cookie.expires > now);
  }).sort((a, b) => (b.path?.length ?? 1) - (a.path?.length ?? 1))
    .map(({ name, value }) => `${name}=${value}`).join('; ');
}

// SSE may split UTF-8 characters, lines, and JSON across arbitrary network chunks.
export async function* events(body) {
  if (!body) throw new Failure('Qwen returned an empty response stream.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let ended = false;
  function parse() {
    const text = data.join('\n');
    data = [];
    if (text === '[DONE]') return { done: true };
    try { return JSON.parse(text); }
    catch { throw new Failure('Qwen returned malformed streaming data.'); }
  }
  try {
    while (!ended) {
      const chunk = await reader.read();
      ended = chunk.done;
      buffer += decoder.decode(chunk.value, { stream: !ended });
      while (true) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (!match || (!ended && match[0] === '\r' && match.index === buffer.length - 1)) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (!line && data.length) yield parse();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
    if (data.length) yield parse();
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function answer(body, delta = () => {}, options = {}) {
  let text = '';
  let complete = false;
  let response;
  for await (const event of events(body)) {
    if (event.error || event.success === false) throw failure(event, 'Qwen reported an error while generating the response.', options);
    if (event['response.failed'] || event['response.error']) throw failure(event['response.failed'] || event['response.error'], 'Qwen could not complete the response.', options);
    response ||= event.response_id || event['response.created']?.response_id || event['response.info']?.response_id;
    const choice = event.choices?.[0];
    const content = choice?.delta;
    if (content?.status === 'error' || content?.status === 'failed') throw new Failure('Qwen failed while generating the response.');
    if (typeof content?.content === 'string' && (!content.phase || content.phase === 'answer')) {
      text += content.content;
      if (content.content) delta(content.content);
    }
    if (content?.phase === 'answer' && content?.status === 'finished' || choice?.finish_reason || event.done || event['response.completed']) {
      complete = true;
      break;
    }
  }
  if (!complete) throw new Failure('Qwen disconnected before completing the response. Any displayed text is partial.');
  if (!text.trim()) throw new Failure('Qwen completed the request without an answer.');
  return { text, response: typeof response === 'string' && response ? response : undefined };
}

async function qwen({ location = process.env.SESSION || file, request = fetch, timeout = 120_000 } = {}) {
  const config = await load(location);
  if (!config) throw new Failure('No saved Qwen session. Run npx qlyx to sign in.', 401);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Failure('Timeout must be a positive number.');
  let account;
  const secrets = config.cookies.map(cookie => cookie.value).filter(value => typeof value === 'string' && value.length >= 8).sort((a, b) => b.length - a.length);
  const redact = text => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), text);

  async function call(route, { data, signal } = {}) {
    const url = new URL(route, origin);
    if (url.origin !== origin) throw new Failure('Requests must remain on Qwen.');
    const headers = {
      accept: 'application/json', cookie: cookies(config, url),
      origin, referer: `${origin}/`, 'x-request-id': crypto.randomUUID(),
      timezone: new Date().toString().replace(/\s*\(.+\)$/, ''),
    };
    for (const key of ['source', 'version', 'accept-language']) {
      if (typeof config.headers?.[key] === 'string') headers[key] = config.headers[key];
    }
    if (data) headers['content-type'] = 'application/json';
    if (data?.stream) headers['X-Accel-Buffering'] = 'no';
    let response;
    try {
      response = await request(url, {
        method: data ? 'POST' : 'GET', headers, body: data ? JSON.stringify(data) : undefined,
        redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw network(error, url, timeout, redact);
    }
    if (!response.ok) {
      const type = response.headers.get('content-type') || '';
      const raw = await response.text().catch(() => '');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw ? { detail: raw } : null; }
      if (response.status === 401) throw new Failure('Qwen session expired. Run npx qlyx and use /session check to sign in.', 401);
      const error = failure(body, `Qwen returned HTTP ${response.status}.`, { status: response.status, route: url.pathname, redact });
      if (response.status === 403) error.hint = 'Open chat.qwen.ai in the existing Chrome, complete verification, then run npx qlyx and use /session check.';
      throw error;
    }
    return response;
  }

  async function json(route, options) {
    const response = await call(route, options);
    let body;
    try { body = await response.json(); }
    catch { throw new Failure('Qwen returned an unexpected response instead of JSON.'); }
    validate(body, { status: response.status, route, redact });
    return body;
  }

  async function check({ signal } = {}) {
    const body = await json('/api/v1/auths/', { signal });
    const result = classify({ status: 200, body });
    account = crypto.createHash('sha256').update((body.data ?? body).id).digest('hex');
    return result;
  }

  async function models({ signal } = {}) {
    const body = await json('/api/v2/models/', { signal });
    const list = body?.data?.data ?? body?.data;
    if (!Array.isArray(list)) throw new Failure('Qwen returned an unrecognized model list.');
    return list.filter((model) => typeof model.id === 'string' && model.info?.is_active !== false);
  }

  async function send(prompt, { model, signal, thinking = false, delta = () => {}, chat, parent = null, opened = async () => {} } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Failure('Enter a nonempty prompt.');
    const list = await models({ signal });
    model ||= list.find((item) => item.info?.meta?.chat_type?.includes('t2t'))?.id ?? list[0]?.id;
    if (!model || !list.some((item) => item.id === model)) throw new Failure('The requested model is not available on this account.');
    if (!chat) {
      const created = await json('/api/v2/chats/new', { signal, data: {
        chatId: '', models: [model], chat_type: 't2t', chat_mode: 'normal', timestamp: Date.now(),
      } });
      chat = created?.data?.id;
    }
    if (typeof chat !== 'string' || !chat) throw new Failure('Qwen did not return a new chat identifier.');
    await opened(chat);
    const timestamp = Math.floor(Date.now() / 1000);
    const message = {
      id: null, fid: crypto.randomUUID(), parentId: parent, parent_id: parent, childrenIds: [],
      role: 'user', content: prompt, user_action: 'chat', files: [], models: [model], model: '',
      chat_type: 't2t', sub_chat_type: 't2t', timestamp,
      feature_config: { thinking_enabled: thinking, output_schema: 'phase', research_mode: 'normal', auto_thinking: false, auto_search: false },
      extra: { meta: { subChatType: 't2t' } },
    };
    const response = await call(`/api/v2/chat/completions?chat_id=${encodeURIComponent(chat)}`, { signal, data: {
      stream: true, version: '2.1', incremental_output: true, chatId: chat, chat_id: chat,
      parentId: parent || '', parent_id: parent, chat_mode: 'normal', model, messages: [message], timestamp,
    } });
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const body = await response.json().catch(() => null);
      validate(body, { status: response.status, route: '/api/v2/chat/completions', redact });
      throw new Failure('Qwen rejected the chat request: the server returned a non-stream response without a readable error body.', 400);
    }
    return { ...await answer(response.body, delta, { redact, route: '/api/v2/chat/completions' }), chat, model };
  }
  return { provider: 'qwen', check, models, send, redact, get account() { return account; } };
}

export async function create(options = {}) {
  const provider = options.provider || process.env.PROVIDER || 'qwen';
  if (provider === 'qwen') return qwen(options);
  if (provider === 'deepseek') return (await import('./deepseek.js')).create(options);
  throw new Failure('Provider must be qwen or deepseek.');
}

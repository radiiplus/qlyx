import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stripVTControlCharacters as strip } from 'node:util';
import { attach, discover, store as persist } from './session.js';
import { home } from './store.js';

export const origin = 'https://chat.deepseek.com';
export const file = path.join(home, 'deepseek.json');
const challenge = '/api/v0/chat/create_pow_challenge';
const completion = '/api/v0/chat/completion';
const worker = process.env.DEEPSEEK_WORKER || 'https://fe-static.deepseek.com/chat/static/76608.8f2a9fa413.js';
const allowed = new Set(['x-app-version', 'x-client-version', 'x-client-platform', 'x-client-locale', 'x-client-bundle-id', 'x-client-timezone-offset']);
const defaults = {
  'x-client-platform': 'web',
  'x-client-version': '2.2.0',
  'x-client-locale': 'en_US',
  'x-client-bundle-id': 'com.deepseek.chat',
};
const list = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', info: { is_active: true }, kind: 'default' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', info: { is_active: true }, kind: 'expert' },
];

function failure(message, status, code) {
  const error = new Error(message);
  error.name = 'Failure';
  error.status = status;
  error.code = code;
  return error;
}

function token(config) {
  const raw = config?.local?.userToken;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const value = JSON.parse(raw);
    if (typeof value === 'string') return value;
    return typeof value?.value === 'string' ? value.value : null;
  } catch { return raw; }
}

function cookie(config, url = origin, now = Date.now() / 1000) {
  const host = new URL(url).hostname;
  return (config?.cookies || []).filter(item => {
    const domain = item.domain.replace(/^\./, '');
    return (host === domain || item.domain.startsWith('.') && host.endsWith(`.${domain}`)) &&
      (!item.secure || url.startsWith('https:')) && (item.expires === -1 || item.expires === undefined || item.expires > now);
  }).map(item => `${item.name}=${item.value}`).join('; ');
}

function headers(value, saved = {}) {
  return { authorization: `Bearer ${value}`, 'content-type': 'application/json', ...defaults,
    ...Object.fromEntries(Object.entries(saved).filter(([key, item]) => allowed.has(key) && typeof item === 'string')) };
}

function unwrap(body, name) {
  const data = body?.data;
  if (body?.code !== 0 || data?.biz_code !== 0 || !data?.biz_data) {
    const detail = [body?.msg, data?.biz_msg].find(item => typeof item === 'string' && item.trim());
    throw failure(`DeepSeek rejected ${name}.${detail ? ` ${detail}` : ''}`, 400, body?.code ?? data?.biz_code);
  }
  return data.biz_data;
}

export async function load(location = file) {
  let text;
  try { text = await fs.readFile(location, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let config;
  try { config = JSON.parse(text); }
  catch { throw new Error('DeepSeek session config is not valid JSON. Move it aside to sign in again.'); }
  const domains = new Set(['chat.deepseek.com', '.chat.deepseek.com', 'deepseek.com', '.deepseek.com']);
  if (config?.schema !== 1 || config.origin !== origin || !Array.isArray(config.cookies) ||
      !config.local || typeof config.local !== 'object' || Array.isArray(config.local) ||
      !config.tab || typeof config.tab !== 'object' || Array.isArray(config.tab) ||
      Object.values(config.local).some(value => typeof value !== 'string') ||
      Object.values(config.tab).some(value => typeof value !== 'string') ||
      config.cookies.some(item => !item?.domain || !domains.has(item.domain))) {
    throw new Error('DeepSeek session config has an unsupported format.');
  }
  return config;
}

async function* events(body) {
  if (!body) throw failure('DeepSeek returned an empty response stream.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  function parse(block) {
    let event = null;
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return null;
    try { return { event, data: JSON.parse(data.join('\n')) }; }
    catch { throw failure('DeepSeek returned malformed streaming data.'); }
  }
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop();
      for (const block of blocks) { const value = parse(block); if (value) yield value; }
      if (chunk.done) {
        if (buffer.trim()) { const value = parse(buffer); if (value) yield value; }
        return;
      }
    }
  } finally { reader.releaseLock(); }
}

async function answer(body, delta = () => {}) {
  let text = '', reason = '', current = 'reason', response, complete = false;
  function add(fragment) {
    if (!fragment || typeof fragment !== 'object') return;
    if (fragment.type === 'THINK') current = 'reason';
    if (fragment.type === 'RESPONSE') current = 'text';
    if (typeof fragment.content !== 'string') return;
    if (current === 'text') { text += fragment.content; if (fragment.content) delta(fragment.content); }
    else reason += fragment.content;
  }
  for await (const item of events(body)) {
    const data = item.data;
    if (item.event === 'ready') { response ||= data.response_message_id; continue; }
    if (item.event === 'close') { complete = true; break; }
    const snapshot = data?.v?.response;
    if (snapshot && typeof snapshot === 'object') {
      response ||= snapshot.message_id ?? snapshot.id;
      for (const fragment of Array.isArray(snapshot.fragments) ? snapshot.fragments : []) add(fragment);
      continue;
    }
    if (data?.p === 'response/fragments' && data.o === 'APPEND') {
      for (const fragment of Array.isArray(data.v) ? data.v : []) add(fragment);
      continue;
    }
    if (data?.p?.endsWith('message_id') && (typeof data.v === 'string' || typeof data.v === 'number')) response ||= data.v;
    const append = data?.p === 'response/fragments/-1/content' && data.o === 'APPEND' ||
      data?.p === undefined && data?.o === 'APPEND' && data?.v !== undefined ||
      data?.p === undefined && data?.o === undefined && typeof data?.v === 'string';
    if (append && typeof data.v === 'string') {
      if (current === 'text') { text += data.v; if (data.v) delta(data.v); }
      else reason += data.v;
    }
  }
  if (!complete) throw failure('DeepSeek disconnected before completing the response. Any displayed text is partial.');
  if (!text.trim() && reason.trim()) { text = reason; delta(reason); }
  if (!text.trim()) throw failure('DeepSeek completed the request without an answer.');
  return { text, response: response === undefined || response === null ? undefined : String(response) };
}

export async function connect({ location = process.env.SESSION || file, endpoint = process.env.ENDPOINT, profile = process.env.PROFILE,
  observe = async () => {}, log = console.log, attach: dial = attach } = {}) {
  location = path.resolve(location);
  let config = await load(location);
  endpoint ||= await discover(profile);
  log('Connecting to your existing browser. Accept its debugging prompt if shown.');
  const browser = await dial(endpoint);
  const context = browser.contexts()[0];
  let page, closed = false;
  const saved = {};
  async function close() {
    if (closed) return;
    closed = true;
    try { if (page && !page.isClosed()) await page.close(); }
    finally { await browser.close(); }
  }
  async function check() {
    if (new URL(page.url()).origin !== origin) return { authenticated: false, status: 401 };
    return page.evaluate(async ({ defaults, saved, challenge, completion }) => {
      let value = null;
      const raw = localStorage.getItem('userToken');
      if (raw) try { const parsed = JSON.parse(raw); value = typeof parsed === 'string' ? parsed : parsed?.value; } catch { value = raw; }
      if (!value) return { authenticated: false, status: 401 };
      try {
        const response = await fetch(challenge, { method: 'POST', headers: { authorization: `Bearer ${value}`, 'content-type': 'application/json', ...defaults, ...saved }, body: JSON.stringify({ target_path: completion }) });
        const body = await response.json().catch(() => null);
        return { authenticated: response.ok && body?.code === 0 && body?.data?.biz_code === 0, status: response.status };
      } catch { return { authenticated: false, status: 401 }; }
    }, { defaults, saved, challenge, completion });
  }
  async function save() {
    const cookies = await context.cookies([origin]);
    const storage = await page.evaluate(() => ({ local: Object.fromEntries(Object.entries(localStorage)), tab: Object.fromEntries(Object.entries(sessionStorage)) }));
    config = { schema: 1, origin, saved: new Date().toISOString(), headers: saved, cookies, ...storage };
    await persist(location, config);
    log(`DeepSeek session saved: ${location}`);
  }
  async function restore() {
    await context.addCookies(config.cookies);
    for (const [key, value] of Object.entries(config.headers || {})) if (allowed.has(key) && typeof value === 'string' && !saved[key]) saved[key] = value;
    await page.evaluate(({ local, tab }) => {
      for (const [key, value] of Object.entries(local)) localStorage.setItem(key, value);
      for (const [key, value] of Object.entries(tab)) sessionStorage.setItem(key, value);
    }, config);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  }
  async function ensure({ interactive = true, timeout = 10 * 60_000, signal } = {}) {
    signal?.throwIfAborted();
    let result = await check();
    if (!result.authenticated && config) { log('Restoring the saved DeepSeek session.'); await restore(); result = await check(); }
    if (result.authenticated) { log('Existing DeepSeek session is authenticated.'); await save(); return; }
    if (!interactive) throw failure('DeepSeek session is missing or expired. Run npx qlyx --provider deepseek and use /session check to sign in.', 401);
    log('DeepSeek session is missing or expired. Complete sign-in in the existing browser.');
    await page.goto(`${origin}/sign_in`, { waitUntil: 'commit', timeout: 60_000 }).catch(() => {});
    await page.bringToFront();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (closed || page.isClosed()) throw new Error('DeepSeek tab closed before authentication completed.');
      if ((await check()).authenticated) { await save(); log('DeepSeek authentication succeeded.'); return; }
      await page.waitForTimeout(1500);
    }
    throw new Error('DeepSeek sign-in timed out.');
  }
  try {
    if (!context) throw new Error('Existing browser has no accessible default context.');
    page = await context.newPage();
    page.on('request', request => {
      if (!request.url().startsWith(`${origin}/api/`)) return;
      for (const [key, value] of Object.entries(request.headers())) if (allowed.has(key)) saved[key] = value;
    });
    await observe(page);
    await page.goto(origin, { waitUntil: 'commit', timeout: 60_000 }).catch(error => { if (!/ERR_ABORTED/.test(error.message)) throw error; });
  } catch (error) { await close(); throw error; }
  return { page, location, check, ensure, save, close };
}

export async function create({ location = process.env.SESSION || file, request = fetch, timeout = 120_000,
  endpoint = process.env.ENDPOINT, profile = process.env.PROFILE, attach: dial = attach, solve } = {}) {
  const config = await load(location);
  if (!config) throw failure('No saved DeepSeek session. Run npx qlyx --provider deepseek to sign in.', 401);
  if (!Number.isFinite(timeout) || timeout <= 0) throw failure('Timeout must be a positive number.');
  const secrets = new Set((config.cookies || []).map(item => item.value).filter(value => typeof value === 'string' && value.length >= 8));
  const saved = token(config);
  if (saved) secrets.add(saved);
  const redact = text => [...secrets].sort((a, b) => b.length - a.length).reduce((value, secret) => value.split(secret).join('[REDACTED]'), String(text));
  let account = saved ? crypto.createHash('sha256').update(saved).digest('hex') : null;
  let browser, context, page;

  async function call(route, { data, signal, value = saved, proof, cookies = cookie(config) } = {}) {
    if (!value) throw failure('DeepSeek session is missing or expired. Run npx qlyx --provider deepseek to sign in.', 401);
    const url = new URL(route, origin);
    let response;
    try {
      response = await request(url, { method: 'POST', headers: { accept: route === completion ? 'text/event-stream' : 'application/json',
        ...headers(value, config.headers), cookie: cookies, origin, referer: `${origin}/`, ...(proof ? { 'x-ds-pow-response': proof } : {}) },
      body: JSON.stringify(data || {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
    } catch (error) {
      if (signal?.aborted) throw error;
      const detail = strip(redact(error?.cause?.message || error?.message || 'unknown network error')).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
      const result = failure(`DeepSeek network request failed: ${detail} (${url.pathname})`);
      result.code = error?.cause?.code || error?.code;
      throw result;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const detail = [body?.msg, body?.message, body?.data?.biz_msg].find(item => typeof item === 'string' && item.trim());
      const error = failure(`DeepSeek returned HTTP ${response.status}.${detail ? ` ${strip(redact(detail)).slice(0, 500)}` : ''} (${url.pathname})`, response.status, body?.code ?? body?.data?.biz_code);
      if ([401, 403].includes(response.status)) error.message = 'DeepSeek session expired or requires browser verification. Run npx qlyx --provider deepseek and use /session check.';
      throw error;
    }
    return response;
  }

  async function check({ signal } = {}) {
    const response = await call(challenge, { signal, data: { target_path: completion } });
    const body = await response.json().catch(() => null);
    const data = unwrap(body, 'the authentication check');
    if (!data.challenge) throw failure('DeepSeek authentication response did not contain a challenge.');
    account = crypto.createHash('sha256').update(saved).digest('hex');
    return { authenticated: true, status: response.status, transport: 'fetch' };
  }

  async function pow({ chat, kind, signal }) {
    signal?.throwIfAborted();
    if (!browser) {
      browser = await dial(endpoint || await discover(profile));
      context = browser.contexts()[0];
      if (!context) throw new Error('Existing browser has no accessible default context.');
      await context.addCookies(config.cookies);
      page = await context.newPage();
      await page.goto(origin, { waitUntil: 'commit', timeout: 60_000 }).catch(error => { if (!/ERR_ABORTED/.test(error.message)) throw error; });
      await page.evaluate(({ local, tab }) => {
        for (const [key, value] of Object.entries(local)) localStorage.setItem(key, value);
        for (const [key, value] of Object.entries(tab)) sessionStorage.setItem(key, value);
      }, config);
    }
    const ready = await page.evaluate(async ({ worker, challenge, completion, defaults, saved, chat, kind }) => {
      const record = value => typeof value === 'object' && value !== null && !Array.isArray(value);
      let value = null;
      const raw = localStorage.getItem('userToken');
      if (raw) try { const parsed = JSON.parse(raw); value = typeof parsed === 'string' ? parsed : parsed?.value; } catch { value = raw; }
      if (!value) throw new Error('DeepSeek userToken is unavailable. Sign in again.');
      const auth = { authorization: `Bearer ${value}`, 'content-type': 'application/json', ...defaults, ...saved };
      const response = await fetch(challenge, { method: 'POST', headers: auth, body: JSON.stringify({ target_path: completion }) });
      const body = await response.json();
      const item = body?.data?.biz_data?.challenge;
      if (!response.ok || body?.code !== 0 || body?.data?.biz_code !== 0 || !record(item)) throw new Error('DeepSeek proof challenge failed.');
      const source = await fetch(worker);
      if (!source.ok) throw new Error(`DeepSeek proof worker failed: HTTP ${source.status}`);
      const url = URL.createObjectURL(new Blob([await source.text()], { type: 'application/javascript' }));
      const answer = await new Promise((resolve, reject) => {
        const task = new Worker(url);
        const timer = setTimeout(() => { task.terminate(); reject(new Error('DeepSeek proof timed out.')); }, 120000);
        task.onmessage = event => { clearTimeout(timer); task.terminate(); event.data?.type === 'pow-answer' && record(event.data.answer) ? resolve(event.data.answer) : reject(new Error('DeepSeek proof failed.')); };
        task.onerror = event => { clearTimeout(timer); task.terminate(); reject(new Error(event.message || 'DeepSeek proof worker failed.')); };
        task.postMessage({ type: 'pow-challenge', challenge: { algorithm: item.algorithm, challenge: item.challenge, salt: item.salt,
          difficulty: item.difficulty, signature: item.signature, expireAt: item.expire_at } });
      }).finally(() => URL.revokeObjectURL(url));
      const proof = btoa(unescape(encodeURIComponent(JSON.stringify({ algorithm: answer.algorithm, challenge: answer.challenge, salt: answer.salt,
        answer: answer.answer, signature: answer.signature, target_path: completion }))));
      if (!chat) {
        const response = await fetch('/api/v0/chat_session/create', { method: 'POST', headers: auth, body: '{}' });
        const body = await response.json();
        chat = body?.data?.biz_data?.chat_session?.id;
        if (!response.ok || !chat) throw new Error('DeepSeek did not create a chat session.');
      }
      return { value, proof, chat, kind };
    }, { worker, challenge, completion, defaults, saved: config.headers || {}, chat, kind });
    const cookies = (await context.cookies([origin])).map(item => `${item.name}=${item.value}`).join('; ');
    return { ...ready, cookies };
  }

  solve ||= pow;
  async function models() { return list.map(({ kind, ...model }) => model); }
  async function send(prompt, { model, signal, thinking = false, delta = () => {}, chat, parent = null, opened = async () => {} } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw failure('Enter a nonempty prompt.');
    model ||= list[0].id;
    const choice = list.find(item => item.id === model);
    if (!choice) throw failure('The requested DeepSeek model is unavailable.');
    const ready = await solve({ config, chat, kind: choice.kind, signal });
    if (!ready?.value || !ready?.proof || !ready?.chat) throw failure('DeepSeek session preparation returned incomplete data.');
    secrets.add(ready.value);
    account = crypto.createHash('sha256').update(ready.value).digest('hex');
    chat = ready.chat;
    await opened(chat);
    const response = await call(completion, { signal, value: ready.value, proof: ready.proof, cookies: ready.cookies, data: {
      chat_session_id: chat, parent_message_id: /^\d+$/.test(parent || '') ? Number(parent) : parent, model_type: choice.kind,
      prompt, ref_file_ids: [], thinking_enabled: thinking, search_enabled: false, action: null, preempt: false,
    } });
    if (!response.headers.get('content-type')?.includes('text/event-stream')) throw failure('DeepSeek returned a non-stream response.', 400);
    return { ...await answer(response.body, delta), chat, model };
  }
  async function close() {
    try { if (page && !page.isClosed()) await page.close(); }
    finally { await browser?.close(); browser = undefined; page = undefined; context = undefined; }
  }
  return { provider: 'deepseek', check, models, send, redact, close, get account() { return account; } };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { create, answer, cookies } from '../module/client.js';
import { loading } from '../module/loading.js';
import { store, origin } from '../module/session.js';

function stream(text, width = 1) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) return controller.close();
    controller.enqueue(bytes.slice(offset, offset += width));
  } });
}
function event(content, status = 'typing', phase = 'answer') {
  return `data: ${JSON.stringify({ choices: [{ delta: { content, status, phase } }] })}\n\n`;
}

test('stream handles fragmented Unicode, CRLF, metadata, and answer phases', async () => {
  const text = ': heartbeat\r\nevent: message\r\ndata: {"response.created":{"response_id":"fixture"}}\r\n\r\n' +
    event('hidden', 'typing', 'thinking') + event('Hello 🌍') + event('', 'finished');
  const chunks = [];
  const result = await answer(stream(text), (chunk) => chunks.push(chunk));
  assert.equal(result.text, 'Hello 🌍');
  assert.equal(result.response, 'fixture');
  assert.deepEqual(chunks, ['Hello 🌍']);
  const info = await answer(stream('data: {"response.info":{"response_id":"later"}}\n\n' + event('Done', 'finished')));
  assert.equal(info.response, 'later');
});

test('stream rejects errors, incomplete answers, malformed events, and empty answers', async () => {
  await assert.rejects(answer(stream(event('partial'))), /disconnected/);
  await assert.rejects(answer(stream(event('', 'finished'))), /without an answer/);
  await assert.rejects(answer(stream('data: {bad}\n\n')), /malformed/);
  await assert.rejects(answer(stream('data: {"error":{"message":"failed"}}\n\n')), /error/);
  await assert.rejects(answer(stream('data: {"response.failed":{}}\n\n')), /could not complete/);
  assert.equal((await answer(stream(event('done') + 'data: [DONE]'))).text, 'done');
});

test('cookie selection respects host, path boundaries, expiry, and secure transport', () => {
  const config = { cookies: [
    { name: 'valid', value: 'yes', domain: '.qwen.ai', path: '/', expires: -1, secure: true },
    { name: 'scoped', value: 'yes', domain: 'chat.qwen.ai', path: '/api', expires: -1 },
    { name: 'expired', value: 'no', domain: 'chat.qwen.ai', path: '/', expires: 1 },
    { name: 'other', value: 'no', domain: 'other.qwen.ai', path: '/', expires: -1 },
    { name: 'private', value: 'no', domain: 'chat.qwen.ai', path: '/api/private', expires: -1 },
  ] };
  assert.equal(cookies(config, `${origin}/api/v1/auths/`, 100), 'scoped=yes; valid=yes');
  assert.equal(cookies(config, `${origin}/apix`, 100), 'valid=yes');
  assert.equal(cookies(config, 'http://chat.qwen.ai/', 100), '');
});

async function config(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'client-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const location = path.join(directory, 'session.json');
  await store(location, { schema: 1, origin, local: {}, tab: {}, cookies: [{ name: 'token', value: 'fixture', domain: 'chat.qwen.ai', path: '/', expires: -1, secure: true }] });
  return location;
}

test('client checks auth, creates one chat, and streams a direct HTTP response', async (t) => {
  const calls = [];
  const client = await create({ location: await config(t), request: async (url, options) => {
    calls.push(url.pathname);
    assert.equal(url.origin, origin);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.cookie, 'token=fixture');
    if (url.pathname === '/api/v1/auths/') return Response.json({ id: 'fixture' });
    if (url.pathname === '/api/v2/models/') return Response.json({ data: { data: [{ id: 'fixture', info: { meta: { chat_type: ['t2t'] } } }] } });
    const body = JSON.parse(options.body);
    assert.equal(options.method, 'POST');
    if (url.pathname === '/api/v2/chats/new') {
      assert.deepEqual(body.models, ['fixture']);
      return Response.json({ success: true, data: { id: 'chat' } });
    }
    assert.equal(url.searchParams.get('chat_id'), 'chat');
    assert.equal(body.messages[0].content, 'Say hello 🌍');
    assert.equal(body.stream, true);
    return new Response(stream(event('Hello 🌍') + event('', 'finished')), { headers: { 'content-type': 'text/event-stream' } });
  } });
  assert.equal((await client.check()).authenticated, true);
  const result = await client.send('Say hello 🌍');
  assert.equal(result.text, 'Hello 🌍');
  assert.equal(result.chat, 'chat');
  assert.deepEqual(calls, ['/api/v1/auths/', '/api/v2/models/', '/api/v2/chats/new', '/api/v2/chat/completions']);
});

test('expired auth and rate limiting fail without retrying or creating chats', async (t) => {
  const location = await config(t);
  for (const status of [401, 429, 500]) {
    let calls = 0;
    const client = await create({ location, request: async () => { calls++; return new Response('{}', { status }); } });
    await assert.rejects(client.check(), (error) => error.status === status);
    assert.equal(calls, 1);
  }
  const client = await create({ location, request: async () => { throw new Error('must not send'); } });
  await assert.rejects(client.send(' '), /nonempty/);
});

test('loading reports pending and clears a terminal spinner only once', () => {
  for (const terminal of [true, false]) {
    const writes = [];
    const stop = loading({ output: { isTTY: terminal, write: (text) => writes.push(text) } });
    assert.match(writes[0], /Waiting for model/);
    stop();
    const count = writes.length;
    stop();
    assert.equal(writes.length, count);
    if (terminal) assert.equal(writes.at(-1), '\r\u001b[2K');
    else assert.ok(writes.every((text) => !text.includes('\u001b')));
  }
});

test('browser verification challenges produce an actionable error without resending', async (t) => {
  let calls = 0;
  const client = await create({ location: await config(t), request: async (url) => {
    calls++;
    if (url.pathname.endsWith('/models/')) return Response.json({ data: { data: [{ id: 'fixture' }] } });
    if (url.pathname.endsWith('/new')) return Response.json({ success: true, data: { id: 'chat' } });
    return Response.json({ ret: ['FAIL_SYS_USER_VALIDATE'], data: { url: 'https://example.com/private' } });
  } });
  await assert.rejects(client.send('hello'), (error) => error.status === 403 && /browser verification/.test(error.message) && !error.message.includes('private'));
  assert.equal(calls, 3);
});

test('cancellation reaches HTTP requests and does not retry', async (t) => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const client = await create({ location: await config(t), request: async (url, options) => {
    calls++;
    options.signal.throwIfAborted();
  } });
  await assert.rejects(client.check({ signal: controller.signal }), (error) => error.name === 'AbortError');
  assert.equal(calls, 1);
});

test('network failures identify the cause and route without leaking session data', async t => {
  const location = await config(t);
  const saved = JSON.parse(await fs.readFile(location, 'utf8')); saved.cookies[0].value = 'credential-secret'; await store(location, saved);
  const client = await create({ location, timeout: 3210, request: async () => {
    const error = new TypeError('fetch failed');
    error.cause = Object.assign(new Error('getaddrinfo ENOTFOUND chat.qwen.ai credential-secret'), { code: 'ENOTFOUND' });
    throw error;
  } });
  await assert.rejects(client.check(), error => {
    assert.match(error.message, /Qwen network request failed: getaddrinfo ENOTFOUND chat\.qwen\.ai \[REDACTED\]/);
    assert.match(error.message, /Check DNS or your network connection/);
    assert.match(error.message, /\/api\/v1\/auths\//);
    assert.equal(error.code, 'ENOTFOUND');
    assert.equal(error.route, '/api/v1/auths/');
    assert.ok(!error.message.includes('credential-secret'));
    return true;
  });
});

test('provider errors retain a safe reason, code, and route without exposing credentials or terminal controls', async t => {
  const location = await config(t);
  await store(location, { schema: 1, origin, local: {}, tab: {}, cookies: [{ name: 'token', value: 'private-credential', domain: 'chat.qwen.ai', path: '/', expires: -1 }] });
  for (const status of [200, 400]) {
    const client = await create({ location, request: async () => Response.json({ success: false, error: { code: 'INVALID_PARENT', message: '\x1b[2JUnknown parent private-credential' } }, { status }) });
    await assert.rejects(client.models(), error => {
      assert.equal(error.status, status);
      assert.equal(error.code, 'INVALID_PARENT');
      assert.equal(error.route, '/api/v2/models/');
      assert.match(error.message, /Unknown parent \[REDACTED\]/);
      assert.ok(!error.message.includes('private-credential'));
      assert.ok(!error.message.includes('\x1b'));
      return true;
    });
  }
  await assert.rejects(answer(stream('data: {"error":{"code":"QUOTA","message":"Limit reached"}}\n\n')), error => error.code === 'QUOTA' && /Limit reached/.test(error.message));
});

test('runtime reconnects once after a recoverable Qwen stream failure and restores local context', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reconnect-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [], notices = [];
  const original = globalThis.fetch;
  let attempt = 0;
  globalThis.fetch = async (url, options) => {
    const address = new URL(url); calls.push(address.pathname);
    if (address.pathname.endsWith('/auths/')) return Response.json({ data: { id: 'user' } });
    if (address.pathname.endsWith('/models/')) return Response.json({ data: { data: [{ id: 'fixture', info: { is_active: true } }] } });
    if (address.pathname.endsWith('/chats/new')) return Response.json({ data: { id: 'remote-' + calls.filter(item => item.endsWith('/chats/new')).length } });
    if (address.pathname.includes('/chat/completions')) {
      if (attempt++ === 0) throw Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
      const response = JSON.stringify({ action: 'final', message: 'Recovered.' });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { phase: 'answer', content: response, status: 'finished' } }] })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error('unexpected request');
  };
  const { runtime } = await import('../module/runtime.js');
  const engine = await runtime({ root, session: await config(t), unattended: true, notify: event => notices.push(event), catalog: await (await import('../module/database.js')).database({ location: path.join(root, 'db.sqlite') }) });
  t.after(() => { globalThis.fetch = original; return engine.close(); });
  const result = await engine.send('Recover this request.');
  assert.equal(result.status, 'complete'); assert.equal(result.message, 'Recovered.');
  assert.ok(notices.some(event => event.type === 'reconnect'));
  assert.equal(calls.filter(item => item.includes('/chat/completions')).length, 2);
  assert.equal(calls.filter(item => item.endsWith('/chats/new')).length, 2);
});

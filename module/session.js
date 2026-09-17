import { chromium } from 'playwright';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath as filename } from 'node:url';
import { archive, home } from './store.js';
import { open as raw } from './cdp.js';

export const origin = 'https://chat.qwen.ai';
export const file = path.join(home, 'session.json');
const legacy = filename(new URL('../config/session.json', import.meta.url));
const former = path.join(archive, 'session.json');
const authentication = '/api/v1/auths/';
const allowed = new Set(['source', 'version', 'accept-language']);

export function classify({ status, body }) {
  if (status === 401) return { authenticated: false, status };
  if (status !== 200) throw new Error(`Authentication check returned HTTP ${status}; this is not a confirmed expired session.`);
  const user = body?.data ?? body;
  if (body?.success === false || typeof user?.id !== 'string' || !user.id) {
    throw new Error('Authentication response did not contain a recognized user identity.');
  }
  return { authenticated: true, status };
}

export async function load(location = file) {
  let text;
  try { text = await fs.readFile(location, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (path.resolve(location) !== path.resolve(file)) return null;
    try {
      try { text = await fs.readFile(former, 'utf8'); }
      catch (fallback) {
        if (fallback.code !== 'ENOENT') throw fallback;
        text = await fs.readFile(legacy, 'utf8');
      }
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 }).catch(failure => {
        if (failure.code !== 'EEXIST') throw failure;
      });
      await fs.chmod(file, 0o600);
    } catch (failure) { if (failure.code === 'ENOENT') return null; throw failure; }
  }
  let config;
  try { config = JSON.parse(text); }
  catch { throw new Error('Session config is not valid JSON. Move it aside to start a new session.'); }
  if (config?.schema !== 1 || config.origin !== origin || !Array.isArray(config.cookies) ||
      !config.local || typeof config.local !== 'object' || Array.isArray(config.local) ||
      !config.tab || typeof config.tab !== 'object' || Array.isArray(config.tab) ||
      Object.values(config.local).some((value) => typeof value !== 'string') ||
      Object.values(config.tab).some((value) => typeof value !== 'string') ||
      config.cookies.some((cookie) => !cookie?.domain || !['chat.qwen.ai', 'qwen.ai', '.chat.qwen.ai', '.qwen.ai'].includes(cookie.domain))) {
    throw new Error('Session config has an unsupported format.');
  }
  return config;
}

export async function store(location, config) {
  await fs.mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
  const temporary = `${location}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, location);
    await fs.chmod(location, 0o600);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function discover(profile = process.env.PROFILE) {
  const profiles = profile ? [profile] : [
    path.join(os.homedir(), '.config/google-chrome'),
    path.join(os.homedir(), '.config/chromium'),
    path.join(os.homedir(), 'snap/chromium/common/chromium'),
  ];
  for (const directory of profiles) {
    let text;
    try { text = await fs.readFile(path.join(directory, 'DevToolsActivePort'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const [port, route] = text.trim().split(/\r?\n/);
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(route)) continue;
    return `ws://127.0.0.1:${port}${route}`;
  }
  throw new Error('Enable remote debugging in your existing Chrome at chrome://inspect/#remote-debugging, then retry. Set ENDPOINT if using an explicit debugging URL.');
}

function http(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
    return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
  } catch { return null; }
}

const native = target => chromium.connectOverCDP(target, { timeout: 5_000 });

export async function attach(endpoint, dial = native) {
  let failure;
  if (dial === native && endpoint.startsWith('ws:')) {
    try {
      const quick = await raw(endpoint);
      if (quick.busy) return quick;
      await quick.close();
    } catch (error) { failure = error; }
  }
  for (const target of [endpoint, http(endpoint)].filter(Boolean)) {
    try { return await dial(target); }
    catch (error) { failure = error; }
  }
  if (dial === native && endpoint.startsWith('ws:')) {
    try { return await raw(endpoint); }
    catch (error) { failure = error; }
  }
  throw new Error(`Could not attach to the existing browser at ${endpoint}. Ensure Chrome remote debugging is enabled and accept its connection prompt. ${failure?.message || ''}`.trim());
}

/** Connects to the existing browser. Only a new Qwen tab is owned by this module. */
export async function connect({
  location = process.env.SESSION || file,
  endpoint = process.env.ENDPOINT,
  profile = process.env.PROFILE,
  observe = async () => {},
  log = console.log,
  attach: dial = attach,
} = {}) {
  location = path.resolve(location);
  let config = await load(location);
  endpoint ||= await discover(profile);
  log('Connecting to your existing browser. Accept its debugging prompt if shown.');
  const browser = await dial(endpoint);
  const context = browser.contexts()[0];
  let page;
  let closed = false;
  const headers = {};

  async function close() {
    if (closed) return;
    closed = true;
    try { if (page && !page.isClosed()) await page.close(); }
    finally { await browser.close(); } // For a CDP connection this disconnects, leaving Chrome running.
  }

  function metadata() {
    return { accept: 'application/json', ...headers, 'x-request-id': crypto.randomUUID(), timezone: new Date().toString().replace(/\s*\(.+\)$/, '') };
  }

  async function check() {
    if (new URL(page.url()).origin !== origin) throw new Error('The browser tab is currently outside Qwen.');
    const result = await page.evaluate(async ({ route, headers }) => {
      const response = await fetch(route, { headers, credentials: 'same-origin', signal: AbortSignal.timeout(20_000) });
      let body = null;
      try { body = await response.json(); } catch { /* Validated by the caller. */ }
      return { status: response.status, body };
    }, { route: authentication, headers: metadata() });
    return classify(result);
  }

  async function save() {
    if (new URL(page.url()).origin !== origin) throw new Error('Session can only be saved from Qwen.');
    const cookies = await context.cookies([origin, `${origin}/auth`, `${origin}${authentication}`, `${origin}/api/v2/`]);
    const storage = await page.evaluate(() => ({ local: Object.fromEntries(Object.entries(localStorage)), tab: Object.fromEntries(Object.entries(sessionStorage)) }));
    config = { schema: 1, origin, saved: new Date().toISOString(), headers, cookies, ...storage };
    await store(location, config);
    log(`Session saved: ${location}`);
  }

  async function restore() {
    await context.addCookies(config.cookies);
    for (const [key, value] of Object.entries(config.headers ?? {})) {
      if (allowed.has(key) && typeof value === 'string' && !headers[key]) headers[key] = value;
    }
    await page.evaluate(({ local, tab }) => {
      for (const [key, value] of Object.entries(local)) localStorage.setItem(key, value);
      for (const [key, value] of Object.entries(tab)) sessionStorage.setItem(key, value);
    }, config);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  }

  async function ensure({ interactive = true, timeout = 10 * 60_000, signal } = {}) {
    signal?.throwIfAborted();
    let result = await check();
    // A current browser session takes precedence over an older saved snapshot.
    if (!result.authenticated && config) {
      log('Restoring the saved Qwen session.');
      await restore();
      result = await check();
    }
    if (result.authenticated) {
      log('Existing session is authenticated.');
      await save();
      return;
    }
    if (!interactive) throw new Error('Qwen session is missing or expired. Run npx qlyx and use /session check to sign in.');
    log('Session is missing or expired. Complete Qwen sign-in in the existing browser.');
    await page.goto(`${origin}/auth`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.bringToFront();
    const deadline = Date.now() + timeout;
    let failure;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (closed || page.isClosed()) throw new Error('Qwen tab closed before authentication completed.');
      if (new URL(page.url()).origin === origin) {
        try {
          if ((await check()).authenticated) {
            await save();
            log('Qwen authentication succeeded.');
            return;
          }
        } catch (error) { failure = error; }
      }
      await page.waitForTimeout(3000);
    }
    throw new Error(`Sign-in timed out.${failure ? ` Last check: ${failure.message}` : ''}`);
  }

  // Verifies authentication with Node HTTP, outside Chromium. No redirects.
  async function verify({ request = fetch } = {}) {
    const url = `${origin}${authentication}`;
    const cookies = await context.cookies(url);
    const response = await request(url, {
      headers: { accept: 'application/json', cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ') },
      redirect: 'manual', signal: AbortSignal.timeout(20_000),
    });
    let body = null;
    try { body = await response.json(); } catch { /* Validated below. */ }
    return { ...classify({ status: response.status, body }), transport: 'fetch', headers: ['accept', 'cookie'] };
  }

  async function request(url, options = {}) {
    options.signal?.throwIfAborted();
    const headers = Object.fromEntries(Object.entries(options.headers || {}).filter(([key]) => !['cookie', 'origin', 'referer', 'host', 'content-length'].includes(key.toLowerCase())));
    const result = await page.evaluate(async ({ url, method, headers, body, timeout }) => {
      const response = await fetch(url, { method, headers, body, credentials: 'include', signal: AbortSignal.timeout(timeout) });
      return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
    }, { url: String(url), method: options.method || 'GET', headers, body: options.body, timeout: 120_000 });
    options.signal?.throwIfAborted();
    return new Response(result.body, { status: result.status, headers: result.headers });
  }

  try {
    if (!context) throw new Error('Existing browser has no accessible default context.');
    page = await context.newPage();
    page.on('request', (request) => {
      if (!request.url().startsWith(`${origin}/api/`)) return;
      for (const [key, value] of Object.entries(request.headers())) {
        if (allowed.has(key)) headers[key] = value;
      }
    });
    await observe(page);
    const response = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (!response?.ok()) throw new Error(`Qwen navigation failed: HTTP ${response?.status() ?? 'no response'}`);
  } catch (error) { await close(); throw error; }
  return { page, location, check, ensure, save, verify, request, close };
}

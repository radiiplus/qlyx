import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium } from 'playwright';
import { attach, classify, connect, discover, load, store, origin } from '../module/session.js';

async function directory(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'session-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return folder;
}
const empty = () => ({ schema: 1, origin, cookies: [], local: {}, tab: {} });

const executable = process.env.CHROME || '/opt/google/chrome/chrome';

async function fixture(t, location, { login = false, status } = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-'));
  const context = await chromium.launchPersistentContext(profile, { executablePath: executable, headless: true, args: ['--remote-debugging-port=0'] });
  t.after(async () => {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
  });
  const existing = context.pages()[0];
  await existing.goto('data:text/html,<h1>Existing tab</h1>');
  const endpoint = await discover(profile);
  const stats = { logins: 0, logs: [] };
  const session = await connect({
    location, endpoint, log: (line) => stats.logs.push(line),
    observe: async (page) => {
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/api/v1/auths/') {
          const cookie = (await route.request().allHeaders()).cookie ?? '';
          const authenticated = cookie.includes('session=valid');
          return route.fulfill({ status: status ?? (authenticated ? 200 : 401), json: authenticated ? { id: 'fixture' } : { detail: 'Unauthorized' } });
        }
        if (url.pathname === '/auth') {
          stats.logins++;
          return route.fulfill({ contentType: 'text/html', body: '<button onclick="document.cookie=\'session=valid; Path=/; Secure; SameSite=Lax\'; localStorage.setItem(\'local\',\'value\'); sessionStorage.setItem(\'tab\',\'value\'); location.href=\'/\'">Login</button>' });
        }
        return route.fulfill({ contentType: 'text/html', body: '<h1>Qwen fixture</h1>' });
      });
      if (login) page.on('domcontentloaded', () => {
        if (new URL(page.url()).pathname === '/auth') page.getByRole('button', { name: 'Login' }).click().catch(() => {});
      });
    },
  });
  t.after(() => session.close());
  return { session, stats, context, existing };
}

test('only 401 means unauthenticated; success requires a recognized identity', () => {
  assert.deepEqual(classify({ status: 401 }), { authenticated: false, status: 401 });
  assert.equal(classify({ status: 200, body: { id: 'fixture' } }).authenticated, true);
  assert.equal(classify({ status: 200, body: { success: true, data: { id: 'fixture' } } }).authenticated, true);
  for (const input of [{ status: 200 }, { status: 200, body: {} }, { status: 200, body: { success: false, data: { id: 'fixture' } } }, { status: 403 }, { status: 429 }, { status: 500 }, { status: 302 }]) assert.throws(() => classify(input));
});

test('config persists privately and rejects invalid data or unrelated cookies', async (t) => {
  const location = path.join(await directory(t), 'config', 'session.json');
  assert.equal(await load(location), null);
  await store(location, empty());
  assert.deepEqual(await load(location), empty());
  assert.equal((await fs.stat(location)).mode & 0o777, 0o600);
  await store(location, { ...empty(), saved: 'updated' });
  assert.equal((await load(location)).saved, 'updated');
  for (const text of ['{bad', 'null', JSON.stringify({ ...empty(), origin: 'https://example.com' }), JSON.stringify({ ...empty(), cookies: [{ domain: 'google.com' }] })]) {
    await fs.writeFile(location, text);
    await assert.rejects(load(location), /valid JSON|unsupported format/);
  }
});

test('discovery requires an explicitly enabled existing browser', async (t) => {
  const folder = await directory(t);
  await assert.rejects(discover(folder), /Enable remote debugging/);
  await fs.writeFile(path.join(folder, 'DevToolsActivePort'), '65536\n/devtools/browser/fixture\n');
  await assert.rejects(discover(folder), /Enable remote debugging/);
  await fs.writeFile(path.join(folder, 'DevToolsActivePort'), '9222\n/devtools/browser/fixture\n');
  assert.equal(await discover(folder), 'ws://127.0.0.1:9222/devtools/browser/fixture');
});

test('browser attachment retries a discovered websocket through its HTTP endpoint', async () => {
  const calls = [];
  const browser = {};
  const result = await attach('ws://127.0.0.1:9222/devtools/browser/fixture', async target => {
    calls.push(target);
    if (target.startsWith('ws:')) throw new Error('websocket initialization stalled');
    return browser;
  });
  assert.equal(result, browser);
  assert.deepEqual(calls, ['ws://127.0.0.1:9222/devtools/browser/fixture', 'http://127.0.0.1:9222']);
  await assert.rejects(attach('http://127.0.0.1:9222', async () => { throw new Error('closed'); }), /Could not attach.*remote debugging.*closed/);
});

test('login uses an attached browser; saves and restores session; disconnect preserves existing tabs', { timeout: 60000 }, async (t) => {
  const location = path.join(await directory(t), 'config', 'session.json');
  const first = await fixture(t, location, { login: true });
  await first.session.ensure({ timeout: 15000 });
  assert.equal(first.stats.logins, 1);
  const saved = await load(location);
  assert.equal(saved.cookies.find((cookie) => cookie.name === 'session').value, 'valid');
  assert.equal(saved.local.local, 'value');
  assert.equal(saved.tab.tab, 'value');
  await first.session.close();
  assert.equal(first.existing.isClosed(), false);
  assert.equal(await first.existing.title(), '');
  assert.equal(first.context.browser().isConnected(), true);

  const restored = await fixture(t, location);
  await restored.session.ensure({ interactive: false });
  assert.equal(restored.stats.logins, 0);
  assert.equal(await restored.session.page.evaluate(() => sessionStorage.getItem('tab')), 'value');
  const result = await restored.session.verify({ request: async (url, options) => {
    assert.equal(url, `${origin}/api/v1/auths/`);
    assert.equal(options.redirect, 'manual');
    assert.match(options.headers.cookie, /session=valid/);
    assert.deepEqual(Object.keys(options.headers).sort(), ['accept', 'cookie']);
    return new Response(JSON.stringify({ id: 'fixture' }), { status: 200 });
  } });
  assert.equal(result.authenticated, true);
  assert.ok(!restored.stats.logs.join('\n').includes('session=valid'));
});

test('expired session fails unattended; interactive login replaces it', { timeout: 60000 }, async (t) => {
  const location = path.join(await directory(t), 'config', 'session.json');
  const config = empty();
  config.cookies = [{ name: 'session', value: 'expired', domain: 'chat.qwen.ai', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' }];
  await store(location, config);
  const before = await fs.readFile(location, 'utf8');
  const { session, stats } = await fixture(t, location, { login: true });
  await assert.rejects(session.ensure({ interactive: false }), /missing or expired/);
  assert.equal(stats.logins, 0);
  assert.equal(await fs.readFile(location, 'utf8'), before);
  await session.ensure({ timeout: 15000 });
  assert.equal(stats.logins, 1);
  assert.equal((await load(location)).cookies[0].value, 'valid');
});

test('browser request reuses the attached page credentials', { timeout: 30000 }, async (t) => {
  const location = path.join(await directory(t), 'session.json');
  const { session } = await fixture(t, location, { login: true });
  await session.ensure({ timeout: 15000 });
  const response = await session.request(`${origin}/api/v1/auths/`, { headers: { accept: 'application/json', cookie: 'not-forwarded' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'fixture' });
});

test('403 does not open login; direct 401 and HTML challenges are not success', { timeout: 30000 }, async (t) => {
  const { session, stats } = await fixture(t, path.join(await directory(t), 'session.json'), { status: 403 });
  await assert.rejects(session.ensure(), /HTTP 403/);
  assert.equal(stats.logins, 0);
  const result = await session.verify({ request: async () => new Response('{}', { status: 401 }) });
  assert.equal(result.authenticated, false);
  await assert.rejects(session.verify({ request: async () => new Response('<html>Challenge</html>', { status: 200 }) }), /recognized user identity/);
});

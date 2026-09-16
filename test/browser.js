import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { chromium } from 'playwright';
import { browser } from '../module/browser.js';
import { discover } from '../module/session.js';

test('browser tools attach through debugging, interact, and preserve the original browser', { timeout: 20000 }, async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-'));
  const server = http.createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end('<title>Browser fixture</title><input placeholder="Name"><input type="password" placeholder="Password"><button onclick="document.querySelector(\'p\').textContent=\'Hello \'+document.querySelector(\'input\').value">Greet</button><p>Ready</p>'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROME || '/opt/google/chrome/chrome', headless: true, args: ['--remote-debugging-port=0'] });
  const existing = context.pages()[0];
  const tools = browser({ endpoint: await discover(profile) });
  try {
    const view = await tools.open({ url: `http://127.0.0.1:${server.address().port}` });
    assert.equal(view.title, 'Browser fixture');
    await tools.fill({ index: view.controls.find((node) => node.label === 'Name').index, text: 'Ada' });
    const current = await tools.view();
    const result = await tools.click({ index: current.controls.find((node) => node.label === 'Greet').index });
    assert.match(result.text, /Hello Ada/);
    await assert.rejects(tools.fill({ index: result.controls.find((node) => node.type === 'password').index, text: 'secret' }), /manually/);
    await tools.close();
    assert.equal(existing.isClosed(), false);
    assert.equal(context.browser().isConnected(), true);
  } finally {
    await tools.close();
    await context.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
});

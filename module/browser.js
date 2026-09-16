import { chromium } from 'playwright';
import { discover } from './session.js';

/** Controls one owned tab in an existing Chrome profile through remote debugging. */
export function browser({ endpoint = process.env.ENDPOINT, profile = process.env.PROFILE, attach = (endpoint) => chromium.connectOverCDP(endpoint, { timeout: 60000, noDefaults: true }) } = {}) {
  let connection;
  let page;
  let nodes = [];
  let closed = false;
  async function connect() {
    if (closed) throw new Error('Browser tools are closed.');
    if (page && !page.isClosed()) return;
    if (!connection) {
      connection = await attach(endpoint || await discover(profile));
      if (closed) { await connection.close(); throw new Error('Browser connection was cancelled.'); }
    }
    const context = connection.contexts()[0];
    if (!context) throw new Error('The existing browser has no accessible profile.');
    page = await context.newPage();
    if (closed) { await page.close(); throw new Error('Browser connection was cancelled.'); }
  }
  async function view() {
    if (!page || page.isClosed()) throw new Error('Open a URL first.');
    await Promise.allSettled(nodes.map((node) => node.dispose()));
    nodes = await page.locator('a, button, input, textarea, select, [role="button"], [contenteditable="true"]').elementHandles();
    const controls = [];
    for (let index = 0; index < Math.min(nodes.length, 100); index++) {
      const node = nodes[index];
      if (!await node.isVisible()) continue;
      const data = await node.evaluate((node) => ({ tag: node.tagName.toLowerCase(), type: node.getAttribute('type'), label: (node.getAttribute('aria-label') || node.textContent || node.getAttribute('placeholder') || '').trim().slice(0, 160) }));
      controls.push({ index, ...data });
    }
    return { url: page.url(), title: await page.title(), text: (await page.locator('body').innerText()).slice(0, 14000), controls };
  }
  async function open({ url }) {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
    await connect();
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return view();
  }
  function node(index) {
    if (!Number.isInteger(index) || !nodes[index]) throw new Error('Use an index from the latest browser view.');
    return nodes[index];
  }
  async function click({ index }) { await node(index).click({ timeout: 10000 }); return view(); }
  async function fill({ index, text }) {
    const target = node(index);
    if (await target.getAttribute('type') === 'password') throw new Error('Enter passwords manually in Chrome.');
    await target.fill(text, { timeout: 10000 });
    return view();
  }
  async function press({ index, key }) { await node(index).press(key, { timeout: 10000 }); return view(); }
  async function close() {
    closed = true;
    try { if (page && !page.isClosed()) await page.close(); }
    finally { await connection?.close(); connection = undefined; page = undefined; nodes = []; }
  }
  return { open, view, click, fill, press, close };
}

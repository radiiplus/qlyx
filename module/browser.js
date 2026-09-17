import { attach, discover } from './session.js';

/** Controls one owned tab in an existing Chrome profile through remote debugging. */
export function browser({ endpoint = process.env.ENDPOINT, profile = process.env.PROFILE, attach: dial = attach } = {}) {
  let connection;
  let page;
  let nodes = [];
  let closed = false;
  const selector = 'a, button, input, textarea, select, [role="button"], [contenteditable="true"]';
  async function connect() {
    if (closed) throw new Error('Browser tools are closed.');
    if (page && !page.isClosed()) return;
    if (!connection) {
      connection = await dial(endpoint || await discover(profile));
      if (closed) { await connection.close(); throw new Error('Browser connection was cancelled.'); }
    }
    const context = connection.contexts()[0];
    if (!context) throw new Error('The existing browser has no accessible profile.');
    page = await context.newPage();
    if (closed) { await page.close(); throw new Error('Browser connection was cancelled.'); }
  }
  async function view() {
    if (!page || page.isClosed()) throw new Error('Open a URL first.');
    await Promise.allSettled(nodes.map((node) => node.dispose?.()));
    if (connection.raw) {
      const result = await page.evaluate(({ selector }) => {
        const controls = [...document.querySelectorAll(selector)].slice(0, 100).map((node, index) => {
          const box = node.getBoundingClientRect(), style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || box.width === 0 || box.height === 0) return null;
          return { query: index, tag: node.tagName.toLowerCase(), type: node.getAttribute('type'), label: (node.getAttribute('aria-label') || node.textContent || node.getAttribute('placeholder') || '').trim().slice(0, 160) };
        }).filter(Boolean);
        return { title: document.title, text: (document.body?.innerText || '').slice(0, 14000), controls };
      }, { selector });
      nodes = result.controls.map(({ query }) => ({ index: query, raw: true }));
      return { url: page.url(), title: result.title, text: result.text, controls: result.controls.map(({ query, ...item }, index) => ({ index, ...item })) };
    }
    nodes = await page.locator(selector).elementHandles();
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
  async function act(index, action, value) {
    const target = node(index);
    if (!connection.raw) return target[action](value, { timeout: 10000 });
    return page.evaluate(({ selector, index, action, value }) => {
      const item = [...document.querySelectorAll(selector)].slice(0, 100)[index];
      if (!item) throw new Error('The selected browser control is no longer available.');
      item.focus();
      if (action === 'click') item.click();
      if (action === 'fill') {
        const setter = Object.getOwnPropertyDescriptor(item instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(item, value); else item.textContent = value;
        item.dispatchEvent(new Event('input', { bubbles: true }));
        item.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (action === 'press') {
        const event = { key: value, code: value === 'Enter' ? 'Enter' : value, bubbles: true, cancelable: true };
        item.dispatchEvent(new KeyboardEvent('keydown', event));
        item.dispatchEvent(new KeyboardEvent('keypress', event));
        item.dispatchEvent(new KeyboardEvent('keyup', event));
      }
    }, { selector, index: target.index, action, value });
  }
  async function click({ index }) { await act(index, 'click'); return view(); }
  async function fill({ index, text }) {
    const target = node(index);
    if (connection.raw) {
      const type = await page.evaluate(({ selector, index }) => [...document.querySelectorAll(selector)].slice(0, 100)[index]?.getAttribute('type'), { selector, index: target.index });
      if (type === 'password') throw new Error('Enter passwords manually in Chrome.');
      await act(index, 'fill', text);
    } else {
      if (await target.getAttribute('type') === 'password') throw new Error('Enter passwords manually in Chrome.');
      await target.fill(text, { timeout: 10000 });
    }
    return view();
  }
  async function press({ index, key }) { await act(index, 'press', key); return view(); }
  async function close() {
    closed = true;
    try { if (page && !page.isClosed()) await page.close(); }
    finally { await connection?.close(); connection = undefined; page = undefined; nodes = []; }
  }
  return { open, view, click, fill, press, close };
}

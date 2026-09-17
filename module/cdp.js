/** Minimal CDP adapter used when Playwright cannot initialize a busy browser. */
export async function open(endpoint, { timeout = 8000 } = {}) {
  const socket = new WebSocket(endpoint);
  const waits = new Map();
  const events = new Map();
  let count = 0;
  let closed = false;
  const timer = setTimeout(() => socket.close(), timeout);
  socket.onmessage = event => {
    const value = JSON.parse(event.data);
    if (value.id && waits.has(value.id)) {
      const wait = waits.get(value.id); waits.delete(value.id);
      value.error ? wait.reject(new Error(value.error.message || 'CDP command failed.')) : wait.resolve(value.result);
      return;
    }
    const list = events.get(value.method) || [];
    for (const handler of list) handler(value.params || {});
  };
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error('CDP socket could not be opened.'));
    setTimeout(() => reject(new Error('CDP socket connection timed out.')), timeout);
  });
  clearTimeout(timer);
  async function call(method, params = {}, session) {
    if (closed) throw new Error('CDP connection is closed.');
    const id = ++count;
    return new Promise((resolve, reject) => {
      waits.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
    });
  }
  function listen(method, handler) {
    events.set(method, [...(events.get(method) || []), handler]);
    return () => events.set(method, (events.get(method) || []).filter(item => item !== handler));
  }
  async function page() {
    const made = await call('Target.createTarget', { url: 'about:blank' });
    const target = await call('Target.attachToTarget', { targetId: made.targetId, flatten: true });
    return tab(made.targetId, target.sessionId);
  }
  async function close() {
    if (closed) return;
    closed = true;
    for (const wait of waits.values()) wait.reject(new Error('CDP connection closed.'));
    waits.clear();
    socket.close();
  }
  const targets = await call('Target.getTargets').then(value => value.targetInfos || []);
  function context() { return { newPage: page, cookies, addCookies: async value => call('Network.setCookies', { cookies: value }) }; }
  async function cookies(urls = []) {
    const list = (await call('Storage.getCookies')).cookies || [];
    if (!urls.length) return list;
    return list.filter(item => urls.some(value => {
      const url = new URL(value);
      const domain = item.domain.replace(/^\./, '');
      const host = url.hostname === domain || item.domain.startsWith('.') && url.hostname.endsWith(`.${domain}`);
      const scope = url.pathname === item.path || url.pathname.startsWith(`${item.path || '/'}`.replace(/\/$/, '') + '/');
      return host && scope && (!item.secure || url.protocol === 'https:');
    }));
  }
  return { raw: true, busy: targets.length > 20, contexts: () => [{ ...context(), newPage: page }], page, close };

  function tab(target, session) {
    let current = 'about:blank';
    let gone = false;
    listen('Page.frameNavigated', value => { if (value.frame?.parentId === undefined) current = value.frame.url; });
    void call('Page.enable', {}, session).catch(() => {});
    void call('Runtime.enable', {}, session).catch(() => {});
    async function evaluate(fn, arg) {
      const source = typeof fn === 'function' ? `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})` : String(fn);
      const value = await call('Runtime.evaluate', { expression: source, awaitPromise: true, returnByValue: true }, session);
      if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || 'Page evaluation failed.');
      return value.result?.value;
    }
    return {
      evaluate,
      url: () => current,
      async title() { return evaluate(() => document.title); },
      isClosed: () => gone,
      on: () => {},
      async goto(url) { current = url; await call('Page.navigate', { url }, session); return { ok: () => true }; },
      async reload() { await call('Page.reload', {}, session); },
      async bringToFront() { await call('Page.bringToFront', {}, session); },
      async waitForTimeout(time) { await new Promise(resolve => setTimeout(resolve, time)); },
      async close() { if (gone) return; gone = true; await call('Target.closeTarget', { targetId: target }); },
    };
  }
}

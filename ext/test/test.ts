import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { parse, type Mark } from '../src/parse.ts';
import {
  BrowserSessionManager,
  type BrowserJobEvent,
  type BrowserSessionJob,
} from '../src/browser-session.ts';
import {
  legacyOperationId,
  retryOperationId,
  retryTransportRequest,
  transportOperationId,
} from '../src/correlation.ts';
import {
  attributesDocument,
  DomFault,
  dumpDocument,
  elementLogicalPath,
  elementNodeId,
  elementPath,
  elementSemanticPath,
  expandDocument,
  findDocument,
  interactDocument,
  locateElement,
  readDocument,
  resolveSemanticPath,
  scrollDocument,
  snapshotDocument,
} from '../src/browse.ts';

const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8')) as {
  marks: Mark[];
  browser: {
    batch: number;
    jobs: number;
    events: number;
  };
  agent: {
    enabled: boolean;
    message: number;
    batch: number;
    prompt: string;
    start: string;
    end: string;
  };
  sites: Array<{
    host: string;
    reply: string[];
    input: string[];
    send: string[];
    stop: string[];
    busy: string[];
  }>;
};

test('parses every configured raw command delimiter', () => {
  const blocks = config.marks.flatMap((mark, index) => parse([
    mark.start,
    JSON.stringify({ id: `work-${index}`, path: `/tmp/${mark.action}` }),
    mark.end,
  ].join('\n'), config.marks));

  assert.deepEqual(blocks.map((block) => block.action), config.marks.map((mark) => mark.action));
  assert.deepEqual(blocks.map((block) => block.value?.id), config.marks.map((_, index) => `work-${index}`));
  assert.equal(blocks.every((block) => block.error === undefined), true);
});

test('keeps multiline edit regions intact', () => {
  const mark = config.marks.find((item) => item.action === 'edit') as Mark;
  const value = {
    id: 'change',
    path: '/tmp/code.ts',
    before: 'function old() {\n  return false;\n}',
    after: 'function next() {\n  return true;\n}',
  };
  const [block] = parse(`${mark.start}\n${JSON.stringify(value)}\n${mark.end}`, [mark]);

  assert.deepEqual(block?.value, value);
});

test('parses a batch as one operation with ordered children', () => {
  const mark = config.marks.find((item) => item.action === 'batch') as Mark;
  const value = {
    id: 'inspect',
    operations: [
      { id: 'tree', action: 'list', path: '.' },
      { id: 'tests', action: 'exec', words: ['npm', 'test'] },
    ],
  };
  const [block] = parse(`${mark.start}\n${JSON.stringify(value)}\n${mark.end}`, [mark]);

  assert.equal(block?.action, 'batch');
  assert.deepEqual(block?.value, value);
});

test('scopes private transport IDs to request content and recovers collisions without changing logical refs', () => {
  const first = transportOperationId(7, 'inspect-tree', 'batch:120:first', 'https://chatgpt.com/c/one');
  const duplicate = transportOperationId(7, 'inspect-tree', 'batch:120:first', 'https://chatgpt.com/c/one');
  const changed = transportOperationId(7, 'inspect-tree', 'batch:124:second', 'https://chatgpt.com/c/one');
  const legacy = legacyOperationId(7, 'inspect-tree', 'unused', 'https://chatgpt.com/c/one');
  const retry = retryOperationId(first, 'retry-token');

  assert.equal(duplicate, first);
  assert.notEqual(changed, first);
  assert.notEqual(retry, first);
  assert.match(first, /^7:[a-f0-9]{8}:[a-f0-9]{8}:inspect-tree$/);
  assert.match(legacy, /^7:[a-f0-9]{8}:inspect-tree$/);
  assert.equal([first, changed, retry].every((id) => id.length <= 200), true);
  assert.equal(transportOperationId(7, 'x'.repeat(300), 'long', 'chat').length, 200);

  const request = {
    id: first,
    action: 'batch',
    operations: [
      { id: changed, action: 'read', path: '.agent/context.md' },
      { id: retry, action: 'list', path: '.' },
    ],
  };
  const remapped = retryTransportRequest(request, [first, changed, retry], 'fresh-attempt');
  assert.notEqual(remapped.work.id, request.id);
  assert.deepEqual(
    (remapped.work.operations as Array<Record<string, unknown>>).map(({ id: _id, ...operation }) => operation),
    request.operations.map(({ id: _id, ...operation }) => operation),
  );
  assert.equal((remapped.work.operations as Array<Record<string, unknown>>)
    .every((operation, index) => operation.id !== request.operations[index]?.id), true);
});

test('waits for a complete streamed block', () => {
  const mark = config.marks[0] as Mark;
  assert.deepEqual(parse(`${mark.start}\n{"id":"stream-1","path":"/tmp"}`, [mark]), []);
  assert.equal(parse(`${mark.start}\n{"id":"stream-1","path":"/tmp"}\n${mark.end}`, [mark]).length, 1);
});

test('accepts rendered JSON labels and reports invalid or oversized payloads', () => {
  const mark = config.marks[0] as Mark;
  const valid = parse(`${mark.start}\njson\n{"id":"valid-1","path":"/tmp"}\n${mark.end}`, [mark]);
  const invalid = parse(`${mark.start}\nnot json\n${mark.end}`, [mark]);
  const large = parse(`${mark.start}\n{"id":"large-1","path":"/tmp"}\n${mark.end}`, [mark], 2);

  assert.equal(valid[0]?.value?.path, '/tmp');
  assert.match(invalid[0]?.error || '', /Unexpected token/);
  assert.match(large[0]?.error || '', /exceeds 2 bytes/);
});

test('ignores unrelated command-like text and accepts compact raw delimiters', () => {
  const mark = config.marks[0] as Mark;
  const unrelated = `qlyx:${mark.action}:ignored\n{"id":"ignored","path":"/tmp"}\nqlyx:${mark.action}:end`;
  const compact = `${mark.start}{"id":"compact-1","path":"/tmp"}${mark.end}`;

  assert.deepEqual(parse(unrelated, [mark]), []);
  assert.equal(parse(compact, [mark])[0]?.value?.id, 'compact-1');
});

test('configures autonomous controls for every AI host', () => {
  assert.equal(config.agent.enabled, true);
  assert.notEqual(config.agent.start, config.agent.end);
  assert.equal(config.agent.start, '@@qlyx:result');
  assert.equal(config.agent.end, '@@qlyx:end:result');
  assert.match(config.agent.prompt, /\.agent\/context\.md/);
  assert.match(config.agent.prompt, /autonomy_update/);
  assert.match(config.agent.prompt, /Observe -> Reason -> Act -> Verify -> Persist -> Continue/);
  assert.match(config.agent.prompt, /successful browser_start only accepts asynchronous work/);
  assert.match(config.agent.prompt, /browser_event/);
  assert.equal(config.agent.message, 16384);
  assert.equal(config.agent.batch, 10);
  assert.equal(config.sites.some((site) => site.host === 'kimi.ai'), true);
  assert.equal(config.marks.some((mark) => mark.action === 'cancel'), true);
  assert.deepEqual(
    config.marks.filter((mark) => mark.action.startsWith('browser_')).map((mark) => mark.action),
    [
      'browser_open',
      'browser_close',
      'browser_tabs',
      'browser_focus',
      'browser_navigate',
      'browser_back',
      'browser_forward',
      'browser_inspect',
      'browser_expand',
      'browser_click',
      'browser_type',
      'browser_scroll',
      'browser_extract',
      'browser_attributes',
      'browser_evidence',
      'browser_start',
      'browser_status',
      'browser_cancel',
      'browser_snapshot',
      'browser_find',
      'browser_read',
      'browser_interact',
      'browser_dump',
      'browser_batch',
    ],
  );
  assert.deepEqual(
    config.marks.filter((mark) => mark.action.startsWith('autonomy_')).map((mark) => mark.action),
    ['autonomy_state', 'autonomy_update', 'autonomy_event'],
  );
  assert.deepEqual(
    config.marks.filter((mark) => mark.action.startsWith('agent_')).map((mark) => mark.action),
    ['agent_list', 'agent_send', 'agent_batch'],
  );
  for (const site of config.sites) {
    assert.equal(site.reply.length > 0, true, `${site.host} has no reply selector`);
    assert.equal(site.input.length > 0, true, `${site.host} has no input selector`);
    assert.equal(site.send.length > 0, true, `${site.host} has no send selector`);
    assert.equal(site.stop.length > 0, true, `${site.host} has no stop selector`);
    assert.equal(site.busy.length > 0, true, `${site.host} has no busy selector`);
  }
  const gemini = config.sites.find((site) => site.host === 'gemini.google.com');
  const kimi = config.sites.find((site) => site.host === 'www.kimi.com');
  assert.equal(gemini?.input[0], "rich-textarea .ql-editor[contenteditable='true']");
  assert.equal(kimi?.input[0], ".chat-input-editor[contenteditable='true']");
  assert.equal(kimi?.send[0], '.send-button-container');
  for (const item of config.sites.filter((site) => site.host.includes('kimi'))) {
    assert.equal(item.reply.includes("[class*='segment-assistant' i]"), true, `${item.host} lacks the Kimi response selector`);
  }
});

test('returns a collapsed semantic page map and expands bounded subtrees', () => {
  const dom = new JSDOM([
    '<!doctype html><html><head><title>Inspector</title><script>privateDomValue()</script></head>',
    '<body><div class="decorative"><main id="content"><section aria-label="News"><article><h1>Headline</h1>',
    '<p>Full article body.</p></article></section><nav><a href="/next">Next</a></nav></main></div></body></html>',
  ].join(''), { url: 'https://example.test/start' });
  const document = dom.window.document;
  const snapshot = snapshotDocument(document, 80, 2) as {
    map: { path: string; domPath: string; children?: Array<{ tag: string; childCount: number; path: string; children?: unknown }> };
    returned: number;
  };

  assert.equal(snapshot.map.path, 'Document');
  assert.equal(snapshot.map.domPath, '/html[1]');
  assert.deepEqual(snapshot.map.children?.map((item) => item.tag), ['body']);
  assert.deepEqual(snapshot.map.children?.[0]?.children && (snapshot.map.children[0].children as Array<{ tag: string }>).map((item) => item.tag), ['main']);
  assert.equal((snapshot.map.children?.[0]?.children as Array<{ path: string }> | undefined)?.[0]?.path, 'Main');
  assert.equal(snapshot.returned, 3);
  assert.doesNotMatch(JSON.stringify(snapshot), /privateDomValue/);

  const main = document.querySelector('main') as Element;
  const mainView = expandDocument(document, { nodeId: elementNodeId(main) }, 80, 1) as {
    map: { children?: Array<{ tag: string; childCount: number }> };
  };
  assert.deepEqual(mainView.map.children?.map((item) => item.tag), ['section', 'nav']);
  assert.equal(mainView.map.children?.[0]?.childCount, 1);

  const bounded = snapshotDocument(document, 3, 6) as { returned: number; truncated: boolean; omitted: number };
  assert.equal(bounded.returned, 3);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.omitted > 0, true);

  const paragraph = document.querySelector('p') as Element;
  const read = readDocument(document, {
    path: elementPath(paragraph),
    format: 'text',
    offset: 5,
    limit: 7,
  }) as { content: string; page: { next: number | null } };
  assert.equal(read.content, 'article');
  assert.equal(read.page.next, 12);
});

test('looks up accessible names and fails gracefully when a target is ambiguous', () => {
  const dom = new JSDOM([
    '<!doctype html><html><body><main>',
    '<label for="email">Email address</label><input id="email" type="email">',
    '<span id="save-label">Save changes</span>',
    '<button aria-labelledby="save-label">First</button><button aria-label="Save changes">Second</button>',
    '</main></body></html>',
  ].join(''), { url: 'https://example.test/form' });
  const document = dom.window.document;
  const input = document.querySelector('#email') as Element;
  const found = findDocument(document, { role: 'textbox', name: 'Email address', exact: true }) as {
    match: { nodeId: string; logicalPath: string; name: string };
  };

  assert.equal(found.match.nodeId, elementNodeId(input));
  assert.equal(found.match.logicalPath, elementLogicalPath(input));
  assert.equal(found.match.name, 'Email address');
  assert.equal(locateElement(document, { nodeId: found.match.nodeId }), input);
  assert.equal(locateElement(document, { logicalPath: found.match.logicalPath }), input);
  assert.throws(
    () => findDocument(document, { role: 'button', name: 'Save changes', exact: true }),
    (error) => error instanceof DomFault
      && error.code === 'AMBIGUOUS'
      && (error.details as { total?: number }).total === 2,
  );
  assert.throws(
    () => locateElement(document, { selector: 'button' }),
    (error) => error instanceof DomFault && error.code === 'AMBIGUOUS',
  );
  const all = findDocument(document, { role: 'button', name: 'Save changes', exact: true, all: true, limit: 1 }) as {
    matches: Array<{ role?: string; name?: string }>;
    total: number;
    omitted: number;
    ambiguous: boolean;
  };
  assert.equal(all.matches.length, 1);
  assert.equal(all.matches[0]?.role, 'button');
  assert.equal(all.total, 2);
  assert.equal(all.omitted, 1);
  assert.equal(all.ambiguous, true);
});

test('resolves semantic paths through named structure without choosing uncertain targets', () => {
  const dom = new JSDOM([
    '<!doctype html><html><body><main>',
    '<section><h2>Contract</h2><form>',
    '<label for="source">Source Code</label>',
    '<textarea id="source" data-testid="source-editor"></textarea>',
    '<button>Compile</button>',
    '</form></section>',
    '</main></body></html>',
  ].join(''), { url: 'https://example.test/contracts' });
  const document = dom.window.document;
  const source = document.querySelector('#source') as Element;

  assert.equal(elementSemanticPath(source), 'Main/Contract/Source Code');
  assert.equal(resolveSemanticPath(document, 'Main/Contract/Source Code'), source);
  assert.equal(locateElement(document, { path: 'Main/Contract/source-editor' }), source);
  assert.equal(locateElement(document, { semanticPath: '/Main/Contract/Source Code/' }), source);
  assert.equal(resolveSemanticPath(document, 'Main/Contract/Compile'), document.querySelector('button'));
  assert.throws(
    () => resolveSemanticPath(document, 'Main/Contract/Generated Code'),
    (error) => error instanceof DomFault
      && error.code === 'NOT_FOUND'
      && (error.details as { segment?: string }).segment === 'Generated Code',
  );
  assert.equal(config.browser.jobs, 40);
  assert.equal(config.browser.events, 200);
});

test('runs asynchronous browser jobs concurrently across pages and serially within each page', async () => {
  const intervals = new Map<string, { started: number; completed: number }>();
  const emitted: Array<{ event: BrowserJobEvent; result?: object }> = [];
  let active = 0;
  let maximum = 0;
  let persisted = 0;
  let manager: BrowserSessionManager;
  manager = new BrowserSessionManager({
    actions: new Set(['browser_navigate', 'browser_extract']),
    maxJobs: 10,
    maxOperations: 10,
    maxEvents: 100,
    execute: async (_job, operation) => {
      active += 1;
      maximum = Math.max(maximum, active);
      const current = { started: Date.now(), completed: 0 };
      intervals.set(operation.id, current);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      current.completed = Date.now();
      active -= 1;
      return { content: `transient-${operation.id}` };
    },
    persist: async () => { persisted += 1; },
    emit: async (_job, event, result) => { emitted.push({ event, result }); },
  });
  await manager.create({
    key: 'scope:research',
    scope: 'scope',
    job: 'research',
    owner: 7,
    session: 'chat',
    workspace: 'workspace',
    ref: 'research-start',
    operations: [
      { id: 'a-nav', action: 'browser_navigate', page: 'a', url: 'https://a.example/' },
      { id: 'a-read', action: 'browser_extract', page: 'a', path: 'Main' },
      { id: 'b-nav', action: 'browser_navigate', page: 'b', url: 'https://b.example/' },
      { id: 'b-read', action: 'browser_extract', page: 'b', path: 'Main' },
    ],
  });
  await manager.run('scope:research');

  const status = manager.status('scope:research');
  assert.equal(status.status, 'completed');
  assert.equal(status.counts.completed, 4);
  const trace = manager.trace('scope', 3);
  assert.equal(trace.length, 1);
  assert.equal(trace[0]?.events.length, 3);
  assert.equal(trace[0]?.page.total, 10);
  assert.equal(trace[0]?.events.at(-1)?.type, 'job.completed');
  assert.equal(maximum, 2);
  assert.ok((intervals.get('a-read')?.started || 0) >= (intervals.get('a-nav')?.completed || Infinity));
  assert.ok((intervals.get('b-read')?.started || 0) >= (intervals.get('b-nav')?.completed || Infinity));
  assert.equal(emitted.filter((item) => item.event.type === 'operation.completed').length, 4);
  assert.equal(emitted.some((item) => item.event.type === 'job.completed'), true);
  assert.match(JSON.stringify(emitted), /transient-a-read/);
  assert.doesNotMatch(JSON.stringify(manager.snapshot()), /transient-a-read/);
  assert.ok(persisted >= 6);
});

test('reports asynchronous browser failures and cancels running work', async () => {
  const emitted: BrowserJobEvent[] = [];
  let manager: BrowserSessionManager;
  manager = new BrowserSessionManager({
    actions: new Set(['browser_extract']),
    maxJobs: 10,
    maxOperations: 10,
    maxEvents: 100,
    execute: async (_job, operation, signal) => {
      if (operation.id === 'fail') throw Object.assign(new Error('Extraction failed.'), { code: 'EXTRACT' });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 200);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        }, { once: true });
      });
      return { content: 'late' };
    },
    persist: async () => undefined,
    emit: async (_job: BrowserSessionJob, event) => { emitted.push(event); },
  });
  await manager.create({
    key: 'scope:failures',
    scope: 'scope',
    job: 'failures',
    owner: 7,
    session: 'chat',
    workspace: 'workspace',
    ref: 'failures-start',
    operations: [
      { id: 'fail', action: 'browser_extract', page: 'a', path: 'Main' },
      { id: 'slow', action: 'browser_extract', page: 'b', path: 'Main' },
    ],
  });
  const running = manager.run('scope:failures');
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  const cancellation = await manager.cancel('scope:failures', 'slow');
  assert.equal(cancellation.operations.find((operation) => operation.id === 'slow')?.status, 'cancelled');
  await running;

  const status = manager.status('scope:failures');
  assert.equal(status.status, 'failed');
  assert.equal(status.operations.find((operation) => operation.id === 'fail')?.error?.code, 'EXTRACT');
  assert.equal(status.operations.find((operation) => operation.id === 'slow')?.status, 'cancelled');
  assert.equal(emitted.some((event) => event.type === 'operation.failed'), true);
  assert.equal(emitted.some((event) => event.type === 'operation.cancelled'), true);
  assert.equal(emitted.some((event) => event.type === 'job.failed'), true);
});

test('restores interrupted browser work as an explicit failure without replaying it', async () => {
  let executions = 0;
  const options = {
    actions: new Set(['browser_extract']),
    maxJobs: 10,
    maxOperations: 10,
    maxEvents: 100,
    execute: async () => {
      executions += 1;
      return { content: 'unexpected' };
    },
    persist: async () => undefined,
    emit: async () => undefined,
  };
  const original = new BrowserSessionManager(options);
  await original.create({
    key: 'scope:interrupted',
    scope: 'scope',
    job: 'interrupted',
    owner: 7,
    session: 'chat',
    workspace: 'workspace',
    ref: 'interrupted-start',
    operations: [{ id: 'read', action: 'browser_extract', page: 'docs', path: 'Main' }],
  });

  const restored = new BrowserSessionManager(options);
  assert.equal(restored.restore(original.snapshot()), true);
  const status = restored.status('scope:interrupted');
  assert.equal(status.status, 'failed');
  assert.equal(status.operations[0]?.error?.code, 'INTERRUPTED');
  assert.equal(status.events.some((event) => event.type === 'job.failed'), true);
  assert.equal(executions, 0);
});

test('uses the complete semantic hierarchy and returns AMBIGUOUS_PATH only when the final target remains uncertain', () => {
  const dom = new JSDOM([
    '<!doctype html><html><body><main>',
    '<section><h2>Contract</h2><label for="first">Source Code</label><textarea id="first"></textarea><button>Deploy</button></section>',
    '<section><h2>Contract</h2><label for="second">Target Branch</label><input id="second"></section>',
    '</main></body></html>',
  ].join(''), { url: 'https://example.test/duplicates' });
  const document = dom.window.document;
  const first = document.querySelector('#first') as Element;
  const second = document.querySelector('#second') as Element;

  assert.equal(resolveSemanticPath(document, 'Main/Contract/Source Code'), first);
  assert.equal(resolveSemanticPath(document, 'Main/Contract/Target Branch'), second);
  assert.equal(resolveSemanticPath(document, 'Main/Contract[2]/Target Branch'), second);

  const duplicate = document.createElement('textarea');
  duplicate.setAttribute('aria-label', 'Source Code');
  document.querySelectorAll('section')[1]?.append(duplicate);
  assert.throws(
    () => resolveSemanticPath(document, 'Main/Contract/Source Code'),
    (error) => error instanceof DomFault
      && error.code === 'AMBIGUOUS_PATH'
      && (error.details as { total?: number }).total === 2,
  );
});

test('interacts only with unique elements and collapses document-wide HTML into a page map', () => {
  const dom = new JSDOM([
    '<!doctype html><html><body><form>',
    '<label for="name">Display name</label><input id="name">',
    '<label><input id="updates" type="checkbox"> Product updates</label>',
    '<select aria-label="Theme"><option value="light">Light</option><option value="dark">Dark</option></select>',
    '</form></body></html>',
  ].join(''), { url: 'https://example.test/settings' });
  const document = dom.window.document;
  const input = document.querySelector('#name') as HTMLInputElement;
  let changes = 0;
  input.addEventListener('change', () => { changes += 1; });

  interactDocument(document, { role: 'textbox', name: 'Display name', operation: 'fill', value: 'Ada' });
  interactDocument(document, { role: 'textbox', name: 'Display name', operation: 'type', text: ' Lovelace', replace: false });
  interactDocument(document, { nodeId: elementNodeId(document.querySelector('#updates') as Element), operation: 'check' });
  interactDocument(document, { role: 'combobox', name: 'Theme', operation: 'select', value: 'dark' });
  assert.equal(input.value, 'Ada Lovelace');
  assert.equal(changes, 2);
  assert.equal((document.querySelector('#updates') as HTMLInputElement).checked, true);
  assert.equal((document.querySelector('select') as HTMLSelectElement).value, 'dark');
  const attributes = attributesDocument(document, { path: 'Display Name' }) as {
    attributes: Record<string, string>;
  };
  assert.equal(attributes.attributes.id, 'name');
  const subtree = readDocument(document, {
    nodeId: elementNodeId(input),
    format: 'html',
  }) as { format: string; content: string };
  assert.equal(subtree.format, 'html');
  assert.match(subtree.content, /^<input/);

  const collapsed = readDocument(document, {
    path: '/html[1]',
    format: 'html',
    depth: 1,
    nodes: 20,
  }) as {
    format: string;
    requestedFormat: string;
    collapsed: boolean;
    map: { path: string; children?: Array<{ tag: string }> };
    next: string;
  };
  assert.equal(collapsed.format, 'page-map');
  assert.equal(collapsed.requestedFormat, 'html');
  assert.equal(collapsed.collapsed, true);
  assert.equal(collapsed.map.path, 'Document');
  assert.deepEqual(collapsed.map.children?.map((item) => item.tag), ['body']);
  assert.match(collapsed.next, /browser_expand/);
  assert.equal('content' in collapsed, false);
});

test('scrolls a semantic target or viewport without returning page content', () => {
  const dom = new JSDOM('<!doctype html><html><body><main><section aria-label="Results"><p>Item</p></section></main></body></html>', {
    url: 'https://example.test/scroll',
  });
  const document = dom.window.document;
  const section = document.querySelector('section') as Element;
  let intoView: ScrollIntoViewOptions | undefined;
  Object.defineProperty(section, 'scrollIntoView', {
    configurable: true,
    value: (options: ScrollIntoViewOptions) => { intoView = options; },
  });
  const elementResult = scrollDocument(document, { path: 'Main/Results', block: 'end' }) as {
    scroll: { mode: string };
    node: { path: string };
  };
  assert.equal(elementResult.scroll.mode, 'element');
  assert.equal(elementResult.node.path, 'Main/Results');
  assert.equal(intoView?.block, 'end');

  let scrolled: ScrollToOptions | undefined;
  Object.defineProperty(dom.window, 'scrollBy', {
    configurable: true,
    value: (options: ScrollToOptions) => { scrolled = options; },
  });
  const viewportResult = scrollDocument(document, { x: 25, y: 400 }) as {
    scroll: { mode: string; requested: { x: number; y: number } };
  };
  assert.equal(viewportResult.scroll.mode, 'viewport');
  assert.deepEqual(viewportResult.scroll.requested, { x: 25, y: 400 });
  assert.equal(scrolled?.left, 25);
  assert.equal(scrolled?.top, 400);
  assert.equal('content' in viewportResult, false);
});

test('serializes an exact DOM path for archiving and rejects oversized dumps', () => {
  const dom = new JSDOM('<!doctype html><html><body><article data-id="7"><p>Saved later</p></article></body></html>', {
    url: 'https://example.test/archive',
  });
  const document = dom.window.document;
  const article = document.querySelector('article') as Element;
  const archived = dumpDocument(document, { path: elementPath(article), format: 'html', max: 1024 }) as {
    content: string;
    bytes: number;
  };
  assert.match(archived.content, /<article data-id="7">/);
  assert.equal(archived.bytes > 0, true);
  assert.throws(
    () => dumpDocument(document, { path: '/html[1]', format: 'html', max: 8 }),
    (error) => error instanceof DomFault && error.code === 'SIZE',
  );
});

test('declares distinct compact popup and persistent sidebar control surfaces', async () => {
  const [manifestText, popup, styles, sidePanel, sidePanelStyles, popupSource, sidePanelSource, ui, worker, watch, browse, build] = await Promise.all([
    readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
    readFile(new URL('../popup.html', import.meta.url), 'utf8'),
    readFile(new URL('../popup.css', import.meta.url), 'utf8'),
    readFile(new URL('../sidepanel.html', import.meta.url), 'utf8'),
    readFile(new URL('../sidepanel.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/popup.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/sidepanel.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/worker.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/watch.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/browse.ts', import.meta.url), 'utf8'),
    readFile(new URL('../build.mjs', import.meta.url), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText) as {
    action?: { default_popup?: string };
    commands?: Record<string, { suggested_key?: { default?: string } }>;
    content_security_policy?: { extension_pages?: string };
    host_permissions?: string[];
    permissions?: string[];
    side_panel?: { default_path?: string };
    version?: string;
  };

  assert.equal(manifest.version, '1.9.5');
  assert.equal(manifest.action?.default_popup, 'popup.html');
  assert.equal(manifest.permissions?.includes('scripting'), true);
  assert.equal(manifest.permissions?.includes('sidePanel'), true);
  assert.equal(manifest.permissions?.includes('tabs'), true);
  assert.equal(manifest.host_permissions?.includes('<all_urls>'), true);
  assert.equal(manifest.side_panel?.default_path, 'sidepanel.html');
  assert.equal(manifest.commands?.['continue-session']?.suggested_key?.default, 'Alt+Shift+C');
  assert.match(manifest.content_security_policy?.extension_pages || '', /style-src 'self'/);
  assert.doesNotMatch(manifest.content_security_policy?.extension_pages || '', /cdn\./);
  assert.match(popup, /href="popup\.css"/);
  assert.match(popup, /dist\/popup\.js/);
  assert.match(popup, /Local access disabled/);
  assert.doesNotMatch(popup, /<(textarea|input)\b/);
  assert.match(popup, /id="continue-session"/);
  assert.match(sidePanel, /dist\/sidepanel\.js/);
  assert.doesNotMatch(sidePanel, /<iframe\b/);
  assert.doesNotMatch(sidePanelStyles, /body > iframe/);
  assert.match(styles, /width: 344px/);
  assert.match(styles, /height: 560px/);
  assert.match(styles, /--green: #45d483/);
  assert.match(styles, /--blue: #6f8cff/);
  assert.match(styles, /--amber: #e6b85c/);
  assert.match(styles, /--red: #ff6673/);
  assert.match(worker, /chrome\.scripting\.executeScript/);
  assert.match(worker, /files: \['dist\/watch\.js'\]/);
  assert.match(worker, /socket\.reconnect\.scheduled/);
  assert.match(worker, /monitor\.resynced/);
  assert.match(worker, /reason: 'bridge-reconnected'/);
  assert.match(worker, /const delivery = 'prompt'/);
  assert.match(worker, /'setup\.sent'/);
  assert.match(watch, /function documentRoots/);
  assert.match(watch, /segment-assistant/);
  assert.match(browse, /function elementPath/);
  assert.match(browse, /function expandDocument/);
  assert.match(browse, /Selected DOM content is/);
  for (const id of [
    'extension-version',
    'readiness',
    'readiness-label',
    'server-latency',
    'provider-mark',
    'provider-name',
    'conversation-state',
    'monitor-toggle',
    'monitor-state',
    'access-notice',
    'execution-control',
    'execution-control-label',
    'execution-queue-count',
    'response-control',
    'response-control-label',
    'response-queue-count',
    'primary-action',
    'continue-session',
    'error-message',
    'running-count',
    'pending-count',
    'response-count',
    'failed-count',
    'current-operation',
    'open-panel-icon',
    'open-panel',
  ]) {
    assert.match(popup, new RegExp(`id="${id}"`));
  }
  assert.match(popupSource, /chrome\.sidePanel\.open\(\{ windowId \}\)/);
  assert.match(popupSource, /WINDOW_ID_CURRENT/);
  assert.doesNotMatch(popupSource, /chrome\.tabs\.query/);
  assert.match(popupSource, /\[Qlyx sidebar\]/);
  assert.match(popupSource, /open succeeded/);
  assert.match(popupSource, /kind: 'ui:log'/);
  assert.match(popupSource, /popup:toggle-execution/);
  assert.match(popupSource, /popup:toggle-responses/);
  assert.match(popupSource, /createIcons/);
  assert.match(popupSource, /message\.kind === 'metrics:changed'/);

  const panelDocument = new JSDOM(sidePanel).window.document;
  const nav = [...panelDocument.querySelectorAll<HTMLButtonElement>('.rail-button')];
  assert.deepEqual(nav.map((button) => button.id), [
    'nav-control',
    'nav-activity',
    'nav-browser',
    'nav-diagnostics',
    'nav-session',
    'nav-settings',
  ]);
  assert.equal(nav.every((button) => Boolean(button.getAttribute('aria-label'))), true);
  assert.equal(panelDocument.querySelectorAll('.view').length, 6);
  assert.equal(panelDocument.querySelectorAll('[data-lucide]').length > 20, true);
  const registeredIcons = (source: string): Set<string> => {
    const block = source.match(/const icons = \{([\s\S]*?)\};/)?.[1] || '';
    return new Set([...block.matchAll(/\b([A-Z][A-Za-z0-9]*)\b/g)].map((match) => match[1] as string));
  };
  const iconComponent = (name: string): string => name.replace(
    /(\w)(\w*)(_|-|\s*)/g,
    (_all, first: string, rest: string) => `${first.toUpperCase()}${rest.toLowerCase()}`,
  );
  const missingIcons = (document: Document, source: string): string[] => {
    const registered = registeredIcons(source);
    return [...new Set([...document.querySelectorAll<HTMLElement>('[data-lucide]')]
      .map((node) => node.dataset.lucide || '')
      .filter((name) => name && !registered.has(iconComponent(name))))].sort();
  };
  assert.deepEqual(missingIcons(panelDocument, sidePanelSource), []);
  assert.deepEqual(missingIcons(new JSDOM(popup).window.document, popupSource), []);
  assert.match(sidePanel, /id="persistent-safety"/);
  assert.match(sidePanel, /id="activity-feed"/);
  assert.match(sidePanel, /id="browser-tab-list"/);
  assert.match(sidePanel, /id="browser-job-list"/);
  assert.match(sidePanel, /id="browser-badge"/);
  assert.match(sidePanel, /id="diagnostic-logs"/);
  assert.match(sidePanel, /id="session-warning"/);
  assert.match(sidePanel, /id="session-setup"/);
  assert.match(sidePanel, /id="session-setup-note"/);
  assert.match(sidePanel, /id="session-mode"/);
  assert.match(sidePanel, /id="session-mode-description"/);
  assert.doesNotMatch(sidePanel, /id="session-scenario"/);
  assert.match(sidePanel, /id="session-personal"/);
  assert.match(sidePanel, /id="session-workspace"/);
  assert.match(sidePanel, /id="session-workspace-root"/);
  assert.match(sidePanel, /id="session-workspace-stop"/);
  assert.match(sidePanel, /id="execution-control"/);
  assert.match(sidePanel, /id="response-control"/);
  assert.match(sidePanel, /id="pending-response-list"/);
  assert.match(sidePanel, /data-activity-filter="pending"/);
  assert.match(sidePanel, /id="metric-responses"/);
  assert.match(sidePanel, /class="advanced-settings"/);
  assert.match(sidePanelStyles, /\.icon-rail/);
  assert.match(sidePanelStyles, /backdrop-filter: blur\(18px\)/);
  assert.match(sidePanelStyles, /overflow-x/);
  assert.match(sidePanelStyles, /\.browser-tab-row/);
  assert.match(sidePanelStyles, /\.browser-event-row/);
  assert.match(sidePanelSource, /writePreferences/);
  assert.match(sidePanelSource, /preferences\.autoFollow/);
  assert.match(sidePanelSource, /expandedOperations/);
  assert.match(sidePanelSource, /popup:clear-logs/);
  assert.match(sidePanelSource, /session-setup.+popup:setup/);
  assert.match(sidePanelSource, /promptRequest/);
  assert.match(sidePanelSource, /popup:set-prompts/);
  assert.match(sidePanelSource, /popup:prompts/);
  assert.match(sidePanelSource, /popup:set-workspace/);
  assert.match(sidePanelSource, /popup:stop-workspace/);
  assert.match(sidePanelSource, /popup:toggle-execution/);
  assert.match(sidePanelSource, /popup:toggle-responses/);
  assert.match(sidePanelSource, /renderPendingResponses/);
  assert.match(sidePanelSource, /renderBrowser/);
  assert.match(sidePanelSource, /expandedBrowserJobs/);
  assert.match(sidePanelSource, /next\.pendingExecutions/);
  assert.match(sidePanelSource, /createIcons/);
  assert.match(sidePanelSource, /log-message/);
  assert.match(build, /src\/sidepanel\.ts/);
  assert.match(build, /src\/browse\.ts/);
  assert.match(ui, /state\.server === 'offline'/);
  assert.match(ui, /!state\.prepared/);
  assert.match(ui, /workspace\.active/);
  assert.match(ui, /No active workspace/);
  assert.match(ui, /kind: 'popup:setup'/);
  assert.match(worker, /processedCommands/);
  assert.match(worker, /preparedTabs/);
  assert.match(worker, /executionPaused/);
  assert.match(worker, /responsePaused/);
  assert.doesNotMatch(worker, /selectedScenario/);
  assert.match(worker, /personalContext/);
  assert.match(worker, /refreshPromptCatalog/);
  assert.match(worker, /scenario: 'adaptive'/);
  assert.match(worker, /personal: personalContext/);
  assert.match(worker, /workspaceBindings/);
  assert.match(worker, /workspaceBindings: \[\.\.\.workspaceBindings\]/);
  assert.match(worker, /applyWorkspaceCatalog/);
  assert.match(worker, /kind: 'workspace\.list'/);
  assert.match(worker, /message\.kind === 'popup:set-workspace'/);
  assert.match(worker, /message\.kind === 'popup:stop-workspace'/);
  assert.match(worker, /model:[\s\S]+workspace,/);
  assert.match(worker, /Reply workspace [\s\S]+does not match pending/);
  assert.match(worker, /queuedExecutions/);
  assert.match(worker, /pendingExecutions/);
  assert.match(worker, /claimedOperations/);
  assert.match(worker, /operationClaims/);
  assert.doesNotMatch(worker, /correlation\.conflict/);
  assert.match(worker, /correlation\.rejected/);
  assert.match(worker, /replyError\?\.code === 'ID' && entry\.retries === 0/);
  assert.match(worker, /retryIdCollision/);
  assert.match(worker, /retryTransportRequest/);
  assert.match(worker, /operation\.id\.recovered/);
  assert.match(worker, /reply\.duplicate/);
  assert.match(worker, /action === 'status' \|\| action === 'cancel'/);
  assert.match(worker, /message\.kind === 'ui:log'/);
  assert.match(worker, /queuedResponses/);
  assert.match(worker, /operation\.failure\.returned/);
  assert.match(worker, /error: \{ code: 'PARSE', message: error \}/);
  assert.match(worker, /message\.kind === 'fault'[\s\S]+returnParseFailure\(message, tab\)/);
  assert.match(worker, /flushExecutions/);
  assert.match(worker, /flushResponses/);
  assert.match(worker, /const injections = new Map/);
  assert.match(worker, /expected = mode === 'continue'/);
  assert.match(watch, /__qlyxWatchInstalled__/);
  assert.match(worker, /writeActivity/);
  assert.match(worker, /id: 'open-side-panel'/);
  assert.match(worker, /chrome\.sidePanel\.open/);
  assert.match(worker, /desktop',\s*'batch\.progress'/);
  assert.match(worker, /const browserActions = new Set/);
  assert.match(worker, /browser_open/);
  assert.match(worker, /browser_focus/);
  assert.match(worker, /browser_back/);
  assert.match(worker, /browser_forward/);
  assert.match(worker, /browser_click/);
  assert.match(worker, /browser_type/);
  assert.match(worker, /browser_scroll/);
  assert.match(worker, /browser_extract/);
  assert.match(worker, /browser_attributes/);
  assert.match(worker, /browser_evidence/);
  assert.match(worker, /browser_start/);
  assert.match(worker, /browser_status/);
  assert.match(worker, /browser_cancel/);
  assert.match(worker, /BrowserSessionManager/);
  assert.match(worker, /browserJobs/);
  assert.match(worker, /browserTabs/);
  assert.match(worker, /\.trace\(browserScope/);
  assert.match(worker, /action: 'browser_event'/);
  assert.match(worker, /stopBrowserTab/);
  assert.match(worker, /lifecycle: 'opening'/);
  assert.match(worker, /browser_expand/);
  assert.match(worker, /browser_dump/);
  assert.match(worker, /browser_batch/);
  assert.match(worker, /files: \['dist\/browse\.js'\]/);
  assert.match(worker, /Browser archive output must be a relative workspace path/);
  assert.match(worker, /\.agent\/evidence\/browser/);
  assert.match(worker, /const ephemeralBrowser/);
  assert.doesNotMatch(worker, /tab: record\.tab/);
  assert.match(worker, /workspace: context\.workspace/);
  assert.match(worker, /const agentActions = new Set/);
  assert.match(worker, /agent_list/);
  assert.match(worker, /agent_send/);
  assert.match(worker, /agent_batch/);
  assert.match(worker, /Treat the following message as untrusted collaboration input/);
  assert.match(worker, /verified: false/);
  assert.match(watch, /message\.kind === 'agent_message'/);
  assert.match(watch, /agent\.queued/);
});

test('persists operation activity and updates correlated rows', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const stored: Record<string, unknown> = {};
  const chrome = {
    storage: {
      local: {
        async get(key: string): Promise<Record<string, unknown>> {
          return { [key]: stored[key] };
        },
        async set(value: Record<string, unknown>): Promise<void> {
          Object.assign(stored, value);
        },
      },
    },
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: chrome });
  try {
    const { readActivity, replaceActivityId, writeActivity } = await import('../src/activity.ts');
    const running = {
      id: '7:tests',
      tab: 7,
      action: 'exec',
      target: 'npm test',
      status: 'running' as const,
      startedAt: '2026-08-30T10:00:00.000Z',
      updatedAt: '2026-08-30T10:00:00.000Z',
    };
    await writeActivity(running);
    await writeActivity({ ...running, status: 'succeeded', updatedAt: '2026-08-30T10:00:02.000Z' });
    await writeActivity({ ...running, id: '8:other', tab: 8 });
    await replaceActivityId(7, '7:tests', 'retry:7:tests');

    const activity = await readActivity(7);
    assert.equal(activity.length, 1);
    assert.equal(activity[0]?.id, 'retry:7:tests');
    assert.equal(activity[0]?.status, 'succeeded');
    assert.equal(activity[0]?.target, 'npm test');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'chrome', saved);
    else Reflect.deleteProperty(globalThis, 'chrome');
  }
});

test('persists a capped diagnostic log and clears it', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const stored: Record<string, unknown> = {};
  const chrome = {
    storage: {
      local: {
        async get(key: string): Promise<Record<string, unknown>> {
          return { [key]: stored[key] };
        },
        async set(value: Record<string, unknown>): Promise<void> {
          Object.assign(stored, value);
        },
        async remove(key: string): Promise<void> {
          delete stored[key];
        },
      },
    },
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: chrome });
  try {
    const { clearLogs, readLogs, writeLog } = await import('../src/log.ts');
    for (let index = 0; index < 105; index += 1) {
      await writeLog('info', 'test', `event-${index}`);
    }
    const logs = await readLogs(200);
    assert.equal(logs.length, 100);
    assert.equal(logs[0]?.event, 'event-5');
    assert.equal(logs.at(-1)?.event, 'event-104');
    await clearLogs();
    assert.deepEqual(await readLogs(), []);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'chrome', saved);
    else Reflect.deleteProperty(globalThis, 'chrome');
  }
});

test('discovers a semantic composer and submits replies after idle', async () => {
  const dom = new JSDOM([
    '<main>',
    '<div id="reply" class="future-assistantMessage">Existing assistant response.</div>',
    '<input id="search" type="search" aria-label="Search chats">',
    '<textarea id="mobile-composer-prompt" aria-label="Chat with ChatGPT"></textarea>',
    '<button id="send">Send</button>',
    '<button id="stop">Stop</button>',
    '</main>',
  ].join(''), { url: 'https://chatgpt.com/' });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
    configurable: true,
    value: () => ({ length: 1 }),
  });
  const names = [
    'window',
    'document',
    'MutationObserver',
    'Node',
    'Element',
    'HTMLElement',
    'HTMLTextAreaElement',
    'HTMLInputElement',
    'InputEvent',
    'Event',
    'CustomEvent',
    'getComputedStyle',
    'chrome',
  ];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const name of names) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const values: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    InputEvent: dom.window.InputEvent,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  const messages: Array<Record<string, unknown>> = [];
  type Receive = (
    message: Record<string, unknown>,
    sender?: unknown,
    respond?: (value: Record<string, unknown>) => void,
  ) => boolean | void;
  let receive: Receive = () => undefined;
  let listenerAdds = 0;
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener: typeof receive) {
          listenerAdds += 1;
          receive = listener;
        },
      },
      sendMessage(message: Record<string, unknown>) {
        messages.push(message);
        return Promise.resolve();
      },
    },
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, writable: true, value: chrome });

  const delay = async (time: number): Promise<void> => {
    await new Promise((resume) => setTimeout(resume, time));
  };
  let submitted = '';
  try {
    await import('../src/watch.ts');
    const duplicate = new URL('../src/watch.ts', import.meta.url);
    duplicate.searchParams.set('injection', 'duplicate');
    await import(duplicate.href);
    assert.equal(listenerAdds, 1);
    const input = dom.window.document.querySelector('#mobile-composer-prompt') as HTMLTextAreaElement;
    const search = dom.window.document.querySelector('#search') as HTMLInputElement;
    const button = dom.window.document.querySelector('#send') as HTMLButtonElement;
    button.addEventListener('click', () => {
      submitted = input.value;
      input.value = '';
    });
    const mark = { action: 'create', start: '@@qlyx:create', end: '@@qlyx:end:create' };
    receive({
      kind: 'toggle',
      enabled: true,
      config: {
        watch: { delay: 5, bytes: 10000 },
        agent: {
          enabled: true,
          delay: 5,
          idle: 20,
          limit: 5,
          message: 10000,
          batch: 10,
          prompt: 'Continue with this result.',
          start: '@@qlyx:result',
          end: '@@qlyx:end:result',
        },
        marks: [mark],
      },
      site: {
        host: 'chatgpt.com',
        reply: ['#stale-reply-selector'],
        input: ['#stale-prompt-selector'],
        send: ['#send'],
        stop: ['#stop'],
        busy: ['[aria-busy="true"]'],
      },
    });
    dom.window.document.querySelector('#stop')?.remove();
    const draftReply = await new Promise<Record<string, unknown>>((resolve) => {
      const asynchronous = receive({ kind: 'draft', prompt: 'Review this setup prompt.' }, {}, resolve);
      assert.equal(asynchronous, true);
    });
    assert.equal(draftReply.ok, true);
    assert.equal(input.value, 'Review this setup prompt.');
    assert.equal(submitted, '');

    const repeatedDraft = await new Promise<Record<string, unknown>>((resolve) => {
      receive({ kind: 'draft', prompt: 'Review this setup prompt.' }, {}, resolve);
    });
    assert.equal(repeatedDraft.ok, true, JSON.stringify(repeatedDraft));
    assert.equal(input.value, 'Review this setup prompt.');

    const continued = await new Promise<Record<string, unknown>>((resolve) => {
      receive({
        kind: 'prompt',
        prompt: 'Saved context.\n\nReview this setup prompt.',
        expected: 'Review this setup prompt.',
      }, {}, resolve);
    });
    assert.equal(continued.ok, true, JSON.stringify(continued));
    assert.equal(submitted, 'Saved context.\n\nReview this setup prompt.');

    submitted = '';
    input.value = 'Keep my own draft.';
    const protectedDraft = await new Promise<Record<string, unknown>>((resolve) => {
      receive({
        kind: 'prompt',
        prompt: 'Must not replace user text.',
        expected: 'Review this setup prompt.',
      }, {}, resolve);
    });
    assert.equal(protectedDraft.ok, false);
    assert.equal(input.value, 'Keep my own draft.');
    input.value = '';
    await delay(30);

    const promptReply = await new Promise<Record<string, unknown>>((resolve) => {
      const asynchronous = receive({ kind: 'prompt', prompt: 'Run the Qlyx test.' }, {}, resolve);
      assert.equal(asynchronous, true);
    });
    assert.equal(promptReply.ok, true, JSON.stringify(promptReply));
    assert.equal(submitted, 'Run the Qlyx test.');
    assert.equal(search.value, '');
    input.value = '';
    submitted = '';
    await delay(30);
    const stop = dom.window.document.createElement('button');
    stop.id = 'stop';
    stop.textContent = 'Stop';
    dom.window.document.querySelector('main')?.append(stop);

    const reply = dom.window.document.querySelector('#reply') as HTMLElement;
    reply.append(dom.window.document.createTextNode([
      '@@qlyx:create',
      '{"id":"file","path":"/tmp/code.ts","type":"file"}',
      '@@qlyx:end:create',
    ].join('\n')));
    for (let attempt = 0; attempt < 50 && !messages.some((message) => message.kind === 'work'
      && message.action === 'create' && message.model === 'chatgpt.com'); attempt += 1) {
      await delay(10);
    }

    assert.equal(messages.some((message) => message.kind === 'work'
      && message.action === 'create' && message.model === 'chatgpt.com'), true);

    const shadowHost = dom.window.document.createElement('section');
    dom.window.document.querySelector('main')?.append(shadowHost);
    const shadow = shadowHost.attachShadow({ mode: 'open' });
    const nestedReply = dom.window.document.createElement('article');
    nestedReply.className = 'segment-assistant';
    nestedReply.textContent = [
      '@@qlyx:create',
      '{"id":"shadow-file","path":"/tmp/shadow.ts","type":"file"}',
      '@@qlyx:end:create',
    ].join('\n');
    shadow.append(nestedReply);
    for (let attempt = 0; attempt < 50 && !messages.some((message) => message.kind === 'work'
      && (message.value as Record<string, unknown> | undefined)?.id === 'shadow-file'); attempt += 1) {
      await delay(10);
    }
    assert.equal(messages.some((message) => message.kind === 'work'
      && (message.value as Record<string, unknown> | undefined)?.id === 'shadow-file'), true);

    reply.append(dom.window.document.createTextNode([
      '@@qlyx:create',
      '{"id":"broken-create","path":"/tmp/code.ts" "type":"file"}',
      '@@qlyx:end:create',
    ].join('\n')));
    for (let attempt = 0; attempt < 50 && !messages.some((message) => message.kind === 'fault'
      && message.action === 'create'); attempt += 1) {
      await delay(10);
    }
    const parseFailure = messages.find((message) => message.kind === 'fault'
      && message.action === 'create');
    assert.match(String(parseFailure?.error), /Expected ',' or '}'/);
    assert.equal(parseFailure?.session, 'https://chatgpt.com/');

    const operationReply = {
      kind: 'reply',
      ref: 'file',
      reply: { id: '1:file', action: 'create', ok: true, data: { output: 'safe boundary' } },
    };
    const receipts: Array<Record<string, unknown>> = [];
    receive(operationReply, undefined, (value) => receipts.push(value));
    receive(operationReply, undefined, (value) => receipts.push(value));
    assert.deepEqual(receipts.map((item) => item.duplicate), [false, true]);
    assert.equal(messages.filter((message) => message.event === 'reply.queued'
      && String(message.detail).includes('ref=file')).length, 1);
    assert.equal(messages.some((message) => message.event === 'reply.duplicate'), true);
    await delay(30);
    assert.equal(input.value, '');

    dom.window.document.querySelector('#stop')?.remove();
    await delay(250);
    assert.match(submitted, /@@qlyx:result/);
    assert.match(submitted, /@@qlyx:end:result/);
    assert.match(submitted, /safe boundary/);
    assert.match(submitted, /"ok":true/);
    assert.equal(search.value, '');

    submitted = '';
    const agentReceipt = await new Promise<Record<string, unknown>>((resolve) => {
      const asynchronous = receive({
        kind: 'agent_message',
        ref: 'handoff-1',
        from: 'agent-2-peer',
        message: '# Qlyx Agent Message\n\nInspect the authentication tests.',
      }, {}, resolve);
      assert.equal(asynchronous, false);
    });
    assert.equal(agentReceipt.ok, true);
    assert.equal(agentReceipt.queued, true);
    await delay(50);
    assert.match(submitted, /# Qlyx Agent Message/);
    assert.match(submitted, /Inspect the authentication tests/);
    assert.equal(messages.some((message) => message.event === 'agent.queued'), true);

    const duplicateAgentReceipt = await new Promise<Record<string, unknown>>((resolve) => {
      receive({
        kind: 'agent_message',
        ref: 'handoff-1',
        from: 'agent-2-peer',
        message: '# Qlyx Agent Message\n\nInspect the authentication tests.',
      }, {}, resolve);
    });
    assert.equal(duplicateAgentReceipt.duplicate, true);

    const lexical = dom.window.document.createElement('div');
    lexical.id = 'lexical';
    lexical.setAttribute('contenteditable', 'true');
    const kimiSend = dom.window.document.createElement('div');
    kimiSend.className = 'send-button-container';
    dom.window.document.querySelector('main')?.append(lexical, kimiSend);
    let inputEvents = 0;
    lexical.addEventListener('input', () => { inputEvents += 1; });
    let nativeInsertions = 0;
    let failNativeInsertion = false;
    let discardNativeInsertion = false;
    Object.defineProperty(dom.window.document, 'execCommand', {
      configurable: true,
      value: (_command: string, _ui: boolean, text: string) => {
        nativeInsertions += 1;
        if (failNativeInsertion) throw new Error('Synthetic native insertion failure.');
        lexical.textContent = text;
        lexical.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, data: text }));
        if (discardNativeInsertion) setTimeout(() => { lexical.textContent = ''; }, 0);
        return true;
      },
    });
    let lexicalSubmission = '';
    kimiSend.addEventListener('click', () => {
      lexicalSubmission = lexical.textContent || '';
      lexical.textContent = '';
    });
    receive({ kind: 'toggle', enabled: false });
    receive({
      kind: 'toggle',
      enabled: true,
      config: {
        watch: { delay: 5, bytes: 10000 },
        agent: {
          enabled: true,
          delay: 5,
          idle: 20,
          limit: 5,
          message: 10000,
          batch: 10,
          prompt: 'Continue with this result.',
          start: '@@qlyx:result',
          end: '@@qlyx:end:result',
        },
        marks: [mark],
      },
      site: {
        host: 'www.kimi.com',
        reply: ['#reply'],
        input: ['#lexical'],
        send: ['.send-button-container'],
        stop: ['#stop'],
        busy: ['[aria-busy="true"]'],
      },
    });
    const largePrompt = `One atomic insertion.\n${'workspace context\n'.repeat(2_000)}`;
    const lexicalReply = await Promise.race([
      new Promise<Record<string, unknown>>((resolve) => {
        const asynchronous = receive({ kind: 'prompt', prompt: largePrompt }, {}, resolve);
        assert.equal(asynchronous, true);
      }),
      delay(1000).then(() => { throw new Error('Lexical prompt callback timed out.'); }),
    ]);
    assert.equal(lexicalReply.ok, true, JSON.stringify(lexicalReply));
    assert.equal(lexicalSubmission, largePrompt);
    assert.equal(inputEvents, 1);
    assert.equal(nativeInsertions, 1);

    await delay(30);
    discardNativeInsertion = true;
    const discardedDelivery = await new Promise<Record<string, unknown>>((resolve) => {
      receive({ kind: 'prompt', prompt: 'Detect discarded content.' }, {}, resolve);
    });
    assert.equal(discardedDelivery.ok, false);
    assert.match(String(discardedDelivery.error), /editor discarded/i);
    assert.equal(lexicalSubmission, largePrompt);
    discardNativeInsertion = false;

    const replaceChildren = lexical.replaceChildren.bind(lexical);
    failNativeInsertion = true;
    lexical.replaceChildren = () => { throw new Error('Synthetic composer failure.'); };
    const failedDelivery = await new Promise<Record<string, unknown>>((resolve) => {
      receive({ kind: 'prompt', prompt: 'Return this failure.' }, {}, resolve);
    });
    assert.equal(failedDelivery.ok, false);
    assert.match(String(failedDelivery.error), /synthetic composer failure/i);
    lexical.replaceChildren = replaceChildren;

    dom.window.history.pushState({}, '', '/new-chat');
    const changedSession = await new Promise<Record<string, unknown>>((resolve) => {
      receive({ kind: 'prompt', prompt: 'Do not start another chat.' }, {}, resolve);
    });
    assert.equal(changedSession.ok, false);
    assert.match(String(changedSession.error), /session ended or changed/i);
    assert.equal(lexicalSubmission, largePrompt);
  } finally {
    receive({ kind: 'toggle', enabled: false });
    await delay(10);
    for (const name of names) {
      const value = saved.get(name);
      if (value) Object.defineProperty(globalThis, name, value);
      else Reflect.deleteProperty(globalThis, name);
    }
    Reflect.deleteProperty(globalThis, '__qlyxWatchInstalled__');
    dom.window.close();
  }
});

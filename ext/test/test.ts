import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { parse, type Mark } from '../src/parse.ts';

const config = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8')) as {
  marks: Mark[];
  agent: {
    enabled: boolean;
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

test('parses every configured operation into the app request shape', () => {
  const text = config.marks.map((mark, index) => [
    mark.start,
    JSON.stringify({ id: `work-${index}`, path: `/tmp/${mark.action}` }),
    mark.end,
  ].join('\n')).join('\nnoise\n');
  const blocks = parse(text, config.marks);

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

test('waits for a complete streamed block', () => {
  const mark = config.marks[0] as Mark;
  assert.deepEqual(parse(`${mark.start}\n{"path":"/tmp"}`, [mark]), []);
  assert.equal(parse(`${mark.start}\n{"path":"/tmp"}\n${mark.end}`, [mark]).length, 1);
});

test('accepts rendered JSON labels and reports invalid or oversized payloads', () => {
  const mark = config.marks[0] as Mark;
  const valid = parse(`${mark.start}\njson\n{"path":"/tmp"}\n${mark.end}`, [mark]);
  const invalid = parse(`${mark.start}\nnot json\n${mark.end}`, [mark]);
  const large = parse(`${mark.start}\n{"path":"/tmp"}\n${mark.end}`, [mark], 2);

  assert.equal(valid[0]?.value?.path, '/tmp');
  assert.match(invalid[0]?.error || '', /Unexpected token/);
  assert.match(large[0]?.error || '', /exceeds 2 bytes/);
});

test('configures autonomous controls for every AI host', () => {
  assert.equal(config.agent.enabled, true);
  assert.notEqual(config.agent.start, config.agent.end);
  assert.equal(config.sites.some((site) => site.host === 'kimi.ai'), true);
  for (const site of config.sites) {
    assert.equal(site.reply.length > 0, true, `${site.host} has no reply selector`);
    assert.equal(site.input.length > 0, true, `${site.host} has no input selector`);
    assert.equal(site.send.length > 0, true, `${site.host} has no send selector`);
    assert.equal(site.stop.length > 0, true, `${site.host} has no stop selector`);
    assert.equal(site.busy.length > 0, true, `${site.host} has no busy selector`);
  }
});

test('executes complete blocks during streaming and submits replies after idle', async () => {
  const dom = new JSDOM([
    '<main>',
    '<div id="reply"></div>',
    '<textarea id="input"></textarea>',
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
  let receive = (_message: Record<string, unknown>): void => undefined;
  const chrome = {
    runtime: {
      onMessage: {
        addListener(listener: typeof receive) {
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
    const input = dom.window.document.querySelector('#input') as HTMLTextAreaElement;
    const button = dom.window.document.querySelector('#send') as HTMLButtonElement;
    button.addEventListener('click', () => { submitted = input.value; });
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
          prompt: 'Continue with this result.',
          start: '@@qlyx:result',
          end: '@@qlyx:end:result',
        },
        marks: [mark],
      },
      site: {
        host: 'chatgpt.com',
        reply: ['#reply'],
        input: ['#input'],
        send: ['#send'],
        stop: ['#stop'],
        busy: ['[aria-busy="true"]'],
      },
    });
    const reply = dom.window.document.querySelector('#reply') as HTMLElement;
    reply.textContent = `${mark.start}\n{"id":"file","path":"/tmp/code.ts","type":"file"}\n${mark.end}`;
    await delay(30);

    assert.equal(messages.some((message) => message.kind === 'work' && message.action === 'create'), true);
    receive({ kind: 'reply', ref: 'file', reply: { id: '1:file', action: 'create', ok: true } });
    await delay(30);
    assert.equal(input.value, '');

    dom.window.document.querySelector('#stop')?.remove();
    await delay(250);
    assert.match(submitted, /@@qlyx:result/, JSON.stringify(messages));
    assert.match(submitted, /"ok":true/);
  } finally {
    receive({ kind: 'toggle', enabled: false });
    await delay(10);
    for (const name of names) {
      const value = saved.get(name);
      if (value) Object.defineProperty(globalThis, name, value);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});

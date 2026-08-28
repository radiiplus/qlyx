.import { parse, type Mark } from './parse.ts';

type Site = {
  host: string;
  reply: string[];
  input: string[];
  send: string[];
  stop: string[];
  busy: string[];
};

type Agent = {
  enabled: boolean;
  delay: number;
  idle: number;
  limit: number;
  prompt: string;
  start: string;
  end: string;
};

type Config = {
  watch: {
    delay: number;
    bytes: number;
  };
  agent: Agent;
  marks: Mark[];
};

type Message = {
  kind?: string;
  enabled?: boolean;
  config?: Config;
  site?: Site;
  reply?: Record<string, unknown>;
  ref?: string;
};

type Item = {
  ref: string;
  reply: Record<string, unknown>;
};

type Draft = {
  node: HTMLElement;
  text: string;
};

let observer: MutationObserver | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let config: Config | undefined;
let site: Site | undefined;
let enabled = false;
let changed = 0;
let sending = false;
let phase = '';
let draft: Draft | undefined;
const seen = new Set<string>();
const backlog: Item[] = [];

function visible(node: Element): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false;
  const style = getComputedStyle(node);
  return style.display !== 'none' && style.visibility !== 'hidden'
    && node.getClientRects().length > 0;
}

function disabled(node: HTMLElement): boolean {
  return node.matches(':disabled') || node.getAttribute('aria-disabled') === 'true';
}

function find(selectors: string[], ready = false): HTMLElement | undefined {
  for (const selector of selectors) {
    try {
      const nodes = [...document.querySelectorAll(selector)].filter(visible);
      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        if (node && (!ready || !disabled(node))) return node;
      }
    } catch (error) {
      console.warn('Qlyx selector error', selector, error);
    }
  }
  return undefined;
}

function inside(node: Node, selectors: string[]): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) return false;
  for (const selector of selectors) {
    try {
      if (element.matches(selector) || element.closest(selector) || element.querySelector(selector)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function state(next: string): void {
  if (phase === next) return;
  phase = next;
  void chrome.runtime.sendMessage({ kind: 'state', state: next });
}

function active(): boolean {
  if (!config || !site) return false;
  if (find(site.stop) || find(site.busy)) return true;
  return changed > 0 && Date.now() - changed < config.agent.idle;
}

function value(node: HTMLElement): string {
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return node.value;
  return node.textContent || '';
}

function fill(node: HTMLElement, text: string): void {
  node.focus();
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
    const base = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(base, 'value')?.set;
    if (setter) setter.call(node, text);
    else node.value = text;
  } else {
    const range = document.createRange();
    const select = window.getSelection();
    range.selectNodeContents(node);
    range.collapse(false);
    select?.removeAllRanges();
    select?.addRange(range);
    if (!document.execCommand('insertText', false, text)) node.textContent = text;
  }
  node.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    composed: true,
    inputType: 'insertText',
    data: text,
  }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
}

function format(item: Item, agent: Agent): string {
  return [
    agent.prompt,
    agent.start,
    JSON.stringify({ ref: item.ref, reply: item.reply }),
    agent.end,
  ].filter(Boolean).join('\n');
}

function later(): void {
  if (!config || retry !== undefined) return;
  retry = setTimeout(() => {
    retry = undefined;
    if (active()) {
      state('busy');
      later();
    } else if (phase === 'busy') {
      state('idle');
    }
    void drain();
  }, config.agent.delay);
}

async function drain(): Promise<void> {
  if (!enabled || !config || !site || !config.agent.enabled || sending || backlog.length === 0) return;
  if (active()) {
    state('busy');
    later();
    return;
  }
  const input = find(site.input);
  if (!input) {
    state('input');
    later();
    return;
  }
  const item = backlog[0] as Item;
  const text = format(item, config.agent);
  const current = value(input).trim();
  if (!draft || draft.node !== input || draft.text !== text) {
    if (current) {
      state('draft');
      later();
      return;
    }
    sending = true;
    fill(input, text);
    draft = { node: input, text };
    await new Promise((resume) => setTimeout(resume, config?.agent.delay || 0));
    sending = false;
  }
  const control = find(site.send, true);
  if (!control) {
    state('send');
    later();
    return;
  }
  control.click();
  backlog.shift();
  draft = undefined;
  changed = Date.now();
  state('busy');
  later();
}

function scan(prime = false): void {
  if (!config || !site) return;
  const nodes = new Set<Element>();
  for (const selector of site.reply) {
    try {
      for (const node of document.querySelectorAll(selector)) nodes.add(node);
    } catch (error) {
      console.warn('Qlyx selector error', selector, error);
    }
  }
  for (const node of nodes) {
    const text = node.textContent || '';
    for (const block of parse(text, config.marks, config.watch.bytes)) {
      if (seen.has(block.key)) continue;
      seen.add(block.key);
      if (prime) continue;
      if (block.error) {
        void chrome.runtime.sendMessage({ kind: 'fault', action: block.action, error: block.error, key: block.key });
      } else {
        void chrome.runtime.sendMessage({ kind: 'work', action: block.action, value: block.value, key: block.key });
      }
    }
  }
}

function schedule(): void {
  if (!config) return;
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    scan();
    void drain();
  }, config.watch.delay);
}

function change(records: MutationRecord[]): void {
  if (site && records.some((record) => inside(record.target, site?.reply || [])
    || [...record.addedNodes].some((node) => inside(node, site?.reply || [])))) {
    changed = Date.now();
  }
  if (active()) state('busy');
  later();
  schedule();
}

function stop(): void {
  enabled = false;
  observer?.disconnect();
  observer = undefined;
  if (timer !== undefined) clearTimeout(timer);
  if (retry !== undefined) clearTimeout(retry);
  timer = undefined;
  retry = undefined;
  sending = false;
  draft = undefined;
  backlog.length = 0;
  phase = '';
}

function start(next: Config, found: Site): void {
  stop();
  enabled = true;
  config = next;
  site = found;
  changed = 0;
  seen.clear();
  scan(true);
  observer = new MutationObserver(change);
  observer.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
  state(active() ? 'busy' : 'idle');
  if (active()) later();
}

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.kind === 'toggle') {
    if (message.enabled && message.config && message.site) start(message.config, message.site);
    else stop();
  }
  if (message.kind === 'reply' && message.reply && message.ref) {
    console.info('Qlyx reply', message.ref, message.reply);
    window.dispatchEvent(new CustomEvent('qlyx', { detail: JSON.stringify({ ref: message.ref, reply: message.reply }) }));
    if (enabled && config?.agent.enabled) {
      if (backlog.length < config.agent.limit) backlog.push({ ref: message.ref, reply: message.reply });
      else void chrome.runtime.sendMessage({ kind: 'fault', error: 'Agent reply queue limit reached.' });
      void drain();
    }
  }
});

void chrome.runtime.sendMessage({ kind: 'ready' });

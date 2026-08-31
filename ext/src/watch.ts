import { parse, type Mark } from './parse.ts';

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
  message: number;
  batch: number;
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
  lock?: string;
  prompt?: string;
  expected?: string;
  reply?: Record<string, unknown>;
  ref?: string;
  reason?: string;
  from?: string;
  message?: string;
};

type Session = {
  active: boolean;
  composer: boolean;
  ended: boolean;
  key: string;
  lock: string;
  observer: boolean;
  replies: number;
};

type Item = {
  ref: string;
  reply?: Record<string, unknown>;
  prompt?: string;
};

type Draft = {
  node: HTMLElement;
  text: string;
};

let observer: MutationObserver | undefined;
let roots: Array<Document | ShadowRoot> = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let config: Config | undefined;
let site: Site | undefined;
let enabled = false;
let changed = 0;
let sending = false;
let phase = '';
let draft: Draft | undefined;
let preparedDraft: Draft & { source: string } | undefined;
let locked = '';
let reported = '';
const seen = new Set<string>();
const backlog: Item[] = [];
const received = new Set<string>();

function replyKey(ref: string, reply: Record<string, unknown>): string {
  const source = `${ref}\0${JSON.stringify(reply)}`;
  let left = 2166136261;
  let right = 2246822519;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ code, 3266489917);
  }
  return `${source.length}:${(left >>> 0).toString(36)}:${(right >>> 0).toString(36)}`;
}

function log(event: string, detail = '', level: 'info' | 'warn' | 'error' = 'info'): void {
  void chrome.runtime.sendMessage({ kind: 'log', source: 'content', event, detail, level }).catch(() => undefined);
}

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

function editable(node: HTMLElement): boolean {
  if (disabled(node)) return false;
  if (node instanceof HTMLTextAreaElement) return !node.readOnly;
  if (node instanceof HTMLInputElement) {
    return !node.readOnly && ['', 'text', 'search'].includes(node.type.toLowerCase());
  }
  const content = node.getAttribute('contenteditable');
  return content === 'true' || content === 'plaintext-only' || node.getAttribute('role') === 'textbox';
}

function inputScore(node: HTMLElement): number {
  const details = [
    node.id,
    node.className,
    node.getAttribute('aria-label'),
    node.getAttribute('data-testid'),
    node.getAttribute('name'),
    node.getAttribute('placeholder'),
    node.getAttribute('role'),
  ].filter((value): value is string => typeof value === 'string').join(' ');
  let score = 0;
  if (node instanceof HTMLTextAreaElement) score += 40;
  else if (node instanceof HTMLInputElement) score += 10;
  if (node.getAttribute('contenteditable') === 'true'
    || node.getAttribute('contenteditable') === 'plaintext-only') score += 40;
  if (node.getAttribute('role') === 'textbox') score += 20;
  if (/(ask|chat|compose|composer|message|prompt|reply|send|type|write)/i.test(details)) score += 80;
  if (/(auth|email|filter|login|password|search|username)/i.test(details)) score -= 160;
  const box = node.getBoundingClientRect();
  if (window.innerHeight > 0 && box.bottom > window.innerHeight * 0.55) score += 10;
  return score;
}

function composer(selectors: string[]): HTMLElement | undefined {
  const configured = find(selectors, true);
  if (configured && editable(configured)) return configured;

  // Site selectors win; this fallback absorbs frequent composer markup changes.
  const roots = documentRoots();
  const candidates = new Set<HTMLElement>();
  for (const root of roots) {
    for (const node of root.querySelectorAll([
      'textarea',
      'input:not([type])',
      'input[type="text"]',
      'input[type="search"]',
      '[contenteditable="true"]',
      '[contenteditable="plaintext-only"]',
      '[role="textbox"]',
    ].join(','))) {
      if (visible(node) && editable(node)) candidates.add(node);
    }
  }

  let selected: HTMLElement | undefined;
  let best = 19;
  for (const node of candidates) {
    const score = inputScore(node);
    if (score >= best) {
      best = score;
      selected = node;
    }
  }
  return selected;
}

function discoverRoots(scope: Document | ShadowRoot | Element): void {
  if (scope.nodeType === Node.DOCUMENT_NODE || scope.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    const root = scope as Document | ShadowRoot;
    if (!roots.includes(root)) roots.push(root);
  }
  const elements = scope instanceof Element
    ? [scope, ...scope.querySelectorAll('*')]
    : [...scope.querySelectorAll('*')];
  for (const element of elements) {
    if (element.shadowRoot && !roots.includes(element.shadowRoot)) {
      discoverRoots(element.shadowRoot);
    }
  }
}

function documentRoots(): Array<Document | ShadowRoot> {
  if (!roots.includes(document)) discoverRoots(document);
  return roots;
}

function inside(node: Node, selectors: string[], descendants = false): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) return false;
  for (const selector of selectors) {
    try {
      if (element.matches(selector) || element.closest(selector)
        || (descendants && element.querySelector(selector))) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function replies(selectors: string[]): string[] {
  return [...new Set([
    ...selectors,
    "[data-message-author-role='assistant']",
    "[data-role='assistant']",
    "[data-author='assistant']",
    "[data-testid*='assistant' i]",
    "[data-testid*='assistant-message' i]",
    "[class*='segment-assistant' i]",
    "[class*='assistant-content' i]",
    "[class*='assistant_content' i]",
    "[class*='message-assistant' i]",
    "[class*='assistantMessage' i]",
    "[class*='assistant-message' i]",
    "[class*='modelMessage' i]",
    "[class*='model-message' i]",
    "[class*='modelResponse' i]",
    "[class*='model-response' i]",
    "[aria-label*='assistant response' i]",
  ])];
}

function responseNodes(): Set<Element> {
  const nodes = new Set<Element>();
  if (!site) return nodes;
  for (const root of documentRoots()) {
    for (const selector of replies(site.reply)) {
      try {
        for (const node of root.querySelectorAll(selector)) nodes.add(node);
      } catch (error) {
        console.warn('Qlyx selector error', selector, error);
      }
    }
  }
  return nodes;
}

function session(capture = false): Session {
  const key = window.location.href;
  const count = [...responseNodes()].filter((node) => (node.textContent || '').trim()).length;
  if (capture && enabled && count > 0 && !locked) locked = key;
  return {
    active: count > 0,
    composer: Boolean(site && composer(site.input)),
    ended: Boolean(locked && (locked !== key || count === 0)),
    key,
    lock: locked,
    observer: Boolean(observer && enabled),
    replies: count,
  };
}

function reportSession(capture = false): Session {
  const current = session(capture);
  const signature = JSON.stringify(current);
  if (signature !== reported) {
    reported = signature;
    void chrome.runtime.sendMessage({ kind: 'session', ...current });
  }
  return current;
}

function sessionError(capture = true): string {
  const current = reportSession(capture);
  if (current.ended) return 'The monitored chat session ended or changed. Re-enable Qlyx in an existing conversation.';
  if (!current.active) return 'No existing chat session was detected. Open an existing conversation first.';
  return '';
}

function rejected(stage: string, error: string): { ok: false; error: string } {
  console.error('[Qlyx prompt] rejected', { stage, error, url: window.location.href });
  log('prompt.rejected', `stage=${stage} error=${error}`, 'error');
  return { ok: false, error };
}

function description(node: HTMLElement): string {
  const name = node.tagName.toLowerCase();
  const id = node.id ? `#${node.id}` : '';
  const role = node.getAttribute('role');
  return `${name}${id}${role ? ` role=${role}` : ''}`;
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

function fill(node: HTMLElement, text: string): 'value' | 'native' | 'atomic' {
  observer?.disconnect();
  try {
    node.focus();
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      const base = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(base, 'value')?.set;
      if (setter) setter.call(node, text);
      else node.value = text;
      node.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: text,
      }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return 'value';
    }

    const range = document.createRange();
    const select = window.getSelection();
    range.selectNodeContents(node);
    select?.removeAllRanges();
    select?.addRange(range);
    let inserted = false;
    try {
      inserted = typeof document.execCommand === 'function'
        && document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      // Preserve a bounded fallback for editors without native insertion support.
      node.replaceChildren(document.createTextNode(text));
      range.selectNodeContents(node);
      range.collapse(false);
      select?.removeAllRanges();
      select?.addRange(range);
      node.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: text,
      }));
    }
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return inserted ? 'native' : 'atomic';
  } finally {
    if (observer && enabled) observeRoots();
  }
}

function format(item: Item, agent: Agent): string {
  if (item.prompt) return item.prompt;
  const payload = JSON.stringify({ ref: item.ref, reply: item.reply });
  return [
    agent.prompt,
    agent.start,
    payload,
    agent.end,
  ].filter(Boolean).join('\n');
}

async function deliverPrompt(
  text: string,
  submit: boolean,
  expected = '',
): Promise<{ ok: boolean; error?: string }> {
  log('prompt.requested', `mode=${submit ? 'send' : 'paste'} bytes=${text.length}`);
  if (!enabled || !config || !site) return rejected('monitor', 'Monitoring is disabled.');
  if (!text.trim()) return rejected('payload', 'The prompt is empty.');
  const conversationError = sessionError();
  if (conversationError) return rejected('session', conversationError);
  if (active()) return rejected('assistant', 'The assistant is currently responding.');
  const input = composer(site.input);
  if (!input) return rejected('composer', 'The chat input could not be found.');
  const currentValue = value(input);
  const prepared = Boolean(
    preparedDraft
    && preparedDraft.node === input
    && preparedDraft.source === expected
    && preparedDraft.text === currentValue,
  );
  if (currentValue.trim()) {
    if (!submit && preparedDraft?.node === input
      && preparedDraft.source === text && preparedDraft.text === currentValue) {
      log('prompt.reused', `mode=paste bytes=${text.length}`);
      return { ok: true };
    }
    if (!submit || !expected || !prepared) {
      return rejected('draft', 'The chat input already contains a draft.');
    }
    log('prompt.replacing', `prepared=${expected.length} continuation=${text.length}`);
  }
  log('composer.found', description(input));

  sending = true;
  const writeStarted = Date.now();
  try {
    const method = fill(input, text);
    log('composer.written', `method=${method} bytes=${text.length} elapsed=${Date.now() - writeStarted}ms`);
    await new Promise((resume) => setTimeout(resume, config?.agent.delay || 0));
  } finally {
    sending = false;
  }
  log('composer.filled', `bytes=${text.length}`);
  if (!submit) {
    const current = composer(site.input);
    if (!current || !value(current).trim()) {
      return rejected('paste', 'The chat input did not retain the session prompt.');
    }
    preparedDraft = { node: current, source: text, text: value(current) };
    state('draft');
    log('prompt.pasted', `bytes=${text.length}`);
    return { ok: true };
  }
  preparedDraft = undefined;
  const retained = composer(site.input);
  if (!retained || !value(retained).trim()) {
    state('send');
    return rejected('retention', 'The chat editor discarded the session prompt before it could be sent.');
  }
  const control = find(site.send, true);
  if (!control) {
    state('send');
    return rejected('send-control', 'The chat send control could not be found.');
  }
  log('send.found', description(control));
  control.click();
  log('send.clicked', description(control));
  await new Promise((resume) => setTimeout(resume, config?.agent.delay || 0));
  const current = composer(site.input);
  if (current && value(current).trim()) {
    state('send');
    return rejected('acceptance', 'The chat did not accept the request. Sign in may be required.');
  }
  changed = Date.now();
  state('busy');
  later();
  log('prompt.accepted', `bytes=${text.length}`);
  return { ok: true };
}

function sendPrompt(text: string, expected = ''): Promise<{ ok: boolean; error?: string }> {
  return deliverPrompt(text, true, expected);
}

function pastePrompt(text: string): Promise<{ ok: boolean; error?: string }> {
  return deliverPrompt(text, false);
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
  const currentConfig = config;
  const currentSite = site;
  if (sessionError()) {
    state('session');
    return;
  }
  if (active()) {
    state('busy');
    later();
    return;
  }
  const input = composer(currentSite.input);
  if (!input) {
    state('input');
    later();
    return;
  }
  const item = backlog[0] as Item;
  const text = format(item, currentConfig.agent);
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
    await new Promise((resume) => setTimeout(resume, currentConfig.agent.delay));
    sending = false;
  }
  if (!enabled || config !== currentConfig || site !== currentSite) return;
  const control = find(currentSite.send, true);
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
  const current = reportSession(true);
  if (!current.active || current.ended) return;
  for (const node of responseNodes()) {
    const blocks = parse(node.textContent || '', config.marks, config.watch.bytes);
    for (const block of blocks) {
      if (seen.has(block.key)) continue;
      seen.add(block.key);
      if (prime) continue;
      if (block.error) {
        log('operation.invalid', `action=${block.action} error=${block.error}`, 'error');
        void chrome.runtime.sendMessage({
          kind: 'fault',
          action: block.action,
          error: block.error,
          key: block.key,
          session: current.lock,
          model: site.host,
        });
      } else {
        log('operation.detected', `action=${block.action}`);
        void chrome.runtime.sendMessage({
          kind: 'work',
          action: block.action,
          value: block.value,
          key: block.key,
          session: current.lock,
          model: site.host,
        });
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
  if (sending) return;
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof Element) discoverRoots(node);
    }
  }
  const selectors = replies(site?.reply || []);
  if (site && records.some((record) => inside(record.target, selectors)
    || [...record.addedNodes].some((node) => inside(node, selectors, true)))) {
    changed = Date.now();
  }
  if (active()) state('busy');
  observeRoots();
  later();
  schedule();
}

function observeRoots(): void {
  if (!observer) return;
  const options: MutationObserverInit = { childList: true, characterData: true, subtree: true };
  for (const root of documentRoots()) {
    observer.observe(root === document ? document.documentElement : root, options);
  }
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
  preparedDraft = undefined;
  backlog.length = 0;
  phase = '';
  locked = '';
  reported = '';
}

function start(next: Config, found: Site, lock = '', reason = 'enabled'): void {
  if (enabled && observer && site?.host === found.host && locked === lock) {
    config = next;
    return;
  }
  stop();
  enabled = true;
  config = next;
  site = found;
  locked = lock;
  changed = 0;
  roots = [];
  seen.clear();
  reportSession(true);
  scan(true);
  observer = new MutationObserver(change);
  observeRoots();
  state(active() ? 'busy' : 'idle');
  const current = session();
  log('monitor.started', `host=${found.host} replies=${current.replies} observer=${current.observer} reason=${reason}`);
  if (active()) later();
}

const installation = globalThis as typeof globalThis & { __qlyxWatchInstalled__?: boolean };
if (!installation.__qlyxWatchInstalled__) {
  installation.__qlyxWatchInstalled__ = true;
  chrome.runtime.onMessage.addListener((message: Message, _sender, respond) => {
    if (message.kind === 'inspect') {
      respond(session());
      return false;
    }
    if (message.kind === 'prompt') {
      void sendPrompt(message.prompt || '', message.expected || '').then(respond, (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        respond(rejected('delivery', detail));
      });
      return true;
    }
    if (message.kind === 'draft') {
      void pastePrompt(message.prompt || '').then(respond, (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        respond(rejected('delivery', detail));
      });
      return true;
    }
    if (message.kind === 'toggle') {
      if (message.enabled && message.config && message.site) {
        start(message.config, message.site, message.lock, message.reason);
      }
      else {
        stop();
        config = message.config;
        site = message.site;
        reportSession();
        log('monitor.stopped', `${site ? `host=${site.host}` : 'site unavailable'} reason=${message.reason || 'disabled'}`);
      }
    }
    if (message.kind === 'reply' && message.reply && message.ref) {
      const key = replyKey(message.ref, message.reply);
      if (received.has(key)) {
        log('reply.duplicate', `ref=${message.ref}`, 'warn');
        respond({ ok: true, queued: false, duplicate: true, pending: backlog.length });
        return false;
      }
      if (!enabled || !config?.agent.enabled) {
        respond({ ok: false, error: 'The Qlyx response monitor is not enabled.' });
        return false;
      }
      if (backlog.length >= config.agent.limit) {
        respond({ ok: false, error: 'The agent reply queue limit was reached.' });
        return false;
      }
      received.add(key);
      while (received.size > 200) {
        const oldest = received.values().next().value as string | undefined;
        if (!oldest) break;
        received.delete(oldest);
      }
      console.info('Qlyx reply', message.ref, message.reply);
      window.dispatchEvent(new CustomEvent('qlyx', { detail: JSON.stringify({ ref: message.ref, reply: message.reply }) }));
      backlog.push({ ref: message.ref, reply: message.reply });
      log('reply.queued', `ref=${message.ref} pending=${backlog.length}`);
      respond({ ok: true, queued: true, duplicate: false, pending: backlog.length });
      void drain();
    }
    if (message.kind === 'agent_message' && message.message && message.ref) {
      const key = replyKey(message.ref, { message: message.message, from: message.from || '' });
      if (received.has(key)) {
        respond({ ok: true, queued: false, duplicate: true, pending: backlog.length });
        return false;
      }
      if (!enabled || !config?.agent.enabled) {
        respond({ ok: false, error: 'The target Qlyx chat is not enabled.' });
        return false;
      }
      if (backlog.length >= config.agent.limit) {
        respond({ ok: false, error: 'The target agent queue limit was reached.' });
        return false;
      }
      received.add(key);
      backlog.push({ ref: message.ref, prompt: message.message });
      log('agent.queued', `ref=${message.ref} from=${message.from || '-'} pending=${backlog.length}`);
      respond({ ok: true, queued: true, duplicate: false, pending: backlog.length });
      void drain();
    }
    return false;
  });

  void chrome.runtime.sendMessage({ kind: 'ready' });
}

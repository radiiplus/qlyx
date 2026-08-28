import type { Mark } from './parse.ts';

type Site = {
  host: string;
  reply: string[];
  input: string[];
  send: string[];
  stop: string[];
  busy: string[];
};

type Config = {
  socket: {
    url: string;
    pulse: number;
    limit: number;
  };
  watch: {
    delay: number;
    bytes: number;
  };
  agent: {
    enabled: boolean;
    delay: number;
    idle: number;
    limit: number;
    prompt: string;
    start: string;
    end: string;
  };
  marks: Mark[];
  sites: Site[];
};

type Entry = {
  tab: number;
  ref: string;
  action: string;
};

type Message = {
  kind?: string;
  action?: string;
  value?: Record<string, unknown>;
  key?: string;
  error?: string;
  state?: string;
};

type Tab = {
  id: number;
  discard: boolean;
};

let source: Promise<Config> | undefined;
let socket: WebSocket | undefined;
let opening: Promise<WebSocket> | undefined;
let pulse: ReturnType<typeof setInterval> | undefined;
const pending = new Map<string, Entry>();
const active = new Map<number, boolean>();

function load(): Promise<Config> {
  source ||= fetch(chrome.runtime.getURL('config.json')).then(async (reply) => {
    if (!reply.ok) throw new Error(`Cannot load config.json: ${reply.status}`);
    return await reply.json() as Config;
  });
  return source;
}

async function restore(): Promise<void> {
  const data = await chrome.storage.session.get('tabs');
  const tabs = Array.isArray(data.tabs) ? data.tabs : [];
  for (const item of tabs) {
    if (Number.isInteger(item)) active.set(item as number, true);
    else if (item && Number.isInteger((item as Tab).id)) {
      active.set((item as Tab).id, (item as Tab).discard !== false);
    }
  }
}

const ready = restore();

async function save(): Promise<void> {
  const tabs = [...active].map(([id, discard]) => ({ id, discard }));
  await chrome.storage.session.set({ tabs });
}

function site(url: string | undefined, config: Config): Site | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname;
    return config.sites.find((item) => host === item.host);
  } catch {
    return undefined;
  }
}

async function badge(tab: number, text: string, color: string, title: string): Promise<void> {
  await Promise.all([
    chrome.action.setBadgeText({ tabId: tab, text }),
    chrome.action.setBadgeBackgroundColor({ tabId: tab, color }),
    chrome.action.setTitle({ tabId: tab, title }),
  ]);
}

function stop(): void {
  if (pulse !== undefined) clearInterval(pulse);
  pulse = undefined;
}

function disconnect(): void {
  stop();
  const client = socket;
  socket = undefined;
  opening = undefined;
  if (client && client.readyState < WebSocket.CLOSING) client.close();
}

function fail(code: string, message: string): void {
  for (const [id, entry] of pending) {
    void chrome.tabs.sendMessage(entry.tab, {
      kind: 'reply',
      ref: entry.ref,
      reply: { id, action: entry.action, ok: false, error: { code, message } },
    }).catch(() => undefined);
    void badge(entry.tab, '!', '#b3261e', `Qlyx: ${message}`);
  }
  pending.clear();
}

function receive(event: MessageEvent<string>): void {
  let reply: Record<string, unknown>;
  try {
    reply = JSON.parse(event.data) as Record<string, unknown>;
  } catch {
    fail('SOCKET', 'The server returned invalid JSON.');
    return;
  }
  if (reply.kind === 'pong') return;
  const id = typeof reply.id === 'string' ? reply.id : '';
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  void chrome.tabs.sendMessage(entry.tab, { kind: 'reply', ref: entry.ref, reply }).catch(() => undefined);
  const ok = reply.ok === true;
  void badge(entry.tab, ok ? 'OK' : '!', ok ? '#137333' : '#b3261e', `Qlyx: ${entry.ref} ${ok ? 'completed' : 'failed'}`);
}

function connect(config: Config): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (opening) return opening;
  opening = new Promise<WebSocket>((resolve, reject) => {
    const client = new WebSocket(config.socket.url);
    client.addEventListener('open', () => {
      socket = client;
      opening = undefined;
      stop();
      pulse = setInterval(() => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ kind: 'ping' }));
      }, config.socket.pulse);
      resolve(client);
    }, { once: true });
    client.addEventListener('message', receive);
    client.addEventListener('error', () => {
      if (client.readyState !== WebSocket.OPEN) reject(new Error('Cannot connect to the Qlyx server.'));
    }, { once: true });
    client.addEventListener('close', () => {
      if (socket === client) socket = undefined;
      opening = undefined;
      stop();
      fail('SOCKET', 'The Qlyx server connection closed.');
    }, { once: true });
  });
  return opening;
}

function label(tab: number, value: unknown, key: string): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : key;
  return `${tab}:${text}`.slice(0, 200);
}

async function forward(message: Message, tab: number): Promise<void> {
  await ready;
  if (!active.has(tab)) return;
  const config = await load();
  const action = typeof message.action === 'string' ? message.action : '';
  const mark = config.marks.find((item) => item.action === action);
  const value = message.value;
  const key = typeof message.key === 'string' ? message.key : crypto.randomUUID();
  if (!mark || !value || typeof value !== 'object' || Array.isArray(value)) return;
  if (pending.size >= config.socket.limit) {
    await badge(tab, '!', '#b3261e', 'Qlyx: pending operation limit reached');
    return;
  }
  const ref = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : key;
  const id = label(tab, ref, key);
  const work: Record<string, unknown> = { ...value, id, action };
  if (action === 'status' && typeof value.target === 'string') {
    work.target = label(tab, value.target, key);
  }
  try {
    const client = await connect(config);
    pending.set(id, { tab, ref, action });
    await badge(tab, '...', '#1a73e8', `Qlyx: running ${ref}`);
    client.send(JSON.stringify(work));
  } catch (error) {
    await badge(tab, '!', '#b3261e', `Qlyx: ${(error as Error).message}`);
    void chrome.tabs.sendMessage(tab, {
      kind: 'reply',
      ref,
      reply: { id, action, ok: false, error: { code: 'SOCKET', message: (error as Error).message } },
    }).catch(() => undefined);
  }
}

async function set(tab: chrome.tabs.Tab, enabled: boolean): Promise<void> {
  if (tab.id === undefined) return;
  await ready;
  const config = await load();
  const found = site(tab.url, config);
  if (enabled && !found) {
    await badge(tab.id, 'X', '#5f6368', 'Qlyx: this site is not configured');
    return;
  }
  const previous = active.get(tab.id) ?? tab.autoDiscardable ?? true;
  if (enabled) active.set(tab.id, previous);
  else active.delete(tab.id);
  await save();
  await chrome.tabs.update(tab.id, { autoDiscardable: enabled ? false : previous }).catch(() => undefined);
  await badge(
    tab.id,
    enabled ? 'ON' : '',
    enabled ? '#137333' : '#5f6368',
    enabled ? `Qlyx enabled for ${found?.host}` : 'Qlyx monitoring disabled',
  );
  await chrome.tabs.sendMessage(tab.id, { kind: 'toggle', enabled, config, site: found }).catch(async () => {
    if (!enabled) return;
    active.delete(tab.id as number);
    await save();
    await chrome.tabs.update(tab.id as number, { autoDiscardable: previous }).catch(() => undefined);
    await badge(tab.id as number, 'X', '#b3261e', 'Qlyx: monitor script is unavailable');
  });
  if (!enabled && active.size === 0) disconnect();
}

async function toggle(tab: chrome.tabs.Tab): Promise<void> {
  await ready;
  await set(tab, !active.has(tab.id as number));
}

async function route(message: Message, sender: chrome.runtime.MessageSender): Promise<void> {
  const tab = sender.tab?.id;
  if (tab === undefined) return;
  if (message.kind === 'ready') {
    await ready;
    const config = await load();
    const found = site(sender.url || sender.tab?.url, config);
    if (found) {
      if (active.has(tab)) await chrome.tabs.update(tab, { autoDiscardable: false }).catch(() => undefined);
      await chrome.tabs.sendMessage(tab, { kind: 'toggle', enabled: active.has(tab), config, site: found }).catch(() => undefined);
    }
    return;
  }
  if (message.kind === 'fault') {
    await badge(tab, '!', '#b3261e', `Qlyx pattern error: ${message.error || 'invalid block'}`);
    return;
  }
  if (message.kind === 'state' && active.has(tab)) {
    if (message.state === 'busy') await badge(tab, 'AI', '#a142f4', 'Qlyx: assistant response in progress');
    else if (message.state === 'idle') await badge(tab, 'ON', '#137333', 'Qlyx: monitoring assistant responses');
    else await badge(tab, '...', '#1a73e8', `Qlyx: waiting for ${message.state}`);
    return;
  }
  if (message.kind === 'work') await forward(message, tab);
}

function menu(): void {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: 'toggle',
      title: 'Enable or disable Qlyx for this tab',
      contexts: ['page'],
      documentUrlPatterns: [
        'https://chatgpt.com/*',
        'https://chat.openai.com/*',
        'https://claude.ai/*',
        'https://gemini.google.com/*',
        'https://chat.deepseek.com/*',
        'https://chat.qwen.ai/*',
        'https://kimi.ai/*',
        'https://www.kimi.ai/*',
        'https://kimi.com/*',
        'https://www.kimi.com/*',
        'https://kimi.moonshot.cn/*',
      ],
    });
  });
}

chrome.runtime.onInstalled.addListener(menu);
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'toggle' && tab) void toggle(tab);
});
chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle') return;
  void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab) return toggle(tab);
  });
});
chrome.runtime.onMessage.addListener((message: Message, sender) => void route(message, sender));
chrome.tabs.onRemoved.addListener((tab) => {
  if (!active.delete(tab)) return;
  void save();
  if (active.size === 0) disconnect();
});
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (!active.has(id) || !info.url) return;
  void load().then((config) => {
    if (!site(info.url, config)) return set(tab, false);
  });
});

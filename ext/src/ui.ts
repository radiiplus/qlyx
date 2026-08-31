import type { BrowserJobSummary } from './browser-session';

export type LogEntry = {
  id: string;
  at: string;
  level: 'info' | 'warn' | 'error';
  source: string;
  event: string;
  detail: string;
};

export type ActivityItem = {
  id: string;
  tab: number;
  action: string;
  target: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  startedAt: string;
  updatedAt: string;
  detail?: string;
  result?: string;
};

export type PromptScenario = {
  id: string;
  name: string;
  description: string;
};

export type Workspace = {
  version: 1;
  id: string;
  name: string;
  root: string;
  active: boolean;
  createdAt: string;
  registeredAt: string;
  lastUsedAt: string;
};

export type BrowserTabTrace = {
  page: string;
  url: string;
  title: string;
  status: string;
  active: boolean;
  lifecycle: 'opening' | 'ready' | 'navigating' | 'error';
  openedAt: string;
  updatedAt: string;
  error?: string;
};

export type BridgeState = {
  activities: ActivityItem[];
  browserJobs: BrowserJobSummary[];
  browserTabs: BrowserTabTrace[];
  current: string;
  currentStartedAt: string;
  agent: boolean;
  authorizedAt: string;
  conversation: string;
  dom: {
    assistant: boolean;
    chat: boolean;
    composer: boolean;
    observer: boolean;
  };
  enabled: boolean;
  endpoint: string;
  error: string;
  executionPaused: boolean;
  host: string;
  latency: number | null;
  limit: number;
  logs: LogEntry[];
  payload: number;
  pending: number;
  pendingExecutions: Array<{
    action: string;
    id: string;
    queuedAt: string;
    target: string;
  }>;
  pendingResponses: Array<{
    action: string;
    id: string;
    ok: boolean;
    queuedAt: string;
    ref: string;
  }>;
  prepared: boolean;
  processed: number;
  queuedExecutions: number;
  queuedResponses: number;
  responsePaused: boolean;
  scenario: string;
  scenarios: PromptScenario[];
  personal: string;
  workspace: string;
  workspaces: Workspace[];
  server: 'connected' | 'connecting' | 'offline';
  session: 'active' | 'ended' | 'none';
  sessions: number;
  status: string;
  supported: boolean;
  title: string;
  version: string;
};

export type View = 'control' | 'activity' | 'browser' | 'diagnostics' | 'session' | 'settings';

export type Preferences = {
  autoFollow: boolean;
  density: 'compact' | 'comfortable';
  lastView: View;
};

export type PrimaryAction = {
  danger: boolean;
  disabled: boolean;
  kind: string;
  label: string;
};

export const providerNames: Record<string, string> = {
  'chatgpt.com': 'ChatGPT',
  'chat.openai.com': 'ChatGPT',
  'claude.ai': 'Claude',
  'gemini.google.com': 'Gemini',
  'chat.deepseek.com': 'DeepSeek',
  'chat.qwen.ai': 'Qwen',
  'kimi.ai': 'Kimi',
  'www.kimi.ai': 'Kimi',
  'kimi.com': 'Kimi',
  'www.kimi.com': 'Kimi',
  'kimi.moonshot.cn': 'Kimi',
};

const preferenceKey = 'uiPreferences';
const defaults: Preferences = {
  autoFollow: true,
  density: 'compact',
  lastView: 'control',
};

export function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing Qlyx UI element: ${id}`);
  return node as T;
}

export function providerName(state: Pick<BridgeState, 'host' | 'supported'>): string {
  return providerNames[state.host] || (state.supported ? state.host : 'Current tab');
}

export function readiness(state: BridgeState): {
  detail: string;
  label: string;
  tone: 'ready' | 'active' | 'attention' | 'error' | 'offline';
} {
  if (state.session === 'ended') {
    return { detail: 'The authorized conversation changed.', label: 'Attention', tone: 'error' };
  }
  if (state.error) return { detail: state.error, label: 'Attention', tone: 'error' };
  if (state.server === 'offline') {
    return { detail: 'The local bridge is unavailable.', label: 'Offline', tone: 'offline' };
  }
  if (state.server === 'connecting') {
    return { detail: 'Connecting to the local bridge.', label: 'Connecting', tone: 'attention' };
  }
  if (!state.workspaces.some((workspace) => workspace.active)) {
    return { detail: 'Initialize a project with qlyx init.', label: 'No workspace', tone: 'attention' };
  }
  if (state.executionPaused) {
    return {
      detail: `Execution is paused${state.queuedExecutions ? ` with ${state.queuedExecutions} queued` : ''}.`,
      label: 'Paused',
      tone: 'attention',
    };
  }
  if (state.responsePaused) {
    return {
      detail: `Response delivery is paused${state.queuedResponses ? ` with ${state.queuedResponses} pending` : ''}.`,
      label: 'Paused',
      tone: 'attention',
    };
  }
  if (state.pending > 0) {
    return { detail: `${state.pending} local operation${state.pending === 1 ? '' : 's'} in progress.`, label: 'Active', tone: 'active' };
  }
  if (state.enabled && state.session === 'active') {
    return { detail: 'Bridge connected and monitoring this conversation.', label: 'Ready', tone: 'ready' };
  }
  if (!state.supported) {
    return { detail: 'Open a supported AI conversation.', label: 'Attention', tone: 'attention' };
  }
  return { detail: 'Conversation detected; monitoring is stopped.', label: 'Attention', tone: 'attention' };
}

export function primaryAction(state: BridgeState, busy = false): PrimaryAction {
  if (busy) return { kind: '', label: 'Working...', disabled: true, danger: false };
  if (state.server === 'connecting') {
    return { kind: '', label: 'Connecting to local server', disabled: true, danger: false };
  }
  if (state.server === 'offline') {
    return { kind: 'popup:probe', label: 'Check local server', disabled: false, danger: false };
  }
  if (!state.workspaces.some((workspace) => workspace.active)) {
    return { kind: '', label: 'No active workspace', disabled: true, danger: false };
  }
  if (!state.supported) {
    return { kind: '', label: 'Open a supported chat', disabled: true, danger: false };
  }
  if (state.session === 'ended') {
    return { kind: 'popup:reset', label: 'Re-authorize conversation', disabled: false, danger: false };
  }
  if (state.session === 'none') {
    return { kind: '', label: 'Open an existing conversation', disabled: true, danger: false };
  }
  if (!state.prepared) {
    return { kind: 'popup:setup', label: 'Prepare this chat', disabled: false, danger: false };
  }
  if (state.enabled) {
    return { kind: 'popup:toggle', label: 'Stop monitoring', disabled: false, danger: true };
  }
  return { kind: 'popup:toggle', label: 'Start monitoring', disabled: false, danger: false };
}

export async function requestState(
  input: string | { kind: string; personal?: string; workspace?: string } = 'popup:status',
): Promise<BridgeState> {
  const message = typeof input === 'string' ? { kind: input } : input;
  const state = await chrome.runtime.sendMessage(message) as Partial<BridgeState> | undefined;
  if (!state || !['connected', 'connecting', 'offline'].includes(state.server || '')) {
    throw new Error(state?.error || 'The extension worker did not return a status.');
  }
  return {
    activities: [],
    agent: true,
    authorizedAt: '',
    browserJobs: [],
    browserTabs: [],
    conversation: '',
    current: 'Idle',
    currentStartedAt: '',
    dom: { assistant: false, chat: false, composer: false, observer: false },
    endpoint: '-',
    error: '',
    executionPaused: false,
    host: '',
    latency: null,
    limit: 0,
    logs: [],
    payload: 0,
    pending: 0,
    pendingExecutions: [],
    pendingResponses: [],
    prepared: false,
    processed: 0,
    queuedExecutions: 0,
    queuedResponses: 0,
    responsePaused: false,
    scenario: 'adaptive',
    scenarios: [],
    personal: '',
    workspace: '',
    workspaces: [],
    sessions: 0,
    status: '-',
    supported: false,
    title: 'Current tab',
    version: chrome.runtime.getManifest().version,
    ...state,
  } as BridgeState;
}

export function elapsed(startedAt: string): string {
  const stamp = Date.parse(startedAt);
  if (!Number.isFinite(stamp)) return '--:--';
  const seconds = Math.max(0, Math.floor((Date.now() - stamp) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function relativeTime(at: string): string {
  const stamp = Date.parse(at);
  if (!Number.isFinite(stamp)) return '-';
  const seconds = Math.max(0, Math.floor((Date.now() - stamp) / 1000));
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(stamp).toLocaleDateString();
}

export function clockTime(at: string, seconds = false): string {
  const stamp = Date.parse(at);
  if (!Number.isFinite(stamp)) return '-';
  return new Date(stamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  });
}

export async function readPreferences(): Promise<Preferences> {
  try {
    const stored = await chrome.storage.local.get(preferenceKey);
    const value = stored[preferenceKey] as Partial<Preferences> | undefined;
    const lastView = value?.lastView && ['control', 'activity', 'browser', 'diagnostics', 'session', 'settings'].includes(value.lastView)
      ? value.lastView : defaults.lastView;
    return {
      autoFollow: typeof value?.autoFollow === 'boolean' ? value.autoFollow : defaults.autoFollow,
      density: value?.density === 'comfortable' ? 'comfortable' : defaults.density,
      lastView,
    };
  } catch {
    return { ...defaults };
  }
}

export async function writePreferences(preferences: Preferences): Promise<void> {
  await chrome.storage.local.set({ [preferenceKey]: preferences });
}

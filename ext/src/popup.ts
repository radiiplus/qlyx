import { ArrowRight, ExternalLink, History, PanelRightOpen, Pause, Play, Shield, createIcons } from 'lucide';
import {
  element,
  primaryAction,
  providerName,
  readiness,
  requestState,
  type BridgeState,
} from './ui.ts';

const icons = { ArrowRight, ExternalLink, History, PanelRightOpen, Pause, Play, Shield };

const extensionVersion = element<HTMLSpanElement>('extension-version');
const readinessNode = element<HTMLDivElement>('readiness');
const readinessLabel = element<HTMLElement>('readiness-label');
const serverLatency = element<HTMLSpanElement>('server-latency');
const providerMark = element<HTMLDivElement>('provider-mark');
const providerLabel = element<HTMLElement>('provider-name');
const conversationState = element<HTMLSpanElement>('conversation-state');
const monitorState = element<HTMLSpanElement>('monitor-state');
const monitorToggle = element<HTMLButtonElement>('monitor-toggle');
const accessNotice = element<HTMLDivElement>('access-notice');
const executionControl = element<HTMLButtonElement>('execution-control');
const executionControlLabel = element<HTMLElement>('execution-control-label');
const executionQueueCount = element<HTMLElement>('execution-queue-count');
const responseControl = element<HTMLButtonElement>('response-control');
const responseControlLabel = element<HTMLElement>('response-control-label');
const responseQueueCount = element<HTMLElement>('response-queue-count');
const primaryButton = element<HTMLButtonElement>('primary-action');
const continueSession = element<HTMLButtonElement>('continue-session');
const errorMessage = element<HTMLParagraphElement>('error-message');
const runningCount = element<HTMLElement>('running-count');
const pendingCount = element<HTMLElement>('pending-count');
const responseCount = element<HTMLElement>('response-count');
const failedCount = element<HTMLElement>('failed-count');
const currentOperation = element<HTMLParagraphElement>('current-operation');
const openButtons = [
  element<HTMLButtonElement>('open-panel-icon'),
  element<HTMLButtonElement>('open-panel'),
];
const openPageButton = element<HTMLButtonElement>('open-page-icon');

let latest: BridgeState | undefined;
let busy = false;
let transientError = '';
let panelWindowId: number = chrome.windows.WINDOW_ID_CURRENT;

function panelLog(event: string, detail: Record<string, unknown> = {}): void {
  console.info(`[Qlyx sidebar] ${event}`, detail);
  void chrome.runtime.sendMessage({
    kind: 'ui:log',
    level: 'info',
    source: 'popup',
    event: `sidebar.${event.replaceAll(' ', '.')}`,
    detail: JSON.stringify(detail),
  }).catch(() => undefined);
}

function panelError(event: string, error: unknown): void {
  console.error(`[Qlyx sidebar] ${event}`, error);
  void chrome.runtime.sendMessage({
    kind: 'ui:log',
    level: 'error',
    source: 'popup',
    event: `sidebar.${event.replaceAll(' ', '.')}`,
    detail: error instanceof Error ? error.message : String(error),
  }).catch(() => undefined);
}

function hydrateIcons(): void {
  createIcons({ icons, attrs: { 'stroke-width': 1.8 } });
}

function renderFlowControl(
  button: HTMLButtonElement,
  label: HTMLElement,
  paused: boolean,
  count: number,
  subject: string,
): void {
  const icon = document.createElement('i');
  icon.dataset.lucide = paused ? 'play' : 'pause';
  icon.setAttribute('aria-hidden', 'true');
  button.querySelector('svg, i')?.replaceWith(icon);
  label.textContent = `${paused ? 'Resume' : 'Pause'} ${subject}`;
  button.title = `${paused ? 'Resume' : 'Pause'} ${subject === 'execution' ? 'local execution' : 'response delivery'}`;
  button.classList.toggle('is-paused', paused);
  button.setAttribute('aria-pressed', String(paused));
  button.disabled = busy;
  const counter = subject === 'execution' ? executionQueueCount : responseQueueCount;
  counter.textContent = String(count);
}

function render(state: BridgeState): void {
  latest = state;
  const ready = readiness(state);
  const provider = providerName(state);
  const action = primaryAction(state, busy);
  const failed = state.activities.filter((item) => item.status === 'failed').length;
  const running = state.activities.filter((item) => item.status === 'running').length;

  extensionVersion.textContent = `v${state.version}`;
  readinessNode.className = `state state-${ready.tone}`;
  readinessLabel.textContent = ready.label;
  serverLatency.textContent = state.latency === null ? '-' : `${state.latency} ms`;
  providerMark.textContent = provider === 'Current tab' ? '-' : provider.slice(0, 2).toUpperCase();
  providerLabel.textContent = provider;
  conversationState.textContent = state.session === 'ended'
    ? 'Conversation changed'
    : state.session === 'active' ? state.enabled ? 'Conversation locked' : 'Conversation detected'
      : 'No conversation authorized';
  monitorState.textContent = state.enabled ? 'Active for this conversation' : 'Disabled';
  monitorToggle.classList.toggle('is-on', state.enabled);
  monitorToggle.setAttribute('aria-checked', String(state.enabled));
  monitorToggle.disabled = busy || !state.supported || state.session !== 'active' || state.server !== 'connected';

  accessNotice.classList.toggle('is-muted', !state.enabled);
  accessNotice.querySelector('span')!.textContent = state.enabled
    ? 'Agent can execute commands and modify local files'
    : 'Local access disabled';

  primaryButton.textContent = action.label;
  primaryButton.dataset.kind = action.kind;
  primaryButton.disabled = action.disabled;
  primaryButton.classList.toggle('is-danger', action.danger);
  continueSession.disabled = busy || !state.supported
    || state.session !== 'active' || state.server !== 'connected';
  renderFlowControl(executionControl, executionControlLabel, state.executionPaused, state.queuedExecutions, 'execution');
  renderFlowControl(responseControl, responseControlLabel, state.responsePaused, state.queuedResponses, 'responses');
  runningCount.textContent = String(Math.max(running, state.pending));
  pendingCount.textContent = String(state.queuedExecutions);
  responseCount.textContent = String(state.queuedResponses);
  failedCount.textContent = String(failed);
  currentOperation.textContent = state.current || 'Idle';
  currentOperation.title = state.current || 'Idle';

  const error = transientError || state.error;
  errorMessage.textContent = error;
  errorMessage.hidden = !error;
  hydrateIcons();
}

async function update(kind = 'popup:status'): Promise<void> {
  try {
    const state = await requestState(kind);
    transientError = state.error || (kind === 'popup:status' ? transientError : '');
    render(state);
  } catch (error) {
    transientError = (error as Error).message;
    errorMessage.textContent = transientError;
    errorMessage.hidden = false;
  }
}

async function perform(kind: string): Promise<void> {
  if (busy || !kind) return;
  busy = true;
  if (latest) render(latest);
  await update(kind);
  busy = false;
  if (latest) render(latest);
}

function fullPageUrl(): string {
  const url = new URL(chrome.runtime.getURL('sidepanel.html'));
  url.searchParams.set('surface', 'page');
  if (latest?.tab !== null && latest?.tab !== undefined) {
    url.searchParams.set('tab', String(latest.tab));
  }
  return url.href;
}

async function openFullPage(trigger: string): Promise<void> {
  const url = fullPageUrl();
  panelLog('page requested', { trigger, targetTab: latest?.tab ?? null });
  try {
    await chrome.tabs.create({ url });
    panelLog('page succeeded', { trigger, targetTab: latest?.tab ?? null });
    window.close();
  } catch (error) {
    transientError = `Could not open Control Center: ${(error as Error).message}`;
    panelError('page rejected', error);
    errorMessage.textContent = transientError;
    errorMessage.hidden = false;
  }
}

function openControlCenter(event: MouseEvent): void {
  const trigger = event.currentTarget as HTMLButtonElement;
  const windowId = panelWindowId;
  panelLog('open clicked', {
    trigger: trigger.id,
    windowId,
    sidePanelAvailable: Boolean(chrome.sidePanel?.open),
  });

  if (!chrome.sidePanel?.open) {
    void openFullPage(`${trigger.id}:fallback`);
    return;
  }

  panelLog('open requested', { path: 'sidepanel.html', windowId });
  try {
    void chrome.sidePanel.open({ windowId }).then(() => {
      panelLog('open succeeded', { windowId });
      window.close();
    }).catch((error: Error) => {
      panelError('open rejected', error);
      void openFullPage(`${trigger.id}:rejected`);
    });
  } catch (error) {
    panelError('open threw', error);
    void openFullPage(`${trigger.id}:threw`);
  }
}

for (const button of openButtons) button.addEventListener('click', openControlCenter);
openPageButton.addEventListener('click', () => void openFullPage(openPageButton.id));
monitorToggle.addEventListener('click', () => perform('popup:toggle'));
primaryButton.addEventListener('click', () => perform(primaryButton.dataset.kind || ''));
continueSession.addEventListener('click', () => perform('popup:continue'));
executionControl.addEventListener('click', () => perform('popup:toggle-execution'));
responseControl.addEventListener('click', () => perform('popup:toggle-responses'));

hydrateIcons();
panelLog('popup ready', {
  chromeVersionMinimum: 116,
  path: 'sidepanel.html',
  sidePanelAvailable: Boolean(chrome.sidePanel?.open),
});
void chrome.windows.getCurrent().then((currentWindow) => {
  if (currentWindow.id !== undefined) panelWindowId = currentWindow.id;
  panelLog('window resolved', { windowId: panelWindowId });
}).catch((error: Error) => {
  panelError('window resolution failed; using current-window constant', error);
});
if (chrome.sidePanel?.setOptions) {
  void chrome.sidePanel.setOptions({ enabled: true, path: 'sidepanel.html' }).then(() => {
    panelLog('global configuration ready', { path: 'sidepanel.html' });
  }).catch((error: Error) => {
    panelError('global configuration failed', error);
  });
} else {
  element<HTMLButtonElement>('open-panel-icon').hidden = true;
  element<HTMLButtonElement>('open-panel').querySelector('span')!.textContent = 'Open full page';
  panelLog('page fallback ready', { path: 'sidepanel.html' });
}
void update().then(() => update('popup:probe'));
chrome.runtime.onMessage.addListener((message: { kind?: string }) => {
  if (message.kind === 'metrics:changed' && !busy) void update();
  return false;
});
const refresh = setInterval(() => { if (!busy) void update(); }, 2000);
window.addEventListener('unload', () => clearInterval(refresh));

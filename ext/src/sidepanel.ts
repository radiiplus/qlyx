import {
  Activity,
  Ban,
  Bug,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  Command,
  Copy,
  FilePenLine,
  FilePlus2,
  FileSearch,
  FileText,
  Filter,
  Globe2,
  History,
  Link,
  ListTree,
  LoaderCircle,
  Lock,
  MessagesSquare,
  Pause,
  PanelsTopLeft,
  Play,
  Power,
  RefreshCw,
  Route,
  Send,
  Settings2,
  Shield,
  SlidersHorizontal,
  Timer,
  Trash2,
  TriangleAlert,
  createIcons,
} from "lucide";
import type { BrowserJobEvent, BrowserJobStatus, BrowserJobSummary } from "./browser-session";
import {
  clockTime,
  elapsed,
  element,
  primaryAction,
  providerName,
  readPreferences,
  readiness,
  relativeTime,
  requestState,
  writePreferences,
  type ActivityItem,
  type BrowserTabTrace,
  type BridgeState,
  type LogEntry,
  type Preferences,
  type View,
} from "./ui";

type ActivityFilter = "all" | "pending" | "running" | "completed" | "failed";

const icons = {
  Activity,
  Ban,
  Bug,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  Command,
  Copy,
  FilePenLine,
  FilePlus2,
  FileSearch,
  FileText,
  Filter,
  Globe2,
  History,
  Link,
  ListTree,
  LoaderCircle,
  Lock,
  MessagesSquare,
  Pause,
  PanelsTopLeft,
  Play,
  Power,
  RefreshCw,
  Route,
  Send,
  Settings2,
  Shield,
  SlidersHorizontal,
  Timer,
  Trash2,
  TriangleAlert,
};

let state: BridgeState | undefined;
let preferences: Preferences = {
  autoFollow: true,
  density: "comfortable",
  lastView: "control",
};
let activeView: View = "control";
let activityFilter: ActivityFilter = "all";
let busy = false;
let logSnapshot: LogEntry[] = [];
let logsPaused = false;
let errorsOnly = false;
let initialized = false;
let previousPending = 0;
let actionError = '';
const expandedOperations = new Set<string>();
const expandedBrowserJobs = new Set<string>();

const views: View[] = ["control", "activity", "browser", "diagnostics", "session", "settings"];

function hydrateIcons(): void {
  createIcons({ icons, attrs: { "aria-hidden": "true", "stroke-width": 1.8 } });
}

function setText(id: string, value: string): void {
  element<HTMLElement>(id).textContent = value;
}

function setTone(node: HTMLElement, tone: string): void {
  node.dataset.tone = tone;
}

function renderFlowButton(id: string, paused: boolean, count: number, subject: 'execution' | 'responses'): void {
  const button = element<HTMLButtonElement>(id);
  const icon = document.createElement('i');
  icon.dataset.lucide = paused ? 'play' : 'pause';
  icon.setAttribute('aria-hidden', 'true');
  button.querySelector('svg, i')?.replaceWith(icon);
  setText(`${subject === 'execution' ? 'execution' : 'response'}-control-label`, `${paused ? 'Resume' : 'Pause'} ${subject}`);
  setText(`${subject === 'execution' ? 'execution' : 'response'}-control-detail`, `${count} ${subject === 'execution' ? 'queued' : 'pending'}`);
  button.classList.toggle('is-paused', paused);
  button.setAttribute('aria-pressed', String(paused));
  button.disabled = busy;
}

function renderPendingResponses(next: BridgeState): void {
  setText('pending-response-count', String(next.queuedResponses));
  const list = element<HTMLElement>('pending-response-list');
  list.replaceChildren();
  if (next.pendingResponses.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'pending-empty';
    empty.textContent = 'No responses are waiting.';
    list.append(empty);
    return;
  }
  for (const item of next.pendingResponses) {
    const row = document.createElement('div');
    row.className = 'pending-response-row';
    const action = document.createElement('strong');
    action.textContent = operationLabel(item.action);
    const ref = document.createElement('code');
    ref.textContent = item.ref;
    ref.title = item.id;
    const queued = document.createElement('time');
    queued.dateTime = item.queuedAt;
    queued.textContent = relativeTime(item.queuedAt);
    row.append(action, ref, queued);
    list.append(row);
  }
}

function selectView(view: View, persist = true): void {
  activeView = view;
  for (const candidate of views) {
    element<HTMLElement>(`view-${candidate}`).hidden = candidate !== view;
    const button = element<HTMLButtonElement>(`nav-${candidate}`);
    const selected = candidate === view;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-current", selected ? "page" : "false");
  }

  if (persist && initialized && preferences.lastView !== view) {
    preferences = { ...preferences, lastView: view };
    void writePreferences(preferences);
  }
}

function renderGlobal(next: BridgeState): void {
  const ready = readiness(next);
  const statusButton = element<HTMLButtonElement>("global-status");
  setTone(statusButton, ready.tone);
  setText("global-status-label", ready.label);
  setText("status-popover-title", ready.label);
  setText("status-popover-copy", ready.detail);
  setText("status-server", next.server === "connected" ? "Connected" : next.server === "connecting" ? "Connecting" : "Offline");
  setText(
    "status-chat",
    next.session === "ended" ? "Changed" : next.session === "active" ? (next.enabled ? "Locked" : "Detected") : "None",
  );
  setText("status-monitor", next.enabled ? "Active" : "Stopped");

  const safety = element<HTMLElement>("persistent-safety");
  safety.classList.toggle("is-muted", !next.enabled);
  setText("safety-title", next.executionPaused ? "Local execution paused" : next.enabled ? "Local access enabled" : "Local access disabled");
  setText(
    "safety-copy",
    next.executionPaused
      ? `${next.queuedExecutions} operation${next.queuedExecutions === 1 ? '' : 's'} waiting for resume.`
      : next.enabled
      ? "The authorized agent can modify files and execute commands on this machine."
      : "Monitoring is stopped. The agent cannot dispatch local operations.",
  );
}

function renderControl(next: BridgeState): void {
  const ready = readiness(next);
  const readinessNode = element<HTMLElement>("control-readiness");
  setTone(readinessNode, ready.tone);
  setText("control-ready-label", ready.label);
  setText("control-ready-detail", ready.detail);
  setText("control-server", next.server === "connected" ? "Connected" : next.server === "connecting" ? "Connecting" : "Offline");
  setText(
    "control-conversation",
    next.session === "ended" ? "Changed" : next.session === "active" ? (next.enabled ? "Locked" : "Detected") : "None",
  );
  setText("control-monitor", next.executionPaused ? "Execution paused" : next.enabled ? "Active" : "Stopped");

  const hasSession = next.session !== "none";
  const provider = providerName(next);
  setText("control-provider", !hasSession || provider === "Current tab" ? "-" : provider.slice(0, 2).toUpperCase());
  element<HTMLElement>("control-provider").title = provider;
  const title = hasSession ? next.title || "Untitled conversation" : "No conversation detected";
  setText("control-title", title);
  element<HTMLElement>("control-title").title = title;
  setText(
    "control-lock",
    next.session === "ended" ? "Authorization expired" : next.enabled ? "Authorized to this conversation" : "Not authorized",
  );
  element<HTMLElement>("control-session").classList.toggle("is-empty", !hasSession);

  const monitoring = element<HTMLInputElement>("control-monitoring");
  monitoring.checked = next.enabled;
  monitoring.disabled = busy || !next.supported || next.session !== "active" || next.server !== "connected";

  const action = primaryAction(next);
  const primary = element<HTMLButtonElement>("control-primary");
  primary.dataset.action = action.kind;
  primary.disabled = busy || action.disabled;
  primary.classList.toggle("is-danger", action.danger);
  setText("control-primary-label", busy ? "Working..." : action.label);

  renderFlowButton('execution-control', next.executionPaused, next.queuedExecutions, 'execution');
  renderFlowButton('response-control', next.responsePaused, next.queuedResponses, 'responses');
  setText('flow-total-count', `${next.queuedExecutions + next.queuedResponses} pending`);
  renderPendingResponses(next);

  setText("metric-running", String(next.pending));
  setText("metric-queued", String(next.queuedExecutions));
  setText("metric-responses", String(next.queuedResponses));
  setText("metric-failed", String(next.activities.filter((item) => item.status === "failed").length));

  const current = element<HTMLElement>("control-current");
  current.hidden = next.pending + next.queuedExecutions === 0 || next.current === "Idle";
  if (!current.hidden) {
    setText("current-operation", next.current);
    element<HTMLElement>("current-operation").title = next.current;
    setText("current-elapsed", elapsed(next.currentStartedAt));
  }
}

function operationLabel(operation: string): string {
  const labels: Record<string, string> = {
    cancel: "Cancel",
    create: "Create",
    delete: "Delete",
    edit: "Edit",
    exec: "Execute",
    list: "List",
    read: "Read",
    status: "Status",
  };
  return labels[operation] || operation
    .replace(/^browser_/, '')
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function operationIcon(operation: string): string {
  const iconNames: Record<string, string> = {
    cancel: "circle-x",
    create: "file-plus-2",
    delete: "trash-2",
    edit: "file-pen-line",
    exec: "command",
    list: "file-search",
    read: "file-text",
    status: "timer",
  };
  return iconNames[operation] || "activity";
}

function operationTarget(item: ActivityItem): string {
  return item.target || (item.action === "status" ? "Bridge status" : "Local operation");
}

function statusIcon(status: ActivityItem["status"]): string {
  if (status === "queued") return "circle-alert";
  if (status === "running") return "loader-circle";
  if (status === "succeeded") return "circle-check";
  return "circle-x";
}

function operationTime(item: ActivityItem): string {
  if (item.status === "running") return elapsed(item.startedAt);
  return relativeTime(item.updatedAt || item.startedAt);
}

function detailRow(label: string, value: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "operation-detail-row";
  const key = document.createElement("span");
  key.textContent = label;
  const content = document.createElement("code");
  content.textContent = value;
  content.title = value;
  row.append(key, content);
  return row;
}

function operationRow(item: ActivityItem): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "operation-row";
  row.dataset.status = item.status;
  row.dataset.expanded = String(expandedOperations.has(item.id));

  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "operation-summary";
  summary.setAttribute("aria-expanded", String(expandedOperations.has(item.id)));
  summary.setAttribute("aria-label", `${operationLabel(item.action)} ${operationTarget(item)}`);

  const stateIcon = document.createElement("span");
  stateIcon.className = `operation-state ${item.status === "running" ? "is-spinning" : ""}`;
  stateIcon.innerHTML = `<i data-lucide="${statusIcon(item.status)}"></i>`;

  const operationIconNode = document.createElement("span");
  operationIconNode.className = "operation-kind";
  operationIconNode.innerHTML = `<i data-lucide="${operationIcon(item.action)}"></i>`;

  const copy = document.createElement("span");
  copy.className = "operation-copy";
  const name = document.createElement("strong");
  name.textContent = operationLabel(item.action);
  const target = document.createElement("code");
  target.textContent = operationTarget(item);
  target.title = operationTarget(item);
  copy.append(name, target);

  const timing = document.createElement("time");
  timing.textContent = operationTime(item);
  timing.dateTime = new Date(item.updatedAt || item.startedAt).toISOString();

  const chevron = document.createElement("i");
  chevron.dataset.lucide = "chevron-down";
  chevron.className = "operation-chevron";
  summary.append(stateIcon, operationIconNode, copy, timing, chevron);

  const details = document.createElement("div");
  details.className = "operation-details";
  details.hidden = !expandedOperations.has(item.id);
  details.append(detailRow("Command ID", item.id));
  if (item.detail) details.append(detailRow("Request", item.detail));

  const lifecycle = document.createElement("div");
  lifecycle.className = "operation-lifecycle";
  const lifecycleSteps: Array<[string, "complete" | "active" | "pending" | "failed"]> = [
    ["Detected", "complete"],
    ["Queued", item.status === "queued" ? "active" : "complete"],
    ["Running", item.status === "queued" ? "pending" : item.status === "running" ? "active" : "complete"],
    [item.status === "failed" ? "Failed" : "Completed", item.status === "failed" ? "failed" : item.status === "succeeded" ? "complete" : "pending"],
  ];
  for (const [label, stepState] of lifecycleSteps) {
    const step = document.createElement("span");
    step.className = `is-${stepState}`;
    step.textContent = label;
    lifecycle.append(step);
  }
  details.append(lifecycle);

  if (item.result) {
    const result = document.createElement("details");
    result.className = "operation-result";
    const resultSummary = document.createElement("summary");
    resultSummary.textContent = "View result";
    const output = document.createElement("pre");
    output.textContent = item.result;
    result.append(resultSummary, output);
    details.append(result);
  }

  summary.addEventListener("click", () => {
    const expanded = !expandedOperations.has(item.id);
    if (expanded) expandedOperations.add(item.id);
    else expandedOperations.delete(item.id);
    row.dataset.expanded = String(expanded);
    summary.setAttribute("aria-expanded", String(expanded));
    details.hidden = !expanded;
  });

  row.append(summary, details);
  return row;
}

function emptyState(title: string, copy: string): HTMLDivElement {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = copy;
  empty.append(heading, paragraph);
  return empty;
}

function renderActivity(next: BridgeState): void {
  const feed = element<HTMLElement>("activity-feed");
  feed.replaceChildren();

  const queued: ActivityItem[] = next.pendingExecutions.map((item) => ({
    action: item.action,
    detail: "Waiting for local execution to resume",
    id: item.id,
    startedAt: item.queuedAt,
    status: "queued",
    tab: 0,
    target: item.target,
    updatedAt: item.queuedAt,
  }));
  const filtered = [...queued, ...next.activities].filter((item) => {
    if (activityFilter === "all") return true;
    if (activityFilter === "pending") return item.status === "queued";
    if (activityFilter === "completed") return item.status === "succeeded";
    return item.status === activityFilter;
  });

  if (!filtered.length) {
    feed.append(
      emptyState(
        activityFilter === "all" ? "No operations yet" : `No ${activityFilter} operations`,
        activityFilter === "all"
          ? "Agent operations will appear here when monitoring begins."
          : "Choose another filter to inspect the operation feed.",
      ),
    );
    return;
  }

  const groups: Array<[string, ActivityItem[]]> = [
    ["Pending", filtered.filter((item) => item.status === "queued")],
    ["Running", filtered.filter((item) => item.status === "running")],
    ["Failed", filtered.filter((item) => item.status === "failed")],
    ["Completed", filtered.filter((item) => item.status === "succeeded")],
  ];

  for (const [label, items] of groups) {
    if (!items.length) continue;
    const section = document.createElement("section");
    section.className = "activity-group";
    const heading = document.createElement("div");
    heading.className = "group-heading";
    heading.innerHTML = `<span>${label}</span><span>${items.length}</span>`;
    section.append(heading, ...items.map(operationRow));
    feed.append(section);
  }
}

function browserStatusIcon(status: BrowserJobStatus): string {
  if (status === 'queued') return 'timer';
  if (status === 'running') return 'loader-circle';
  if (status === 'completed') return 'circle-check';
  if (status === 'cancelled') return 'ban';
  return 'circle-x';
}

function browserUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return value || 'No URL';
  }
}

function browserTabRow(tab: BrowserTabTrace): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'browser-tab-row';
  row.dataset.status = tab.lifecycle;

  const icon = document.createElement('span');
  icon.className = `browser-trace-icon ${tab.lifecycle === 'opening' || tab.lifecycle === 'navigating' ? 'is-spinning' : ''}`;
  const iconNode = document.createElement('i');
  iconNode.dataset.lucide = tab.lifecycle === 'error' ? 'circle-x'
    : tab.lifecycle === 'opening' || tab.lifecycle === 'navigating' ? 'loader-circle' : 'globe-2';
  icon.append(iconNode);

  const copy = document.createElement('div');
  copy.className = 'browser-tab-copy';
  const heading = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = tab.page;
  const state = document.createElement('span');
  state.className = 'browser-state';
  state.textContent = tab.active ? 'Focused' : tab.lifecycle;
  heading.append(name, state);
  const title = document.createElement('span');
  title.textContent = tab.title || browserUrl(tab.url);
  title.title = tab.title || tab.url;
  const url = document.createElement('code');
  url.textContent = browserUrl(tab.url);
  url.title = tab.url;
  copy.append(heading, title, url);
  if (tab.error) {
    const error = document.createElement('small');
    error.className = 'browser-tab-error';
    error.textContent = tab.error;
    copy.append(error);
  }

  const updated = document.createElement('time');
  updated.dateTime = tab.updatedAt;
  updated.textContent = relativeTime(tab.updatedAt);
  row.append(icon, copy, updated);
  return row;
}

function browserEventLabel(event: BrowserJobEvent): string {
  return event.type.split('.').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function browserEventRow(event: BrowserJobEvent): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'browser-event-row';
  row.dataset.status = event.type.endsWith('failed') ? 'failed'
    : event.type.endsWith('cancelled') ? 'cancelled'
      : event.type.endsWith('completed') ? 'completed' : 'running';
  const sequence = document.createElement('span');
  sequence.className = 'browser-event-sequence';
  sequence.textContent = String(event.sequence);
  const copy = document.createElement('div');
  const label = document.createElement('strong');
  label.textContent = browserEventLabel(event);
  const detail = document.createElement('small');
  detail.textContent = event.error
    ? `${event.error.code} · ${event.error.message}`
    : [event.page, event.operation].filter(Boolean).join(' · ') || event.job;
  detail.title = detail.textContent;
  copy.append(label, detail);
  const time = document.createElement('time');
  time.dateTime = event.at;
  time.textContent = clockTime(event.at, true);
  row.append(sequence, copy, time);
  return row;
}

function browserJobRow(job: BrowserJobSummary): HTMLDivElement {
  const expanded = expandedBrowserJobs.has(job.job);
  const row = document.createElement('div');
  row.className = 'browser-job-row';
  row.dataset.status = job.status;
  row.dataset.expanded = String(expanded);

  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'browser-job-summary';
  summary.setAttribute('aria-expanded', String(expanded));
  summary.setAttribute('aria-label', `${job.job} browser job, ${job.status}`);
  const state = document.createElement('span');
  state.className = `browser-job-state ${job.status === 'running' ? 'is-spinning' : ''}`;
  const stateIcon = document.createElement('i');
  stateIcon.dataset.lucide = browserStatusIcon(job.status);
  state.append(stateIcon);
  const kind = document.createElement('span');
  kind.className = 'browser-job-kind';
  const kindIcon = document.createElement('i');
  kindIcon.dataset.lucide = 'list-tree';
  kind.append(kindIcon);
  const copy = document.createElement('span');
  copy.className = 'browser-job-copy';
  const name = document.createElement('strong');
  name.textContent = job.job;
  const counts = document.createElement('code');
  counts.textContent = `${job.counts.completed}/${job.counts.total} completed · ${job.status}`;
  copy.append(name, counts);
  const updated = document.createElement('time');
  updated.dateTime = job.updatedAt;
  updated.textContent = job.status === 'running' ? elapsed(job.createdAt) : relativeTime(job.updatedAt);
  const chevron = document.createElement('i');
  chevron.dataset.lucide = 'chevron-down';
  chevron.className = 'browser-job-chevron';
  summary.append(state, kind, copy, updated, chevron);

  const details = document.createElement('div');
  details.className = 'browser-job-details';
  details.hidden = !expanded;
  const operations = document.createElement('div');
  operations.className = 'browser-operation-list';
  for (const operation of job.operations) {
    const operationRow = document.createElement('div');
    operationRow.className = 'browser-operation-row';
    operationRow.dataset.status = operation.status;
    const operationState = document.createElement('span');
    const operationIcon = document.createElement('i');
    operationIcon.dataset.lucide = browserStatusIcon(operation.status);
    operationState.className = operation.status === 'running' ? 'is-spinning' : '';
    operationState.append(operationIcon);
    const operationCopy = document.createElement('div');
    const operationName = document.createElement('strong');
    operationName.textContent = operationLabel(operation.action);
    const operationTarget = document.createElement('code');
    operationTarget.textContent = [operation.page, operation.id].filter(Boolean).join(' · ');
    operationTarget.title = operation.error?.message || operationTarget.textContent;
    operationCopy.append(operationName, operationTarget);
    const operationStatus = document.createElement('span');
    operationStatus.textContent = operation.status;
    operationRow.append(operationState, operationCopy, operationStatus);
    operations.append(operationRow);
  }
  details.append(operations);
  if (job.events.length > 0) {
    const heading = document.createElement('div');
    heading.className = 'browser-event-heading';
    const title = document.createElement('span');
    title.textContent = 'Recent events';
    const count = document.createElement('span');
    count.textContent = `${job.events.length} of ${job.page.total}`;
    heading.append(title, count);
    const events = document.createElement('div');
    events.className = 'browser-event-list';
    events.append(...job.events.slice().reverse().map(browserEventRow));
    details.append(heading, events);
  }

  summary.addEventListener('click', () => {
    const next = !expandedBrowserJobs.has(job.job);
    if (next) expandedBrowserJobs.add(job.job);
    else expandedBrowserJobs.delete(job.job);
    row.dataset.expanded = String(next);
    summary.setAttribute('aria-expanded', String(next));
    details.hidden = !next;
  });
  row.append(summary, details);
  return row;
}

function renderBrowser(next: BridgeState): void {
  const activeJobs = next.browserJobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const failedJobs = next.browserJobs.filter((job) => job.status === 'failed').length;
  setText('browser-tab-count', String(next.browserTabs.length));
  setText('browser-running-count', String(activeJobs));
  setText('browser-failed-count', String(failedJobs));
  setText('browser-tabs-label', `${next.browserTabs.length} open`);
  setText('browser-jobs-label', `${next.browserJobs.length} job${next.browserJobs.length === 1 ? '' : 's'}`);

  const tabs = element<HTMLElement>('browser-tab-list');
  tabs.replaceChildren();
  if (next.browserTabs.length === 0) tabs.append(emptyState('No managed tabs', 'No logical browser tabs are active.'));
  else tabs.append(...next.browserTabs.map(browserTabRow));

  const jobs = element<HTMLElement>('browser-job-list');
  jobs.replaceChildren();
  if (next.browserJobs.length === 0) jobs.append(emptyState('No browser jobs', 'No asynchronous browser jobs are recorded.'));
  else jobs.append(...next.browserJobs.map(browserJobRow));
}

function diagnosticValue(id: string, value: string, tone = "neutral"): void {
  const node = element<HTMLElement>(id);
  node.textContent = value;
  setTone(node, tone);
}

function renderDiagnostics(next: BridgeState): void {
  diagnosticValue("diag-websocket", next.server === "connected" ? "Connected" : next.server === "connecting" ? "Connecting" : "Offline", next.server === "connected" ? "success" : "muted");
  diagnosticValue("diag-latency", next.latency === null ? "-" : `${next.latency} ms`, next.latency === null ? "muted" : "neutral");
  diagnosticValue("diag-chat", next.dom.chat ? "Detected" : "Not detected", next.dom.chat ? "success" : "muted");
  diagnosticValue("diag-composer", next.dom.composer ? "Detected" : "Unavailable", next.dom.composer ? "success" : "warning");
  diagnosticValue("diag-response", next.dom.assistant ? "Detected" : "Waiting", next.dom.assistant ? "success" : "muted");
  diagnosticValue("diag-observer", next.dom.observer ? "Active" : "Stopped", next.dom.observer ? "success" : "muted");

  const detected = next.logs.filter((entry) => entry.event === "operation.detected").length || next.activities.length;
  const delivered = next.logs.filter((entry) => entry.event === "reply.delivered").length;
  setText("diag-detected", String(detected));
  setText("diag-executed", String(next.processed));
  setText("diag-delivered", String(delivered));

  if (!logsPaused) logSnapshot = [...next.logs];
  const source = errorsOnly ? logSnapshot.filter((entry) => entry.level === "error") : logSnapshot;
  const stream = element<HTMLElement>("diagnostic-logs");
  stream.replaceChildren();
  if (!source.length) {
    stream.append(emptyState("No diagnostic events", "Connection and DOM events will appear here."));
  } else {
    for (const entry of source.slice().reverse()) {
      const row = document.createElement("div");
      row.className = "log-row";
      row.dataset.level = entry.level;
      const time = document.createElement("time");
      time.textContent = clockTime(entry.at, true);
      const level = document.createElement("span");
      level.textContent = entry.level.toUpperCase();
      const message = document.createElement("span");
      message.className = "log-message";
      const event = document.createElement("strong");
      event.textContent = entry.event.replaceAll(".", " ");
      const detail = document.createElement("small");
      detail.textContent = entry.detail || entry.source;
      message.title = `${entry.source}: ${entry.detail}`;
      message.append(event, detail);
      row.append(time, level, message);
      stream.append(row);
    }
  }

  element<HTMLButtonElement>("logs-pause").classList.toggle("is-active", logsPaused);
  element<HTMLButtonElement>("logs-filter").classList.toggle("is-active", errorsOnly);
  element<HTMLButtonElement>("logs-pause").title = logsPaused ? "Resume logs" : "Pause logs";
}

function renderSession(next: BridgeState): void {
  const workspace = element<HTMLSelectElement>('session-workspace');
  const workspaceMenu = next.workspaces.filter((item) => item.active);
  const workspaceSignature = workspaceMenu.map((item) => `${item.id}:${item.name}`).join('|');
  if (workspace.dataset.signature !== workspaceSignature) {
    workspace.replaceChildren(...(workspaceMenu.length > 0 ? workspaceMenu : [{
      id: '',
      name: 'No active workspace',
      root: '',
      active: false,
      version: 1 as const,
      createdAt: '',
      registeredAt: '',
      lastUsedAt: '',
    }]).map((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      return option;
    }));
    workspace.dataset.signature = workspaceSignature;
  }
  workspace.value = workspaceMenu.some((item) => item.id === next.workspace)
    ? next.workspace : workspaceMenu[0]?.id || '';
  const selectedWorkspace = workspaceMenu.find((item) => item.id === workspace.value);
  setText('session-workspace-root', selectedWorkspace?.root || 'Run qlyx init in a project.');
  element<HTMLElement>('session-workspace-root').title = selectedWorkspace?.root || '';
  workspace.disabled = busy || next.server !== 'connected' || next.enabled || workspaceMenu.length === 0;
  element<HTMLButtonElement>('session-workspace-stop').disabled = busy
    || next.server !== 'connected' || !selectedWorkspace;

  const modeNames = next.scenarios.map((item) => item.name);
  setText('session-mode-description', modeNames.length > 0
    ? modeNames.join(', ')
    : 'Agent-controlled mode selection');
  const personal = element<HTMLTextAreaElement>('session-personal');
  if (document.activeElement !== personal) personal.value = next.personal;
  const promptUnavailable = busy || next.server !== 'connected' || !selectedWorkspace;
  personal.disabled = promptUnavailable;

  const hasSession = next.session !== 'none';
  const setup = element<HTMLButtonElement>('session-setup');
  const canSetup = next.server === 'connected' && next.supported
    && next.session === 'active' && Boolean(selectedWorkspace);
  setup.disabled = busy || !canSetup || next.prepared;
  setup.classList.toggle('is-complete', next.prepared);
  setText(
    'session-setup-label',
    busy ? 'Setting up chat session...'
      : next.prepared ? 'Chat session set up'
        : 'Set up chat session',
  );
  setText(
    'session-setup-note',
    next.server !== 'connected' ? 'Connect the local bridge before setting up this chat.'
      : !selectedWorkspace ? 'Run qlyx init in a project before setup.'
      : !next.supported ? 'Open a supported AI conversation first.'
        : next.session === 'none' ? 'Open an existing conversation before setup.'
          : next.session === 'ended' ? 'The conversation changed. Re-authorize it from Control first.'
            : next.prepared ? 'The Qlyx setup prompt was sent to this conversation.'
              : 'Sends the Qlyx setup prompt to this conversation.',
  );
  element<HTMLElement>("session-details").hidden = !hasSession;
  element<HTMLElement>("session-empty").hidden = hasSession;
  if (!hasSession) return;

  const provider = providerName(next);
  setText("session-provider", provider === "Current tab" ? "-" : provider.slice(0, 2).toUpperCase());
  element<HTMLElement>("session-provider").title = provider;
  setText("session-provider-name", provider);
  setText("session-title", next.title || "Untitled conversation");
  element<HTMLElement>("session-title").title = next.title || "Untitled conversation";
  setText("session-status", next.enabled ? "Locked" : "Detected");
  setText("session-identity", next.conversation || "–");
  setText("session-monitoring", next.enabled ? "Active" : "Stopped");
  setText("session-authorized", next.authorizedAt ? clockTime(next.authorizedAt) : "–");
  setText("session-context", ".agent/context.md");

  const changed = next.session === "ended";
  element<HTMLElement>("session-warning").hidden = !changed;
  element<HTMLElement>("session-lock-summary").classList.toggle("is-locked", next.enabled);
  const sessionUnavailable = busy || next.server !== "connected" || next.session !== "active";
  element<HTMLButtonElement>("session-continue").disabled = sessionUnavailable;
  element<HTMLButtonElement>("session-check").disabled = sessionUnavailable;
}

function renderSettings(next: BridgeState): void {
  setText("settings-endpoint", next.endpoint);
  setText("settings-version", next.version || "–");
  setText("settings-agent", next.agent ? "Enabled" : "Disabled");
  setText("settings-limit", String(next.limit || "–"));
  setText("settings-payload", next.payload ? `${Math.round(next.payload / 1024)} KB` : "–");

  element<HTMLInputElement>("settings-auto-follow").checked = preferences.autoFollow;
  const resultDelivery = element<HTMLInputElement>("settings-result-delivery");
  resultDelivery.checked = !next.responsePaused;
  resultDelivery.disabled = busy;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-density]")) {
    const selected = button.dataset.density === preferences.density;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  document.documentElement.dataset.density = preferences.density;
}

function render(next: BridgeState): void {
  const totalPending = next.pending + next.queuedExecutions;
  if (initialized && preferences.autoFollow && previousPending === 0 && totalPending > 0) {
    selectView("activity");
  }
  previousPending = totalPending;
  state = next;

  renderGlobal(next);
  renderControl(next);
  renderActivity(next);
  renderBrowser(next);
  renderDiagnostics(next);
  renderSession(next);
  renderSettings(next);

  const activityBadge = element<HTMLElement>("activity-badge");
  activityBadge.hidden = totalPending === 0;
  activityBadge.textContent = String(totalPending);
  const browserBadge = element<HTMLElement>('browser-badge');
  const activeBrowserJobs = next.browserJobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const browserBadgeCount = activeBrowserJobs || next.browserTabs.length;
  browserBadge.hidden = browserBadgeCount === 0;
  browserBadge.textContent = browserBadgeCount > 9 ? '9+' : String(browserBadgeCount);
  const diagnosticBadge = element<HTMLElement>("diagnostic-badge");
  const errors = next.logs.filter((entry) => entry.level === "error").length;
  diagnosticBadge.hidden = errors === 0;
  diagnosticBadge.textContent = String(errors);
  hydrateIcons();
}

async function refresh(): Promise<void> {
  try {
    const next = await requestState("popup:get");
    render(actionError && !next.error ? { ...next, error: actionError } : next);
  } catch (error) {
    console.error("[Qlyx sidebar] state refresh failed", error);
    setText("global-status-label", "Error");
    setText("status-popover-title", "Extension error");
    setText("status-popover-copy", error instanceof Error ? error.message : String(error));
    setTone(element<HTMLElement>("global-status"), "danger");
  }
}

async function perform(
  input: string | { kind: string; personal?: string; workspace?: string },
): Promise<void> {
  if (busy) return;
  busy = true;
  if (state) render(state);
  try {
    const next = await requestState(input);
    actionError = next.error;
    render(next);
  } catch (error) {
    actionError = error instanceof Error ? error.message : String(error);
    if (state) render({ ...state, error: actionError });
  } finally {
    busy = false;
    if (state) render(state);
  }
}

function promptRequest(kind: 'popup:setup' | 'popup:continue' | 'popup:set-prompts'): {
  kind: string;
  personal: string;
  workspace: string;
} {
  return {
    kind,
    personal: element<HTMLTextAreaElement>('session-personal').value,
    workspace: element<HTMLSelectElement>('session-workspace').value,
  };
}

function wireInteractions(): void {
  for (const view of views) {
    element<HTMLButtonElement>(`nav-${view}`).addEventListener("click", () => selectView(view));
  }

  element<HTMLButtonElement>("global-status").addEventListener("click", () => {
    const popover = element<HTMLElement>("status-popover");
    popover.hidden = !popover.hidden;
  });
  document.addEventListener("click", (event) => {
    const popover = element<HTMLElement>("status-popover");
    if (!popover.hidden && event.target instanceof Element && !event.target.closest(".status-cluster")) popover.hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") element<HTMLElement>("status-popover").hidden = true;
  });

  element<HTMLInputElement>("control-monitoring").addEventListener("change", () => void perform("popup:toggle"));
  element<HTMLButtonElement>("control-primary").addEventListener("click", () => {
    const kind = element<HTMLButtonElement>("control-primary").dataset.action;
    if (kind) void perform(kind);
  });
  element<HTMLButtonElement>('session-setup').addEventListener('click', () => void perform(promptRequest('popup:setup')));
  element<HTMLButtonElement>('execution-control').addEventListener('click', () => void perform('popup:toggle-execution'));
  element<HTMLButtonElement>('response-control').addEventListener('click', () => void perform('popup:toggle-responses'));
  element<HTMLButtonElement>("session-continue").addEventListener("click", () => void perform(promptRequest('popup:continue')));
  element<HTMLSelectElement>('session-workspace').addEventListener('change', () => {
    void perform({
      kind: 'popup:set-workspace',
      workspace: element<HTMLSelectElement>('session-workspace').value,
    });
  });
  element<HTMLButtonElement>('session-workspace-stop').addEventListener('click', () => {
    const select = element<HTMLSelectElement>('session-workspace');
    const name = select.selectedOptions[0]?.textContent || 'this workspace';
    if (window.confirm(`Stop ${name}? Existing monitored conversations for it will be disconnected.`)) {
      void perform({ kind: 'popup:stop-workspace', workspace: select.value });
    }
  });
  element<HTMLTextAreaElement>('session-personal').addEventListener('blur', () => {
    void perform(promptRequest('popup:set-prompts'));
  });
  element<HTMLButtonElement>("session-check").addEventListener("click", () => void perform("popup:test"));
  element<HTMLButtonElement>("settings-check").addEventListener("click", () => void perform("popup:probe"));

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-activity-filter]")) {
    button.addEventListener("click", () => {
      activityFilter = (button.dataset.activityFilter || "all") as ActivityFilter;
      for (const candidate of document.querySelectorAll<HTMLButtonElement>("[data-activity-filter]")) {
        candidate.classList.toggle("is-active", candidate === button);
      }
      if (state) {
        renderActivity(state);
        hydrateIcons();
      }
    });
  }

  element<HTMLButtonElement>("logs-pause").addEventListener("click", () => {
    logsPaused = !logsPaused;
    element<HTMLButtonElement>("logs-pause").setAttribute("aria-pressed", String(logsPaused));
    if (state) renderDiagnostics(state);
    hydrateIcons();
  });
  element<HTMLButtonElement>("logs-filter").addEventListener("click", () => {
    errorsOnly = !errorsOnly;
    element<HTMLButtonElement>("logs-filter").setAttribute("aria-pressed", String(errorsOnly));
    if (state) renderDiagnostics(state);
    hydrateIcons();
  });
  element<HTMLButtonElement>("logs-copy").addEventListener("click", async () => {
    const source = errorsOnly ? logSnapshot.filter((entry) => entry.level === "error") : logSnapshot;
    const content = source
      .map((entry) => `${clockTime(entry.at, true)} ${entry.level.toUpperCase()} ${entry.source}.${entry.event} ${entry.detail}`)
      .join("\n");
    await navigator.clipboard.writeText(content);
  });
  element<HTMLButtonElement>("logs-clear").addEventListener("click", () => void perform("popup:clear-logs"));

  element<HTMLInputElement>("settings-auto-follow").addEventListener("change", (event) => {
    preferences = { ...preferences, autoFollow: (event.target as HTMLInputElement).checked };
    void writePreferences(preferences);
  });
  element<HTMLInputElement>('settings-result-delivery').addEventListener('change', (event) => {
    const deliver = (event.target as HTMLInputElement).checked;
    if (state && deliver === state.responsePaused) void perform('popup:toggle-responses');
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-density]")) {
    button.addEventListener("click", () => {
      preferences = {
        ...preferences,
        density: button.dataset.density === "compact" ? "compact" : "comfortable",
      };
      void writePreferences(preferences);
      if (state) renderSettings(state);
    });
  }
}

async function start(): Promise<void> {
  console.info("[Qlyx sidebar] control center starting", { path: window.location.pathname });
  wireInteractions();
  preferences = await readPreferences();
  selectView(preferences.lastView, false);
  initialized = true;
  hydrateIcons();
  await refresh();
  await perform('popup:workspaces');
  await perform('popup:prompts');
  console.info("[Qlyx sidebar] control center ready", { view: activeView });
  window.setInterval(() => void refresh(), 1500);
}

void start().catch((error) => {
  console.error("[Qlyx sidebar] control center failed to start", error);
});

import { language } from './style.js';

const rows = (text, kind = 'text', extra = {}) => String(text ?? '').split('\n').map(text => ({ text, kind, ...extra }));
const label = key => key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, char => char.toUpperCase());
const ignored = new Set(['digest', 'hash']);
export function fields(value, depth = 0) {
  if (depth > 12) return rows('  '.repeat(depth) + '[Further nested fields omitted]', 'muted');
  if (value === null || typeof value !== 'object') return rows(value === null ? 'none' : value);
  if (Array.isArray(value)) return value.length ? value.flatMap(item => fields(item, depth + 1).map(row => ({ ...row, text: '  • ' + row.text }))) : rows('  (empty)', 'muted');
  return Object.entries(value).filter(([key]) => !ignored.has(key)).flatMap(([key, item]) => {
    const prefix = '  '.repeat(depth) + label(key);
    if (item !== null && typeof item === 'object') return [...rows(prefix, 'muted'), ...fields(item, depth + 1)];
    if (typeof item === 'string' && item.includes('\n')) return [...rows(prefix, 'muted'), ...rows(item)];
    return rows(`${prefix}: ${item === null ? 'none' : item}`, key === 'error' || key === 'reason' ? 'error' : 'text');
  });
}
export function markdown(value) {
  const output = [];
  let fence, name = '';
  for (const text of String(value ?? '').split('\n')) {
    const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(text);
    if (match && !fence) { fence = match[1]; name = match[2].trim().split(/\s/)[0]; output.push(...rows(name || 'Code', 'muted')); continue; }
    if (match && fence && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) { fence = undefined; continue; }
    output.push(...rows(fence ? text : text.replace(/^#{1,6}\s+/, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'), fence ? 'code' : 'text', fence ? { language: name } : {}));
  }
  return output;
}
export function input(event) {
  const args = event.arguments || {};
  if (event.tool === 'local.run') {
    const command = [args.command, ...(Array.isArray(args.args) ? args.args : []).map(value => /\s|["'`$;&|<>]/.test(value) ? JSON.stringify(value) : value)].join(' ');
    return [...rows('$ ' + command, 'command'), ...fields(Object.fromEntries(Object.entries(args).filter(([key]) => !['command', 'args'].includes(key))))];
  }
  return Object.entries(args).flatMap(([key, value]) => {
    if (['content', 'before', 'after'].includes(key) && typeof value === 'string') return [...rows(label(key), 'muted'), ...rows(value, key === 'before' ? 'removed' : key === 'after' ? 'added' : 'code', { language: language(args.file) })];
    return fields({ [key]: value });
  });
}
export function result(event, { captured = false } = {}) {
  let data = event.content;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { return markdown(data); } }
  if (!data || typeof data !== 'object') return markdown(data === null ? 'No output.' : String(data ?? 'No output.'));
  const output = [], used = new Set(['digest', 'hash', 'duration', 'truncated', 'omitted', 'captured']);
  const take = (...keys) => keys.forEach(key => used.add(key));
  if (Array.isArray(data.entries)) {
    take('directory', 'entries');
    output.push(...rows(`Directory: ${data.directory || '.'}`, 'muted'));
    output.push(...data.entries.flatMap(entry => typeof entry === 'string' ? rows('  ' + entry) : rows('  ' + (entry.name || '(unnamed)') + (entry.type === 'directory' ? '/' : entry.type === 'link' ? ' (link)' : ''))));
    if (!data.entries.length) output.push(...rows('  (empty)', 'muted'));
  }
  if (typeof data.content === 'string' && (data.file || event.tool === 'local.read')) {
    take('file', 'content', 'start', 'total');
    const file = data.file || event.arguments?.file || '';
    output.push(...rows(`File: ${file}${data.start ? ' · from line ' + data.start : ''}`, 'muted'), ...rows(data.content, 'code', { language: language(file) }));
  }
  for (const stream of ['stdout', 'stderr']) if (typeof data[stream] === 'string') {
    take(stream);
    if (!captured && data[stream]) output.push(...rows(stream, 'muted'), ...rows(data[stream].replace(/\n$/, ''), stream === 'stderr' ? 'error' : 'text'));
  }
  for (const key of ['text', 'message', 'content']) if (!used.has(key) && typeof data[key] === 'string') { take(key); output.push(...markdown(data[key])); }
  if (typeof data.code === 'number') { take('code'); output.push(...rows(`Exit code: ${data.code}`, data.code ? 'error' : 'success')); }
  if (data.signal) { take('signal'); output.push(...rows(`Terminated by signal: ${data.signal}`, 'error')); }
  output.push(...fields(Object.fromEntries(Object.entries(data).filter(([key, value]) => !used.has(key) && value !== null))));
  if (data.truncated && !captured) output.push(...rows('Saved result is an excerpt.', 'muted'));
  if (data.omitted) output.push(...rows(`Capture limit: ${data.omitted} characters were not retained.`, 'error'));
  return output.length ? output : rows(captured ? 'Captured output shown above.' : 'No output.', 'muted');
}
/** A batch's stated purpose and its plan at the time it was proposed. */
export function batch(event) {
  const plan = (event.milestones || []).map(index => `${index}. ${event.plan?.[index - 1] || '(unavailable)'}`).join(' · ');
  return [
    ...rows(event.summary),
    ...rows('Why', 'muted'), ...rows(event.why),
    ...rows('Plan', 'muted'), ...rows(plan || 'Direct contribution to the task · no milestones recorded'),
    ...rows('Contribution', 'muted'), ...rows(event.contribution),
    ...rows('Parallel', 'muted'), ...rows(event.parallel),
  ];
}
export function record(event) {
  const time = new Date(event.time).toLocaleTimeString();
  let running = false;
  if (event.type === 'result') { try { running = JSON.parse(event.content).status === 'running'; } catch {} }
  const names = { intent: 'you', tool: 'tool', result: running ? 'background' : event.error ? 'failed' : 'completed', pending: 'waiting', failure: 'failed', cancelled: 'cancelled', complete: event.status || 'complete' };
  const heading = rows(`${time} · ${names[event.type] || event.type}${event.id ? ' [' + event.id + ']' : ''}`, ['failure', 'cancelled'].includes(event.type) || event.error ? 'error' : event.type === 'result' && !running || event.type === 'complete' ? 'success' : 'heading');
  let content;
  switch (event.type) {
    case 'batch': content = [...rows(`${event.count} proposed actions`, 'muted'), ...batch(event)]; break;
    case 'tool': content = [...rows(`SERVER ${event.tool.split('.')[0]} · TOOL ${event.tool}`, 'muted'), ...rows(event.summary), ...(typeof event.batch === 'string' ? rows('Batch: ' + event.batch, 'muted') : []), ...rows('INPUT', 'muted'), ...input(event)]; break;
    case 'result': content = [...rows(`Duration: ${((event.elapsed || 0) / 1000).toFixed(2)}s`, 'muted'), ...result(event)]; break;
    case 'session': content = [...rows('Session connected', 'success'), ...rows(`Workspace: ${event.root || 'current'}`, 'muted')]; break;
    case 'reconnect': content = rows(event.message || 'Reconnecting to the model provider and validating authentication.', 'attention'); break;
    case 'pending': content = rows(`Waiting for model · step ${event.step ?? '?'}`, 'muted'); break;
    case 'output': content = [...rows(event.stream || 'stdout', 'muted'), ...rows(event.text, event.stream === 'stderr' ? 'error' : 'text')]; break;
    case 'change': content = [...rows(`${event.file} · +${event.added} −${event.removed}`, 'muted'), ...(event.lines || []).flatMap(line => rows(line.text, line.kind === 'added' ? 'added' : line.kind === 'removed' ? 'removed' : 'context', { language: language(event.file) })), ...rows(`/diff ${event.id || ''} for the captured change`, 'muted')]; break;
    case 'job': content = [...rows(`Task ${event.job} · ${event.status}`, event.status === 'running' ? 'muted' : event.status === 'complete' ? 'success' : 'error'), ...result({ content: Object.fromEntries(Object.entries(event).filter(([key]) => !['type', 'time', 'id', 'tool', 'job', 'status'].includes(key))) })]; break;
    case 'capture': content = rows(`Capture limit: ${event.omitted} characters were not retained.`, 'error'); break;
    case 'failure': case 'cancelled': content = [...rows(event.message || 'No failure reason was recorded.', 'error'), ...(event.checkpoint ? rows('Checkpoint: ' + event.checkpoint, 'muted') : [])]; break;
    default: content = event.message ? markdown(event.message) : fields(Object.fromEntries(Object.entries(event).filter(([key]) => !['type', 'id', 'time'].includes(key))));
  }
  return [...heading, ...content, ...rows('')];
}

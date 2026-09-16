import { stripVTControlCharacters as strip } from 'node:util';
import { format } from './format.js';
import { syntax, shell, language } from './style.js';
import { result as document, record, batch } from './document.js';

export const clean = text => strip(String(text ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
export const command = args => [args?.command, ...(Array.isArray(args?.args) ? args.args : []).map(value => /\s|["'`$;&|<>]/.test(value) ? JSON.stringify(value) : value)].map(value => clean(value)).join(' ');
export const category = event => /\.(write|edit)$/.test(event.tool) ? 'CHANGE' : /\.(open|view|click|fill|press)$/.test(event.tool) ? 'BROWSER' : event.tool === 'local.run' ? (/test|check|lint|build|verif/i.test(command(event.arguments) + ' ' + event.summary) ? 'VERIFY' : 'RUN') : /\.(read|list|search|browse|web)$/.test(event.tool) ? 'EXPLORE' : 'TOOL';
const decode = content => { try { const value = JSON.parse(content); return value && typeof value === 'object' ? value : { text: content }; } catch { return { text: content }; } };
const target = event => event.tool === 'local.run' ? command(event.arguments) : event.arguments?.file || event.arguments?.url || event.arguments?.query || event.arguments?.directory || event.tool;
const seconds = value => `${((value || 0) / 1000).toFixed(2)}s`;

/** A compact evidence timeline backed by a durable, independently inspectable journal. */
export function activity({ output = process.stdout, plain = !output.isTTY, status = () => {}, redact = text => text, palette = {} } = {}) {
  const colors = { context: 6, action: 4, attention: 3, success: 2, failure: 1, user: 5, muted: 8, ...palette };
  for (const value of Object.values(colors)) if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('Palette values must be terminal color numbers from 0 to 255.');
  const color = !plain && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb';
  const shade = (role, value) => color ? `\x1b[${'38;5;' + colors[role]}m${value}\x1b[0m` : value;
  const text = value => clean(redact(String(value ?? '')));
  const write = value => output.write(value);
  const excerpt = value => value.length > 300 ? value.slice(0, 300) + ' … [line clipped; inspect output]' : value;
  let book, active, lines = [], changed = false, start = 0;
  const ongoing = new Map();
  function attach(value) { book = value; active = undefined; ongoing.clear(); }
  function detail(value, limit = 8) {
    const rows = text(value).replace(/\n$/, '').split('\n');
    for (const line of rows.slice(0, limit)) write(shade('muted', '    │ ' + excerpt(line)) + '\n');
    if (rows.length > limit) write(shade('muted', `    · ${rows.length - limit} lines hidden · Ctrl+T transcript`) + '\n');
  }
  function row(label, value = '', symbol = '◆', role = 'action') {
    write(`\n  ${shade(role === 'user' ? 'muted' : role === 'failure' || role === 'attention' ? role : 'muted', symbol + ' ' + label.toLowerCase())}${value ? shade('muted', '  ' + text(value)) : ''}\n`);
  }
  function header({ root, mode, kind }) {
    write(shade('muted', `  QLYX · ${text(kind || 'coding')} · ${text(mode)} · ${text(root)}`) + '\n');
  }
  function intent(message) { book?.append({ type: 'intent', message }); row('YOU', '', '→', 'user'); write(text(message) + '\n'); }
  function notify(event) {
    if (event.type === 'plan') return;
    if (book) event = book.append(event);
    const execution = ongoing.get(event.id);
    if (execution && ['output', 'change', 'capture', 'result'].includes(event.type)) {
      active = execution.event; lines = execution.lines; changed = execution.changed; start = execution.start;
    }
    if (event.type === 'reconnect') { row('RECONNECTING', event.message, '↻', 'attention'); return; }
    if (event.type === 'skill') { row('SKILL', `${event.name} · saved globally`, '✦', 'success'); return; }
    if (event.type === 'pending' || event.type === 'status') return status(event.message || `QLYX · selecting step ${event.step}`);
    if (event.type === 'job') {
      if (event.status !== 'running') write(shade(event.status === 'complete' ? 'success' : 'attention', `  · Task ${text(event.job)} ${text(event.status)} · /tasks output ${text(event.job)}`) + '\n');
      return;
    }
    if (event.type === 'batch') {
      row(`batch · ${event.count} actions`, `[${event.id}]`);
      const plan = (event.milestones || []).map(index => `${index}. ${event.plan?.[index - 1] || '(unavailable)'}`).join(' · ');
      write('    ' + excerpt(text(event.summary).replace(/\s+/g, ' ')) + '\n');
      for (const [label, value] of [['why', event.why], ['plan', plan || 'Direct task contribution'], ['contribution', event.contribution], ['parallel', event.parallel]]) {
        write(shade('muted', '    ' + label + ' · ') + excerpt(text(value).replace(/\s+/g, ' ')) + '\n');
      }
      return;
    }
    if (event.type === 'session') return write(shade('muted', `  Session ${text(event.id)}`) + '\n');
    if (event.type === 'notice' || event.type === 'invalid') { row(event.type === 'invalid' ? 'ATTENTION' : 'CONTEXT', event.message, '!', 'attention'); return; }
    if (event.type === 'tool') {
      active = event; lines = []; changed = false; start = Date.now();
      row(category(event), event.id ? `[${event.id}]` : '', '◆', category(event) === 'EXPLORE' ? 'context' : 'action');
      detail(event.summary);
      write(event.tool === 'local.run' ? shade('muted', '    $ ') + shell(text(target(event)), { plain: !color }) + '\n' : shade('muted', '    · ' + text(target(event))) + '\n');
      status(`${category(event).toLowerCase()} · ${text(target(event))}`);
    }
    if (event.type === 'output') {
      const rows = text(event.text).replace(/\n$/, '').split('\n');
      for (const line of rows) { if (lines.length < 4) write(shade('muted', `    │ ${event.stream === 'stderr' ? 'stderr: ' : ''}${excerpt(line)}`) + '\n'); lines.push(line); }
      if (lines.length > 4) status(`${category(active || {}).toLowerCase()} · ${lines.length - 4} lines hidden · Ctrl+O output`);
    }
    if (event.type === 'capture') detail(`Capture limit reached; ${event.omitted} additional characters were not retained.`);
    if (event.type === 'change') {
      changed = true;
      write(`    ${shade('success', event.created ? 'Added' : 'Edited')} ${text(event.file)} (${shade('success', '+' + event.added)} ${shade('failure', '-' + event.removed)})\n`);
      for (const line of (event.lines || []).slice(0, 8)) {
        const prefix = `    ${String(line.number).padStart(4)} ${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '} `;
        write(shade('muted', prefix) + syntax(text(line.text).padEnd(Math.max(0, Math.min(output.columns || 80, 100) - prefix.length)), language(event.file), { plain: !color, kind: line.kind }) + '\n');
      }
      if (event.truncated || event.lines?.length > 8) detail(`Diff preview · /diff ${event.id || ''} for the captured change.`);
      if (event.newline) detail('Final newline changed.');
    }
    if (event.type === 'result') {
      status('');
      const result = decode(event.content);
      if (event.tool === 'local.run') {
        if (!lines.length) detail([result.stdout, result.stderr].filter(Boolean).join('\n') || '(no output)', 4);
        else if (lines.length > 4) {
          const count = Math.min(3, lines.length - 4);
          if (lines.length - 4 - count) detail(`${lines.length - 4 - count} lines hidden · /output ${event.id || ''}`);
          for (const line of lines.slice(-count)) write(shade('muted', `    │ ${excerpt(line)}`) + '\n');
        }
        write(`    ${shade(result.status === 'running' ? 'muted' : event.error ? 'failure' : 'success', result.status === 'running' ? `… task ${result.job} running · /tasks output ${result.job}` : `${event.error ? '×' : '✓'} exit ${result.code ?? 'unknown'}`)} · ${seconds(result.duration ?? event.elapsed ?? Date.now() - start)}\n`);
        if (result.reason || result.error) detail(result.reason || result.error);
        if (result.omitted) detail(`${result.omitted} characters beyond the capture limit were not retained.`);
        else if (result.truncated) detail(`Model received an excerpt · /output ${event.id || ''} retains the captured output.`);
      } else {
        if (!changed && event.tool === 'local.read' && typeof result.content === 'string') {
          const rows = text(result.content).split('\n');
          for (const line of rows.slice(0, 4)) write(shade('muted', '    │ ') + syntax(excerpt(line), language(event.arguments?.file), { plain: !color, kind: 'code' }) + '\n');
          if (rows.length > 4) detail(`${rows.length - 4} lines hidden · Ctrl+O output`);
        } else if (!changed) detail(result.content || result.text || result.error || result.stdout || (Array.isArray(result.entries) ? result.entries.map(entry => entry?.name).join('\n') : JSON.stringify(result)), 4);
        write(`    ${shade(event.error ? 'failure' : 'success', event.error ? '× tool failed' : changed ? '✓ write complete' : '✓ inspection complete')} · ${seconds(event.elapsed ?? Date.now() - start)}\n`);
      }
      ongoing.delete(event.id);
      const remaining = [...ongoing.values()].at(-1);
      active = remaining?.event;
      if (active) status(`${category(active).toLowerCase()} · ${text(target(active))}`);
    }
    if (event.type === 'tool') ongoing.set(event.id, { event, lines, changed, start });
    else if (execution && event.type !== 'result') { execution.lines = lines; execution.changed = changed; }
  }
  function answer(message) {
    status('');
    let rendered = '';
    const renderer = format({ output: { columns: output.columns, isTTY: output.isTTY, write: value => { rendered += value; } }, plain });
    renderer.write(text(message)); renderer.finish(); write(rendered + '\n');
  }
  function complete(result) {
    book?.append({ type: 'complete', status: result.status, message: result.message, learned: result.learned, limitations: result.limitations });
    if (result.status !== 'complete') row(result.status === 'question' ? 'QUESTION' : 'PAUSED', '', '?', 'attention');
    else write('\n');
    answer(result.message || `Run status: ${result.status}`);
  }
  function failure(message, cancelled = false, checkpoint) {
    book?.append({ type: cancelled ? 'cancelled' : 'failure', message, checkpoint });
    status(''); row(cancelled ? 'CANCELLED' : 'FAILURE', '', cancelled ? '!' : '×', 'failure');
    if (active) detail(`${category(active)} · ${target(active)}`);
    detail(message);
    if (message.includes('Qwen returned HTTP 403')) detail('Open chat.qwen.ai in the existing Chrome, complete verification, then use /session check.');
    if (checkpoint) detail(`Saved checkpoint: ${checkpoint}`);
    active = undefined; ongoing.clear();
  }
  function present(rows, rich) {
    return rows.flatMap(row => {
      if (typeof row === 'string') row = { text: row, kind: 'text' };
      return text(row.text).split('\n').map(line => rich ? { ...row, text: line } : line);
    });
  }
  function inspect(id, kind = 'output', { rich = false } = {}) {
    const entry = book?.get(id);
    if (!entry) return ['No captured execution yet.'];
    const events = book.entries.filter(event => event.id === entry.id);
    const heading = [`${category(entry)} [${entry.id}]`, target(entry), ''];
    const group = typeof entry.batch === 'string' ? book.entries.find(event => event.type === 'batch' && event.id === entry.batch) : undefined;
    if (kind === 'explain') return present([...heading, ...(group ? [{ text: `Batch [${group.id}]`, kind: 'heading' }, ...batch(group), ''] : []), 'Purpose', entry.summary, '', 'Explanation', entry.why || entry.summary, '', ...(entry.evidence || []), ...events.filter(event => event.type === 'result').flatMap(event => document({ ...event, arguments: event.arguments || entry.arguments }))], rich);
    if (kind === 'diff') {
      const event = events.find(event => event.type === 'change');
      if (!event) return [...heading, 'This execution has no captured file change.'];
      if (typeof event.before !== 'string') return [...heading, ...event.lines.map(line => `${line.kind === 'added' ? '+' : '-'} ${line.text}`), 'Only a legacy excerpt is available.'];
      const before = event.before === '' ? [] : event.before.replace(/\n$/, '').split('\n');
      const after = event.after === '' ? [] : event.after.replace(/\n$/, '').split('\n');
      let first = 0, last = 0;
      while (first < before.length && first < after.length && before[first] === after[first]) first++;
      while (last < before.length - first && last < after.length - first && before.at(-last - 1) === after.at(-last - 1)) last++;
      const begin = Math.max(0, first - 3), ending = Math.min(3, last);
      return [...heading, `--- ${event.file} (before)`, `+++ ${event.file} (after)`,
        `@@ -${begin + 1},${before.length - last - begin + ending} +${begin + 1},${after.length - last - begin + ending} @@`,
        ...before.slice(begin, first).map(line => '  ' + line), ...before.slice(first, before.length - last).map(line => '- ' + line),
        ...after.slice(first, after.length - last).map(line => '+ ' + line), ...after.slice(after.length - last, after.length - last + ending).map(line => '  ' + line),
        ...(event.before.endsWith('\n') !== event.after.endsWith('\n') ? ['Final newline changed.'] : [])];
    }
    const chunks = events.flatMap(event => event.type === 'output' ? [event] : event.type === 'job' ? ['stdout', 'stderr'].filter(stream => event[stream]).map(stream => ({ stream, text: event[stream] })) : []);
    const content = chunks.flatMap(event => [{ text: event.stream || 'stdout', kind: 'muted' }, ...text(event.text).replace(/\n$/, '').split('\n').map(text => ({ text, kind: event.stream === 'stderr' ? 'error' : 'text' }))]);
    const result = events.find(event => event.type === 'result');
    const job = events.findLast(event => event.type === 'job');
    const state = job?.status || (result ? decode(result.content).status : undefined);
    const latest = job && result ? { ...decode(result.content), ...Object.fromEntries(Object.entries(job).filter(([key]) => !['type', 'id', 'time', 'tool'].includes(key))), message: job.message || '' } : undefined;
    return present([...heading.map((text, index) => ({ text: index === 1 && entry.tool === 'local.run' ? '$ ' + text : text, kind: index === 1 && entry.tool === 'local.run' ? 'command' : 'heading' })), ...content,
      ...(result ? document({ ...result, ...(latest ? { content: latest } : {}), arguments: result.arguments || entry.arguments }, { captured: content.length > 0 }) : ['Waiting for output…']), '',
      result ? { text: `${state || (result.error ? 'Failed' : 'Completed')} · ${seconds(job?.duration ?? result.elapsed)}`, kind: state === 'running' ? 'muted' : result.error || state === 'failed' ? 'error' : 'success' } : 'No completed result saved yet.',
      ...events.filter(event => event.type === 'capture').map(event => `Capture limit: ${event.omitted} characters were not retained.`)], rich);
  }
  function transcript({ rich = false } = {}) {
    const tools = new Map();
    return present((book?.entries || []).flatMap(event => {
      if (event.type === 'tool') tools.set(event.id, event);
      return record({ ...event, arguments: event.arguments || tools.get(event.id)?.arguments });
    }), rich);
  }
  function tasks(id) {
    const entries = new Map();
    for (const event of book?.entries || []) {
      const data = event.type === 'result' ? decode(event.content) : event.type === 'job' ? event : {};
      if (data.job) entries.set(data.job, { ...entries.get(data.job), ...data, id: entries.get(data.job)?.id || event.id });
    }
    if (!entries.size) return ['No recorded background tasks.'];
    if (!id) return present([...entries.values()].map(job => ({ text: `${job.job} · ${job.status} · ${job.command || 'command'} · /tasks output ${job.job}`, kind: job.status === 'running' ? 'muted' : job.status === 'complete' ? 'success' : 'error' })), true);
    const matches = [...entries.entries()].filter(([key]) => key.startsWith(id));
    if (matches.length !== 1) return ['Task ID was not found or is ambiguous.'];
    return inspect(matches[0][1].id, 'output', { rich: true });
  }
  function executions() { return book?.list().map(event => `[${event.id}] ${category(event)} ${text(target(event))}\n    ${event.result ? `${event.result.error ? '×' : '✓'} ${decode(event.result.content).code ?? 'complete'} · ${seconds(event.result.elapsed)}` : '… no completed result saved'}`) || []; }
  function map() {
    const entries = book?.list() || [];
    return ['SESSION MAP', ...['EXPLORE','CHANGE','VERIFY','RUN','BROWSER','TOOL'].flatMap(label => [label, ...entries.filter(entry => category(entry) === label).map(entry => `  ${target(entry)} [${entry.id}] ${entry.result ? entry.result.error ? 'failed' : 'completed' : 'result unknown'}`)])];
  }
  return { attach, notify, answer, complete, failure, header, intent, inspect, transcript, executions, tasks, map, current: () => active, write: message => write(text(message)), detail };
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/** Durable UI evidence, separate from the model's bounded conversation context. */
export function journal({ root, name, directory, checkpoint, redact = text => text } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(name)) throw new Error('Invalid journal name.');
  directory ||= path.join(root, '.agent', 'journal');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(directory) !== directory) throw new Error('Journal directory must stay inside workspace memory.');
  const location = path.join(directory, `${name}.jsonl`);
  if (fs.existsSync(location) && !fs.lstatSync(location).isFile()) throw new Error('Journal must be a regular file.');
  const entries = [];
  if (fs.existsSync(location)) {
    const contents = fs.readFileSync(location, 'utf8');
    const lines = contents.split('\n');
    let damaged = false;
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index]) continue;
      try { entries.push(JSON.parse(lines[index])); }
      catch { if (index !== lines.length - 1) throw new Error('Journal contains a damaged event.'); damaged = true; }
    }
    // Remove an incomplete final append before accepting subsequent events.
    if (damaged) fs.truncateSync(location, Buffer.byteLength(contents.slice(0, contents.lastIndexOf('\n') + 1)));
    fs.chmodSync(location, 0o600);
  }
  let current;
  const running = new Map();
  function append(event) {
    if (event.type === 'tool') {
      current = { id: event.id || crypto.randomUUID().slice(0, 8), started: Date.now() };
      running.set(current.id, current);
    }
    const active = event.id ? running.get(event.id) : current;
    const value = JSON.parse(redact(JSON.stringify({ ...event, time: Date.now(), ...(active && ['tool','output','change','result','capture'].includes(event.type) ? { id: active.id, elapsed: Date.now() - active.started } : {}) })));
    fs.appendFileSync(location, JSON.stringify(value) + '\n', { mode: 0o600 });
    entries.push(value);
    if (event.type === 'result') { running.delete(value.id); if (current?.id === value.id) current = undefined; }
    if (event.type === 'cancelled' || event.type === 'failure') { current = undefined; running.clear(); }
    return value;
  }
  function list() {
    return entries.filter(event => event.type === 'tool').map(event => {
      const result = entries.findLast(item => item.id === event.id && item.type === 'result');
      return { ...event, result };
    });
  }
  function get(id) {
    const candidates = list();
    if (!id) return candidates.at(-1);
    const matches = candidates.filter(entry => entry.id.startsWith(id));
    if (matches.length !== 1) throw new Error(matches.length ? 'Execution ID is ambiguous.' : 'Execution was not found in this session.');
    return matches[0];
  }
  checkpoint ||= path.join(root, '.agent', `${name}.json`);
  if (!entries.length && fs.existsSync(checkpoint) && fs.lstatSync(checkpoint).isFile()) {
    const state = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
    append({ type: 'notice', message: 'Imported saved checkpoint evidence. Legacy tool results may contain only excerpts; missing output cannot be reconstructed.' });
    append({ type: 'intent', message: state.task });
    let action;
    for (const entry of state.history || []) {
      if (entry.role === 'assistant' && entry.content?.action === 'tool') {
        action = entry.content;
        append({ ...action, type: 'tool', legacy: true });
      } else if (entry.role === 'tool') append({ type: 'result', tool: entry.tool, arguments: action?.arguments, error: entry.error, content: entry.content, legacy: true });
      else if (entry.role === 'user') append({ type: 'intent', message: entry.content });
    }
    if (state.message) append({ type: 'complete', status: state.status, message: state.message, learned: state.learned, limitations: state.limitations });
  }
  return { location, entries, append, list, get };
}

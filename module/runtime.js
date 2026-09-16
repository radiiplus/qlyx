import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { create } from './client.js';
import { connect } from './session.js';
import { bridge } from './mcp.js';
import { run } from './agent.js';
import { chat } from './chat.js';
import { memory } from './memory.js';
import { database } from './database.js';
import { store } from './store.js';
import { skills } from './skills.js';

/** Shared execution engine for one-shot commands and the persistent chat UI. */
export async function runtime({ root = process.cwd(), resume, name, kind = 'agent', fresh = false, model, steps = 20, timeout = 180000,
  mcp, autonomous = false, passive = false, unattended = false, catalog, notify = () => {}, approve = async () => false } = {}) {
  if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error('Steps must be between 1 and 100.');
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 3600000) throw new Error('Timeout must be greater than zero and at most 3600 seconds.');
  root = await fs.realpath(root);
  const owned = !catalog;
  catalog ||= await database();
  const paths = store(root, { location: catalog.location });
  const notes = await memory(root, { directory: paths.runs, templates: paths.templates, location: catalog.location });
  try { await catalog.scan(root); } catch (error) { if (owned) catalog.close(); throw error; }
  if (resume === 'latest') resume = await notes.latest();
  if (kind === 'agent' && resume && !/^[a-f0-9-]{36}$/.test(resume)) throw new Error('Resume requires a local run ID.');
  const id = kind === 'agent' ? resume || name || crypto.randomUUID() : name || 'prompt';
  if (kind === 'agent' && !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Agent name must be a local run ID.');
  if (kind !== 'agent' && !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(id)) throw new Error('Chat name must use letters, numbers, or hyphens (up to 80 characters).');
  const location = path.join(kind === 'agent' ? paths.runs : paths.chats, `${id}.json`);
  if (resume) await fs.access(location);
  const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  const legacy = path.join(os.homedir(), '.qwen', 'chats', `${hash}-${id}.json`);
  let connection, session, controller, conversation, client, identity;
  let closed = false;
  let redact = text => text;
  function cancel() { controller?.abort(); void session?.close().catch(() => {}); void connection?.cancel(); }
  async function history() {
    try {
      if (await fs.realpath(path.dirname(location)) !== path.dirname(location) || !(await fs.lstat(location)).isFile()) throw new Error('Session history must be a regular file inside the central data directory.');
      return JSON.parse(await fs.readFile(location, 'utf8'));
    }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function access(signal) {
    try { client = await create({ timeout }); await client.check({ signal }); }
    catch (error) {
      if (error.status !== 401 || unattended) throw error;
      session = await connect({ log: message => notify({ type: 'notice', message }) });
      signal.throwIfAborted();
      await session.ensure();
      await session.close();
      session = undefined;
      signal.throwIfAborted();
      client = await create({ timeout });
      await client.check({ signal });
    }
    redact = client.redact;
    return client;
  }
  async function models({ signal } = {}) {
    if (closed || controller) throw new Error('Wait for the current turn before listing models.');
    controller = new AbortController();
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try { const client = await access(signal); return await client.models({ signal }); }
    finally { try { await session?.close(); } finally { session = undefined; controller = undefined; } }
  }
  async function validate({ signal } = {}) {
    if (closed || controller) throw new Error('Wait for the current turn before validating the session.');
    controller = new AbortController();
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try { const client = await access(signal); return await client.check({ signal }); }
    finally { try { await session?.close(); } finally { session = undefined; controller = undefined; } }
  }
  function select(value) {
    if (closed || controller) throw new Error('Wait for the current turn before changing model.');
    model = value;
  }
  async function send(task, { signal, receive } = {}) {
    if (closed || controller) throw new Error('Runtime is closed or already processing a turn.');
    controller = new AbortController();
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const previous = await history();
      if (kind === 'agent' && previous?.pending) throw new Error('A previous tool has an uncertain result. Inspect the workspace and start a new session; it will not be replayed automatically.');
      if (kind === 'agent' && previous?.status === 'complete' && !task) { await notes.save(previous); return previous; }
      signal.throwIfAborted();
      notify({ type: 'status', message: 'Connecting to Qwen' });
      client = await access(signal);
      if (kind === 'agent' && !connection) connection = await bridge({ root, config: mcp, autonomous, passive,
        approve, notify: event => notify(JSON.parse(redact(JSON.stringify(event)))), log: message => notify({ type: 'notice', message: redact(message) }) });
      signal.throwIfAborted();
      conversation = await chat({ root, name: id, client, fresh, snapshot: kind === 'agent', directory: paths.chats, notes, legacy,
        log: message => notify({ type: 'notice', message }),
        record: (state, metadata) => {
          const key = catalog.chat(root, id, state, { ...metadata, kind });
          if (!identity) { identity = key; notify({ type: 'session', id: key, run: id, root }); }
        },
      });
      fresh = false;
      if (kind === 'prompt') {
        notify({ type: 'status', message: 'Qwen is replying' });
        const answer = await conversation.send(task, { model, signal });
        return { status: 'complete', message: answer.text };
      }
      return await run({ task, bridge: connection, location, resume: Boolean(previous), steps, signal, redact, notify, receive, notes,
        skill: async decision => {
          if (!autonomous && !await approve({ tool: 'global.skill', summary: decision.summary, why: decision.why, arguments: { name: decision.name, content: decision.content } })) {
            return { error: true, content: 'Global skill update was not approved. Continue without changing the shared skill library.' };
          }
          const library = await skills({ location: catalog.location, redact });
          const result = await library.save(decision);
          notify({ type: 'skill', name: result.name, digest: result.digest, location: result.location });
          return { error: false, content: `Saved global skill ${result.name} (${result.digest}).` };
        },
        record: state => catalog.agent(root, state),
        model: async (prompt, { signal, update }) => {
          try { return await conversation.send(prompt, { model, signal, update, thinking: true }); }
          catch (error) {
            const retryable = error?.status === 401 || error?.code === 'ECONNRESET' || error?.code === 'ETIMEDOUT' || /fetch failed|network|socket|timed out/i.test(error?.message || '');
            if (!retryable || signal?.aborted) throw error;
            notify({ type: 'reconnect', message: 'Qwen connection interrupted; validating the session and reconnecting.' });
            try { await conversation?.close(); } catch {}
            conversation = undefined;
            client = await access(signal);
            conversation = await chat({ root, name: id, client, fresh: true, snapshot: kind === 'agent', directory: paths.chats, notes, legacy, log: message => notify({ type: 'notice', message }), record: (state, metadata) => {
              const key = catalog.chat(root, id, state, { ...metadata, kind });
              if (!identity) { identity = key; notify({ type: 'session', id: key, run: id, root }); }
            } });
            return await conversation.send(prompt, { model, signal, update, thinking: true });
          }
        },
      });
    } finally {
      try { await conversation?.close(); }
      finally {
        conversation = undefined;
        try { await session?.close(); }
        finally { session = undefined; controller = undefined; }
      }
    }
  }
  async function stop(job) {
    if (!connection) throw new Error('No tasks are attached to this runtime.');
    const result = await connection.call('local.stop', { job }, { confirmed: true });
    if (result.error) throw new Error(redact(result.content));
    await connection.refresh();
    return result;
  }
  async function close() {
    if (controller) throw new Error('Cancel and await the current turn before closing the runtime.');
    if (closed) return;
    closed = true;
    try { await connection?.close(); } finally { if (owned) catalog.close(); }
  }
  return { root, id, kind, location, journals: paths.journals, send, models, validate, select, history, cancel, close, stop, redact: text => redact(text), get identity() { return identity; }, get fresh() { return fresh; } };
}

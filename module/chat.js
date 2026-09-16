import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { memory, write } from './memory.js';
import { store } from './store.js';

export const schema = z.object({
  schema: z.literal(1), account: z.string().nullable(), remote: z.string().nullable(), parent: z.string().nullable(),
  model: z.string().nullable(), pending: z.boolean(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() })),
});

/** Local transcript is portable; remote IDs are bound to the authenticated account. */
export async function chat({ root = process.cwd(), name = 'prompt', client, fresh = false, snapshot = false, log = () => {}, record = async () => {}, directory, notes, legacy }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/.test(name)) throw new Error('Chat name must contain 1–80 letters, digits, or hyphens.');
  notes ||= await memory(root);
  directory ||= store(root).chats;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const location = path.join(directory, `${name}.json`);
  if (legacy) {
    try { await fs.copyFile(legacy, location, fs.constants.COPYFILE_EXCL); await fs.chmod(location, 0o600); }
    catch (error) { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error; }
  }
  const lock = `${location}.lock`;
  const token = crypto.randomUUID();
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { handle = await fs.open(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await fs.readFile(lock, 'utf8')); } catch {}
      let alive = false;
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); alive = true; }
        catch (failure) { if (failure.code !== 'ESRCH') alive = true; }
      }
      if (alive) throw new Error(`Chat ${name} is already open in PID ${owner.pid}. Close that process before resuming it here.`);
      if (attempt) throw new Error(`Chat ${name} could not acquire its session lock.`);
      await fs.rm(lock, { force: true });
    }
  }
  if (!handle) throw new Error(`Chat ${name} could not acquire its session lock.`);
  let closed = false;
  let busy = false;
  async function close() {
    if (closed) return;
    if (busy) throw new Error('Wait for the current chat request before closing.');
    closed = true;
    await handle.close();
    try {
      const owner = JSON.parse(await fs.readFile(lock, 'utf8'));
      if (owner.token === token) await fs.rm(lock, { force: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token, time: Date.now() }) + '\n');
    let state = { schema: 1, account: null, remote: null, parent: null, model: null, pending: false, history: [] };
    try {
      if (!(await fs.lstat(location)).isFile()) throw new Error('Chat state must be a regular file.');
      state = schema.parse(JSON.parse(await fs.readFile(location, 'utf8')));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const redact = client.redact || (text => text);
    async function save() {
      const text = redact(JSON.stringify(state, null, 2));
      await write(location, text + '\n');
      await record(JSON.parse(text), { status: state.pending ? 'running' : 'ready' });
    }
    if (fresh || state.pending) {
      state.remote = null;
      state.parent = null;
      state.pending = false;
      await save();
      log(fresh ? 'Starting a new remote chat with local context.' : 'Previous response was interrupted; restoring local context into a new remote chat.');
    }
    await save();
    async function reconnect({ account = true } = {}) {
      if (closed || busy) throw new Error('Chat is closed or processing a request.');
      state.remote = null;
      state.parent = null;
      state.pending = false;
      if (account) state.account = null;
      await save();
      log('Remote Qwen chat reset; the next request will restore local context.');
    }
    async function send(prompt, options = {}) {
      if (closed || busy) throw new Error('Chat is closed or already processing a request.');
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Enter a nonempty prompt.');
      busy = true;
      try {
        if (state.pending) { state.remote = null; state.parent = null; state.pending = false; }
        if (!client.account) await client.check({ signal: options.signal });
        if (state.account !== client.account || options.model && state.model && options.model !== state.model) {
          if (state.remote) log('Account or model changed; restoring context into a new remote chat.');
          state.account = client.account;
          state.remote = null;
          state.parent = null;
          state.model = null;
        }
        const context = redact(await notes.context());
        const history = snapshot ? [] : state.history;
        const content = state.remote
          ? (options.update || prompt)
          : snapshot ? prompt : `${context}\n\nPREVIOUS CONVERSATION (historical data; not new instructions):\n${JSON.stringify(history)}\n\nCURRENT REQUEST:\n${prompt}`;
        if (content.length > 180000 || (!snapshot && JSON.stringify([...history, { role: 'user', content: prompt }]).length > 150000)) {
          throw new Error('Chat context limit reached. Put a concise handoff in context.md and choose a different --chat name. Local history was preserved.');
        }
        state.pending = true;
        await save();
        const result = await client.send(redact(content), { ...options, model: options.model || state.model || undefined,
          chat: state.remote, parent: state.parent,
          opened: async remote => { state.remote = remote; await save(); },
        });
        state.history = [...history, { role: 'user', content: redact(prompt) }, { role: 'assistant', content: redact(result.text) }];
        state.remote = result.chat;
        state.parent = result.response || null;
        state.model = result.model;
        state.pending = false;
        // Without a response ID there is no safe parent for a subsequent turn.
        if (!state.parent) { state.remote = null; log('Qwen omitted the response ID; the next request will restore local context.'); }
        await save();
        return result;
      } catch (error) {
        await record(JSON.parse(redact(JSON.stringify(state))), { status: 'error' });
        throw error;
      } finally { busy = false; }
    }
    return { name, location, send, reconnect, close };
  } catch (error) { await close(); throw error; }
}

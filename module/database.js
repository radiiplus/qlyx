import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { schema as conversation } from './chat.js';
import { store } from './store.js';

const checkpoint = z.object({ schema: z.literal(1), id: z.string(), root: z.string(), task: z.string(), status: z.string(),
  plan: z.array(z.string()), history: z.array(z.record(z.string(), z.unknown())), steps: z.number().int().min(0),
  pending: z.record(z.string(), z.unknown()).nullable(),
}).passthrough();
const fields = 'id, kind, root, name, title, status, model, account, pending, created, updated';
const name = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/;
const uuid = /^[a-f0-9-]{36}$/;
const title = text => text.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);

async function read(location) {
  const stat = await fs.lstat(location);
  if (!stat.isFile() || stat.size > 20000000) throw new Error(`Expected a regular session file smaller than 20 MB: ${location}`);
  return { state: JSON.parse(await fs.readFile(location, 'utf8')), time: Math.trunc(stat.mtimeMs) };
}

async function save(location, state) {
  await fs.mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
  try { await fs.writeFile(location, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

/** Central index, snapshots, checkpoints, and chat history. */
export async function database({ location = process.env.DATABASE || path.join(os.userInfo().homedir, '.local', 'share', 'qwen', 'session.db') } = {}) {
  const { DatabaseSync: Database } = await import('node:sqlite');
  location = path.resolve(location);
  await fs.mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
  try { if (!(await fs.lstat(location)).isFile()) throw new Error('Database must be a regular file, not a symlink.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const handle = await fs.open(location, 'a', 0o600);
  await handle.close();
  await fs.chmod(location, 0o600);
  const connection = new Database(location);
  try {
    connection.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    const version = connection.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) throw new Error('Session database was created by a newer version of this application.');
    connection.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('agent','prompt')), root TEXT NOT NULL, name TEXT NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL, model TEXT, account TEXT, pending INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL, updated INTEGER NOT NULL, saved INTEGER NOT NULL DEFAULT 0, chatted INTEGER NOT NULL DEFAULT 0,
      checkpoint TEXT, conversation TEXT, UNIQUE(root, kind, name)
    ); CREATE INDEX IF NOT EXISTS recent ON sessions(updated DESC); PRAGMA user_version = 1;`);
  } catch (error) { connection.close(); throw error; }
  const select = connection.prepare('SELECT * FROM sessions WHERE root = ? AND kind = ? AND name = ?');
  function put(root, kind, key, changes) {
    if (!path.isAbsolute(root) || !name.test(key) || !['agent', 'prompt'].includes(kind)) throw new Error('Invalid session identity.');
    connection.exec('BEGIN IMMEDIATE');
    try {
      const previous = select.get(root, kind, key);
      if (previous && (changes.saved && changes.saved < previous.saved || changes.chatted && changes.chatted < previous.chatted)) {
        connection.exec('COMMIT');
        return previous.id;
      }
      const now = changes.saved || changes.chatted || Date.now();
      const row = { id: crypto.randomUUID(), root, kind, name: key, title: key, status: 'ready', model: null, account: null,
        pending: 0, created: now, updated: now, saved: 0, chatted: 0, checkpoint: null, conversation: null, ...previous, ...changes };
      // Chat generation must not erase the authoritative agent checkpoint status.
      if (kind === 'agent' && changes.conversation && row.checkpoint) {
        const state = JSON.parse(row.checkpoint);
        row.status = state.status;
        row.pending = Number(Boolean(state.pending));
        row.title = title(state.task);
      }
      row.updated = Math.max(previous?.updated || 0, now);
      connection.prepare(`INSERT INTO sessions VALUES ($id,$kind,$root,$name,$title,$status,$model,$account,$pending,$created,$updated,$saved,$chatted,$checkpoint,$conversation)
        ON CONFLICT(root,kind,name) DO UPDATE SET title=excluded.title,status=excluded.status,model=excluded.model,account=excluded.account,
        pending=excluded.pending,updated=excluded.updated,saved=excluded.saved,chatted=excluded.chatted,checkpoint=excluded.checkpoint,conversation=excluded.conversation`).run(row);
      connection.exec('COMMIT');
      return row.id;
    } catch (error) { connection.exec('ROLLBACK'); throw error; }
  }
  function agent(root, input, { time = Date.now() } = {}) {
    const state = checkpoint.parse(input);
    if (state.root !== root || !uuid.test(state.id)) throw new Error('Checkpoint identity does not match its workspace.');
    return put(root, 'agent', state.id, { title: title(state.task), status: state.status, pending: Number(Boolean(state.pending)),
      checkpoint: JSON.stringify(state), saved: time });
  }
  function chat(root, key, input, { kind = 'prompt', status, time = Date.now() } = {}) {
    const state = conversation.parse(input);
    return put(root, kind, key, { title: kind === 'prompt' ? title(state.history.find(item => item.role === 'user')?.content || key) : key,
      status: status || (state.pending ? 'interrupted' : 'ready'), pending: Number(state.pending), model: state.model, account: state.account,
      conversation: JSON.stringify(state), chatted: time });
  }
  function get(id) {
    if (!/^[a-f0-9-]{6,36}$/.test(id)) throw new Error('Use a session ID or an unambiguous prefix of at least six characters.');
    const rows = connection.prepare(`SELECT ${fields} FROM sessions WHERE id LIKE ? ORDER BY updated DESC LIMIT 2`).all(id + '%');
    if (!rows.length) throw new Error('Session not found. Use sessions list or scan its workspace first.');
    if (rows.length > 1) throw new Error('Session ID prefix is ambiguous. Use the full ID.');
    return { ...rows[0], pending: Boolean(rows[0].pending) };
  }
  function list({ kind, status, root, query = '', limit = 100, offset = 0 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) throw new Error('Use a limit of 1–1000 and a nonnegative offset.');
    if (kind && !['agent', 'prompt'].includes(kind)) throw new Error('Kind must be agent or prompt.');
    return connection.prepare(`SELECT ${fields} FROM sessions WHERE (? IS NULL OR kind=?) AND (? IS NULL OR status=?) AND (? IS NULL OR root=?)
      AND instr(lower(title || ' ' || name || ' ' || root), lower(?)) > 0 ORDER BY updated DESC, id LIMIT ? OFFSET ?`)
      .all(kind || null, kind || null, status || null, status || null, root || null, root || null, query, limit, offset)
      .map(row => ({ ...row, pending: Boolean(row.pending) }));
  }
  async function resolve(id) {
    const row = get(id);
    let root;
    try { root = await fs.realpath(row.root); }
    catch { throw new Error(`Session workspace is unavailable: ${row.root}. Restore its files before resuming.`); }
    if (root !== row.root) throw new Error('Session workspace path changed. Restore it at its original location before resuming.');
    const paths = store(root, { location });
    const target = path.join(row.kind === 'agent' ? paths.runs : paths.chats, `${row.name}.json`);
    const source = select.get(root, row.kind, row.name);
    const legacy = row.kind === 'agent' ? path.join(root, '.agent', `${row.name}.json`) : path.join(root, '.agent', 'chat', `${row.name}.json`);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try { await fs.copyFile(legacy, target, fs.constants.COPYFILE_EXCL); await fs.chmod(target, 0o600); }
    catch (error) {
      if (error.code === 'ENOENT') {
        const snapshot = row.kind === 'agent' ? source?.checkpoint : source?.conversation;
        if (!snapshot) throw new Error(`Session data is missing from the central store: ${target}.`);
        await save(target, JSON.parse(snapshot));
      }
      else if (error.code !== 'EEXIST') throw error;
    }
    let data;
    try { data = await read(target); }
    catch (error) { if (error.code === 'ENOENT') throw new Error(`Session data is missing from the central store: ${target}.`); throw error; }
    if (row.kind === 'agent') {
      if (data.state.id !== row.name) throw new Error('Local checkpoint does not match the selected session.');
      agent(root, data.state, { time: data.time });
      if (data.state.pending) throw new Error('This session has an uncertain pending tool. Inspect its workspace before starting a new task; it cannot be replayed automatically.');
    } else {
      conversation.parse(data.state);
    }
    return { ...row, root, location: target };
  }
  async function scan(root, { recursive = false } = {}) {
    root = await fs.realpath(root);
    const ids = new Set();
    const errors = [];
    let visited = 0;
    async function visit(directory) {
      if (++visited > 10000) throw new Error('Scan exceeded 10,000 directories. Scan smaller workspace roots.');
      const entries = await fs.readdir(directory, { withFileTypes: true });
      if (entries.some(entry => entry.name === '.agent' && entry.isDirectory())) {
        const folder = path.join(directory, '.agent');
        const files = await fs.readdir(folder, { withFileTypes: true });
        const agents = new Set();
        for (const file of files) {
          if (!file.isFile() || !uuid.test(file.name.replace(/\.json$/, '')) || !file.name.endsWith('.json')) continue;
          agents.add(file.name.slice(0, -5));
          try {
            const data = await read(path.join(folder, file.name));
            if (`${data.state.id}.json` !== file.name) throw new Error('Checkpoint filename and ID differ.');
            ids.add(agent(directory, data.state, { time: data.time }));
            await save(path.join(store(directory, { location }).runs, file.name), data.state);
          } catch (error) { errors.push({ file: path.join(folder, file.name), error: error.message }); }
        }
        if (files.some(file => file.name === 'chat' && file.isDirectory())) {
          for (const file of await fs.readdir(path.join(folder, 'chat'), { withFileTypes: true })) {
            const key = file.name.replace(/\.json$/, '');
            if (!file.isFile() || !file.name.endsWith('.json') || !name.test(key)) continue;
            try {
              const data = await read(path.join(folder, 'chat', file.name));
              const kind = agents.has(key) || select.get(directory, 'agent', key) ? 'agent' : 'prompt';
              ids.add(chat(directory, key, data.state, { kind, time: data.time }));
              await save(path.join(store(directory, { location }).chats, file.name), data.state);
            } catch (error) { errors.push({ file: path.join(folder, 'chat', file.name), error: error.message }); }
          }
        }
      }
      if (recursive) for (const entry of entries) {
        if (entry.isDirectory() && !['.agent', '.git', 'node_modules', 'config', '.cache'].includes(entry.name)) {
          try { await visit(path.join(directory, entry.name)); }
          catch (error) { errors.push({ file: path.join(directory, entry.name), error: error.message }); }
        }
      }
    }
    await visit(root);
    return { count: ids.size, errors };
  }
  return { location, agent, chat, get, list, resolve, scan, close: () => connection.close() };
}

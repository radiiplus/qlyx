import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export const home = path.join(os.homedir(), '.local', 'share', 'qlyx');
export const archive = path.join(os.homedir(), '.local', 'share', 'qwen');

export async function migrate(source = archive, target = home) {
  try { await fs.access(source); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try { await fs.rename(source, target); }
  catch (error) {
    if (!['EEXIST', 'ENOTEMPTY', 'EXDEV'].includes(error.code)) throw error;
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    await fs.cp(source, target, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
  }
  await fs.chmod(target, 0o700);
  return true;
}

export function store(root, { location = process.env.DATABASE || path.join(home, 'session.db') } = {}) {
  const base = path.dirname(path.resolve(location));
  const key = crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24);
  const workspace = path.join(base, 'workspaces', key);
  return {
    base,
    workspace,
    runs: path.join(workspace, 'runs'),
    chats: path.join(workspace, 'chats'),
    journals: path.join(workspace, 'journals'),
    templates: path.join(base, 'templates'),
    session: path.join(base, 'session.json'),
  };
}

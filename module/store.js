import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

export const home = path.join(os.homedir(), '.local', 'share', 'qwen');

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

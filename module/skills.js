import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { store } from './store.js';

const name = /^[a-z][a-z0-9]{1,47}$/;
const bad = /(?:authorization\s*:\s*bearer|cookie\s*:\s*[^\s]+|set-cookie\s*:|api[_-]?key\s*[:=]|secret\s*[:=]|password\s*[:=]|\.env|config\/session\.json)/i;

export function check(value) {
  if (!value || !name.test(value)) throw new Error('Skill names must be 2–48 lowercase letters or digits.');
  return value;
}

export async function skills({ location, redact = text => text } = {}) {
  const root = path.join(store(process.cwd(), { location }).base, 'skills');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (await fs.realpath(root) !== root) throw new Error('Global skill directory must not be a symlink.');
  for (const title of ['os', 'browser']) {
    const target = path.join(root, `${title}.md`);
    try { await fs.access(target); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const source = new URL(`./skills/${title}.md`, import.meta.url);
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, await fs.readFile(source), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, target);
      } finally { await fs.rm(temporary, { force: true }); }
    }
  }
  async function list() {
    const rows = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || !name.test(entry.name.slice(0, -3))) continue;
      const location = path.join(root, entry.name);
      const stat = await fs.lstat(location);
      if (stat.size > 12000) continue;
      rows.push({ name: entry.name.slice(0, -3), content: await fs.readFile(location, 'utf8'), updated: Math.trunc(stat.mtimeMs) });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function save({ name: title, content }) {
    check(title);
    if (typeof content !== 'string' || content.trim().length < 20 || content.length > 12000) throw new Error('A global skill must contain 20–12,000 characters of procedure text.');
    const text = redact(content).trim();
    if (bad.test(text)) throw new Error('Global skills cannot contain credentials, session files, or secret assignments.');
    const location = path.join(root, `${title}.md`);
    const temporary = `${location}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, text + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, location);
      await fs.chmod(location, 0o600);
    } finally { await fs.rm(temporary, { force: true }); }
    return { name: title, bytes: Buffer.byteLength(text), digest: crypto.createHash('sha256').update(text).digest('hex'), location };
  }
  return { root, list, save };
}

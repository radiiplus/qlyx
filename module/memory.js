import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { plan, progress } from './plan.js';
import { store } from './store.js';
import { skills } from './skills.js';

export async function write(location, text) {
  const temporary = `${location}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, location);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function memory(root, options = {}) {
  root = await fs.realpath(root);
  const paths = store(root, options);
  const directory = options.directory || paths.runs;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (await fs.realpath(directory) !== directory) throw new Error('Session directory must not be a symlink.');

  const templateDir = options.templates || paths.templates;
  await fs.mkdir(templateDir, { recursive: true, mode: 0o700 });

  let created = false;
  for (const name of ['context.md', 'skill.md', 'plan.md']) {
    const workspaceLocation = path.join(root, name);
    const templateLocation = path.join(templateDir, name);
    try {
      await fs.access(templateLocation);
    } catch {
      const defaultContent = await fs.readFile(new URL(`./${name}`, import.meta.url), 'utf8');
      await fs.writeFile(templateLocation, defaultContent, { mode: 0o600, flag: 'wx' }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    try {
      await fs.writeFile(workspaceLocation, await fs.readFile(templateLocation, 'utf8'), { flag: 'wx', mode: 0o600 });
      if (name === 'plan.md') created = true;
    } catch (error) { 
      if (error.code !== 'EEXIST') throw error; 
    }
  }
  if (created) await plan(root);
  async function read(name) {
    const location = path.join(root, name);
    const stat = await fs.lstat(location);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 30000) throw new Error(`${name} must be a regular text file of at most 30 KB.`);
    return fs.readFile(location, 'utf8');
  }
  async function context() {
    const global = await skills({ location: path.join(paths.base, 'session.db') });
    const shared = (await global.list()).slice(0, 12).map(item => `\n## ${item.name}\n${item.content.slice(0, 4000)}`).join('');
    return `WORKSPACE CONTEXT (project notes; verify claims against files):\n${await read('context.md')}\n\nWORKSPACE SKILL (user-editable project instructions):\n${await read('skill.md')}\n\nWORKSPACE PLAN (saved progress; verify against checkpoints and files):\n${await read('plan.md')}\n\nGLOBAL SKILLS (approved reusable procedures; verify them against the current workspace):${shared || '\n(none)'}`;
  }
  async function save(state) {
    const tools = progress(state).slice(-8);
    const text = `# Agent handoff\n\nRun: ${state.id}\nStatus: ${state.status}\nSteps: ${state.steps}\nCheckpoint: ${state.id}.json\n\n## Task\n\n${state.task}\n\n## Latest direction\n\n${state.history.filter(item => item.role === 'user').at(-1)?.content || '(Original task.)'}\n\n## Plan\n\n${state.plan.map(item => `- ${item}`).join('\n') || '(No plan recorded.)'}\n\n## Recent observations\n\n${tools.map(item => `- ${item.tool}: ${item.status === 'complete' ? 'completed' : item.status} — ${item.content.slice(0, 1500)}`).join('\n') || '(None yet.)'}\n\n## Pending action\n\n${state.pending ? JSON.stringify(state.pending) : 'None.'}\n\n## Result\n\n${state.message || '(In progress.)'}\n\nThe checkpoint is authoritative. Do not replay an uncertain pending tool.\nResume with: npx qlyx --resume ${state.id}\n`;
    await write(path.join(directory, 'context.md'), text);
    await plan(root, state);
  }
  async function latest() {
    let text;
    try { text = await fs.readFile(path.join(directory, 'context.md'), 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const candidates = [];
      for (const name of await fs.readdir(directory)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
        const stat = await fs.lstat(path.join(directory, name));
        if (stat.isFile()) candidates.push({ name, time: stat.mtimeMs });
      }
      candidates.sort((a, b) => b.time - a.time);
      if (!candidates.length) throw new Error('No latest run exists here. Start a task or use --resume with an existing run ID.');
      const state = JSON.parse(await fs.readFile(path.join(directory, candidates[0].name), 'utf8'));
      if (state.schema !== 1 || state.root !== root || `${state.id}.json` !== candidates[0].name ||
          typeof state.task !== 'string' || !Array.isArray(state.plan) || !Array.isArray(state.history)) {
        throw new Error('The latest legacy checkpoint is invalid. Inspect it before resuming.');
      }
      await save(state);
      return state.id;
    }
    const match = /^# Agent handoff\n\nRun: ([a-f0-9-]{36})\n/.exec(text);
    if (!match) throw new Error('The latest handoff is invalid. Use an explicit run ID.');
    return match[1];
  }
  return { root, directory, context, save, latest };
}

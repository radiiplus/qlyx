import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { write } from './memory.js';

const start = '<!-- qwen:plan -->';
const end = '<!-- /qwen:plan -->';
const line = value => String(value ?? '').replace(/[\r\n]/g, ' ').replaceAll('<!--', '&lt;!--').slice(0, 1000);

export function progress(state) {
  return (state?.history || []).filter(entry => entry.role === 'tool').map(entry => {
    let data;
    try { data = JSON.parse(entry.content); } catch {}
    return { ...entry, status: data?.job ? state?.outcomes?.[data.job] || data.status || (entry.error ? 'failed' : 'complete') : entry.error ? 'failed' : 'complete' };
  });
}

/** Update only the agent-owned section, retaining the user's surrounding notes. */
export async function plan(root, state) {
  const location = path.join(root, 'plan.md');
  let original = '';
  try {
    const stat = await fs.lstat(location);
    if (!stat.isFile() || stat.size > 100000) throw new Error('plan.md must be a regular file of at most 100 KB.');
    original = await fs.readFile(location, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const first = original.indexOf(start), last = original.indexOf(end);
  if ((first >= 0) !== (last >= 0) || last >= 0 && last < first) throw new Error('The generated section in plan.md is damaged. Restore its marker pair before continuing.');
  const observations = progress(state);
  const steps = (state?.plan || []).map(value => /^\[(?: |x|~)\]/i.test(value) ? `- ${line(value)}` : `- [ ] ${line(value)}`);
  const actions = observations.slice(-20).map(entry => `- [${entry.status === 'complete' ? 'x' : entry.status === 'running' ? '~' : ' '}] ${line(entry.tool)} — ${entry.status === 'complete' ? 'completed' : entry.status === 'failed' ? 'failed; inspect the saved evidence' : entry.status + '; background task'}`);
  if (state?.pending) actions.push(`- [ ] ${line(state.pending.tool || state.pending.batch?.map(task => task.tool).join(', '))} — ${state.status === 'running' ? 'pending' : 'interrupted; result uncertain'}`);
  const block = `${start}\n## Current task\n\n${line(state?.history?.filter(entry => entry.role === 'user').at(-1)?.content || state?.task || 'No task started yet.')}\n\nRun: ${line(state?.id || 'none')}\nStatus: ${line(state?.status || 'ready')}\nUpdated: ${new Date().toISOString()}\nDecisions: ${state?.steps || 0}\nTools completed: ${observations.filter(entry => entry.status === 'complete').length}\nTool failures: ${observations.filter(entry => entry.status === 'failed').length}\nBackground tasks: ${(state?.jobs || []).length}\n\n### Milestones\n\n${steps.join('\n') || 'Planning adapts automatically to task scope. Milestones appear when substantial work needs them.'}\n\n### Execution progress\n\n${actions.join('\n') || 'No tool has run yet.'}\n\n${state?.message ? `### Outcome\n\n${line(state.message)}\n\n` : ''}${end}`;
  const content = first >= 0 ? original.slice(0, first) + block + original.slice(last + end.length) : `${original || '# Plan\n'}\n\n${block}\n`;
  // A concurrent edit must be preserved rather than replaced by an older snapshot.
  let current = '';
  try {
    if (!(await fs.lstat(location)).isFile()) throw new Error('plan.md must be a regular file.');
    current = await fs.readFile(location, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current !== original) throw new Error('plan.md changed while saving progress. Retry after reviewing the file.');
  await write(location, content);
}

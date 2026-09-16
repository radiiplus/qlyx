import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassThrough as Stream } from 'node:stream';
import { bridge } from '../module/mcp.js';
import { run } from '../module/agent.js';
import { terminal } from '../module/terminal.js';
import { journal } from '../module/journal.js';
import { activity } from '../module/activity.js';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jobs-'));
  const tools = await bridge({ root, autonomous: true, ...options });
  t.after(async () => { await tools.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, tools, location: path.join(root, '.agent', 'fixture.json') };
}
const decode = result => JSON.parse(result.content);
const action = (tool, args) => ({ text: JSON.stringify({ action: 'tool', summary: 'Check background work', tool, arguments: args }) });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('long MCP commands yield once, permit independent work, and retain incremental stdout, stderr and failure', { timeout: 15000 }, async t => {
  const events = [];
  const { tools, root } = await fixture(t, { notify: event => events.push(event) });
  const started = Date.now();
  const first = decode(await tools.call('local.run', { command: process.execPath, args: ['-e', 'require("fs").appendFileSync("launch", "once"); console.log("started"); setTimeout(()=>{console.log("finished");console.error("failure detail");process.exit(7)},2500)'] }, { id: 'execution' }));
  assert.equal(first.status, 'running');
  assert.ok(Date.now() - started < 2300);
  assert.equal((await tools.call('local.write', { file: 'independent', content: 'done' })).error, false);
  const result = decode(await tools.call('local.poll', { job: first.job, cursor: first.cursor, wait: 4000 }));
  assert.equal(result.status, 'failed'); assert.equal(result.code, 7);
  assert.match(result.stdout, /finished/); assert.match(result.stderr, /failure detail/);
  const empty = decode(await tools.call('local.poll', { job: first.job, cursor: result.cursor }));
  assert.equal(empty.stdout, ''); assert.equal(empty.stderr, '');
  const observed = await tools.observe();
  assert.equal(observed.running.length, 0);
  assert.equal(events.at(-1).id, 'execution');
  assert.equal(await fs.readFile(path.join(root, 'launch'), 'utf8'), 'once');
});

test('host checks tasks while no model request is active and stops owned processes', { timeout: 15000 }, async t => {
  let resolve;
  const received = new Promise(done => { resolve = done; });
  const { tools } = await fixture(t, { notify: event => { if (event.stdout?.includes('ready')) resolve(event); } });
  const task = decode(await tools.call('local.run', { command: process.execPath, args: ['-e', 'console.log("ready");setInterval(()=>{},1000)'], background: true }, { id: 'owner' }));
  const event = await received;
  assert.equal(event.job, task.job); assert.equal(event.id, 'owner'); assert.equal(event.status, 'running');
  const stopped = await tools.call('local.stop', { job: task.job });
  assert.equal(stopped.error, false);
  assert.equal(decode(stopped).reason, 'cancelled');
  assert.equal((await tools.observe()).running.length, 0);
});

test('agent performs independent work while a command runs and reviews its eventual failure before final', { timeout: 15000 }, async t => {
  const { tools, location, root } = await fixture(t);
  let turn = 0;
  const result = await run({ task: 'Run checks and create a note.', bridge: tools, location, steps: 8, model: async (prompt, { update }) => {
    turn++;
    if (turn === 1) return action('local.run', { command: process.execPath, args: ['-e', 'setTimeout(()=>{console.error("check failed");process.exit(3)},1500)'], background: true });
    if (turn === 2) { assert.match(prompt, /Command continues in the background/); return action('local.write', { file: 'note', content: 'independent work' }); }
    if (turn === 3) { assert.equal(await fs.readFile(path.join(root, 'note'), 'utf8'), 'independent work'); return { text: '{"action":"final","message":"Premature success"}' }; }
    assert.match(update || prompt, /check failed/);
    return { text: '{"action":"final","message":"Created the note; checks failed with exit code 3."}' };
  } });
  assert.match(result.message, /checks failed/);
  assert.ok(turn >= 4);
  assert.deepEqual(result.jobs, []);
});

test('queued direction arriving during inference is saved and prevents the stale action from executing', async t => {
  const { tools, location, root } = await fixture(t);
  let turn = 0;
  const queue = [];
  const result = await run({ task: 'Create a file.', bridge: tools, location, receive: () => queue.splice(0), model: async (prompt, { update }) => {
    if (!turn++) { queue.push('Do not create the file; just explain.'); return action('local.write', { file: 'stale', content: 'wrong' }); }
    assert.match(update, /Do not create the file; just explain/);
    return { text: '{"action":"final","message":"Explained without writing."}' };
  } });
  await assert.rejects(fs.access(path.join(root, 'stale')));
  assert.ok(result.history.some(entry => entry.role === 'user' && entry.content.startsWith('Do not')));
});

test('three concurrent approvals keep separate Enter/Escape decisions and accept queued direction', async t => {
  const input = new Stream(), output = new Stream();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = 90; output.rows = 24;
  let screen = ''; output.on('data', chunk => { screen += chunk; });
  const ui = terminal({ input, output }); t.after(() => ui.close()); ui.show();
  const approvals = ['first', 'second', 'third'].map(file => ui.approve({ tool: 'local.write', arguments: { file }, summary: 'Create ' + file }));
  assert.match(screen, /local.write first/); assert.doesNotMatch(screen, /local.write second/);
  input.write('also add tests\n');
  assert.deepEqual(ui.take(), ['also add tests']);
  input.write('\n'); assert.equal(await approvals[0], true); await tick();
  assert.match(screen, /local.write second/);
  input.emit('keypress', '', { name: 'escape' }); assert.equal(await approvals[1], false); await tick();
  assert.match(screen, /local.write third/);
  input.write('\n'); assert.equal(await approvals[2], true);
  assert.deepEqual(ui.take(), []);
});

test('concurrent batch executions and later task updates keep their originating journal IDs', async t => {
  const { tools, location, root } = await fixture(t);
  const book = journal({ root, name: 'fixture' });
  const feed = activity({ plain: true, output: { write() {} } }); feed.attach(book);
  let turn = 0;
  await run({ task: 'Read two paths', bridge: tools, location, notify: feed.notify, model: async () => ({ text: JSON.stringify(turn++ ? { action: 'final', message: 'Listed both' } : { action: 'batch', summary: 'Inspect independent inputs', why: 'Understand the existing workspace.', contribution: 'Gather inputs for the requested inspection.', parallel: 'These reads do not modify files or depend on each other.', milestones: [], tasks: [
    { tool: 'local.list', arguments: { directory: '.' }, summary: 'First listing' },
    { tool: 'local.list', arguments: { directory: '.' }, summary: 'Second listing' },
  ] }) }) });
  const entries = book.list(); assert.equal(entries.length, 2); assert.notEqual(entries[0].id, entries[1].id);
  assert.ok(entries.every(entry => entry.result?.id === entry.id));
  assert.match(feed.inspect(entries[0].id).join('\n'), /Directory/);
  assert.match(feed.inspect(entries[1].id).join('\n'), /Directory/);
});

test('closing the runtime terminates a detached command rather than leaving an orphan', { timeout: 15000 }, async t => {
  const { tools, root } = await fixture(t);
  const task = decode(await tools.call('local.run', { command: process.execPath, args: ['-e', 'require("fs").writeFileSync("pid",String(process.pid));setInterval(()=>{},1000)'] }));
  assert.equal(task.status, 'running');
  const pid = Number(await fs.readFile(path.join(root, 'pid'), 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  await tools.close();
  for (let index = 0; index < 20; index++) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Detached command survived runtime shutdown');
});

test('job inspection combines later output with the current failure status and original execution', async t => {
  const { root } = await fixture(t);
  const book = journal({ root, name: 'view' });
  const feed = activity({ plain: true, output: { write() {} } }); feed.attach(book);
  feed.notify({ type: 'tool', id: 'original', tool: 'local.run', summary: 'Run check', arguments: { command: 'node', args: ['check.js'] } });
  feed.notify({ type: 'result', id: 'original', tool: 'local.run', content: JSON.stringify({ job: 'task', status: 'running', cursor: 0, message: 'Command continues in the background' }) });
  feed.notify({ type: 'job', id: 'original', job: 'task', status: 'failed', code: 7, stdout: 'checked', stderr: 'broken', duration: 5000 });
  feed.notify({ type: 'tool', id: 'poller', tool: 'local.poll', arguments: { job: 'task' } });
  feed.notify({ type: 'result', id: 'poller', tool: 'local.poll', content: JSON.stringify({ job: 'task', status: 'failed', code: 7 }) });
  const text = feed.tasks('task').map(row => row.text || '').join('\n');
  assert.match(text, /original/); assert.match(text, /checked/); assert.match(text, /broken/); assert.match(text, /Exit code: 7/);
  assert.doesNotMatch(text, /Status: running|continues in the background/);
});

test('turn cancellation stops background jobs without requesting a second approval', { timeout: 15000 }, async t => {
  let approvals = 0;
  const { tools } = await fixture(t, { autonomous: false, approve: async () => { approvals++; return true; } });
  const task = decode(await tools.call('local.run', { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], background: true }));
  assert.equal(task.status, 'running');
  await tools.cancel();
  assert.equal(approvals, 1);
  const result = decode(await tools.call('local.poll', { job: task.job }));
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.status, 'failed');
});

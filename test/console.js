import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { PassThrough as Stream } from 'node:stream';
import { journal } from '../module/journal.js';
import { activity } from '../module/activity.js';
import { terminal } from '../module/terminal.js';
import { bridge } from '../module/mcp.js';
import { run } from '../module/agent.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'console-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('captured output beyond model excerpt survives compact previews and reopening with stable execution IDs', { timeout: 20000 }, async t => {
  const root = await fixture(t);
  const tools = await bridge({ root, autonomous: true });
  t.after(() => tools.close());
  const book = journal({ root, name: 'fixture' });
  let visible = '';
  const feed = activity({ plain: true, output: { write: text => { visible += text; } } });
  feed.attach(book);
  feed.intent('Print evidence');
  let turn = 0;
  const result = await run({ task: 'Print evidence', bridge: tools, location: path.join(root, '.agent', 'fixture.json'), notify: feed.notify,
    model: async () => ({ text: JSON.stringify(turn++ ? { action: 'final', message: 'Execution finished.', learned: ['The fixture prints numbered lines.'], limitations: ['Fixture evidence only.'] } : { action: 'tool', summary: 'Verify output retention', why: 'Compare full output against the compact preview.', evidence: ['Requested terminal output'], tool: 'local.run', arguments: { command: process.execPath, args: ['-e', 'process.stdout.write(Array.from({length:3000},(_,i)=>"evidence "+i).join("\\n"));console.error("stderr marker");'] } }) }),
  });
  feed.complete(result);
  assert.equal(result.status, 'complete');
  assert.match(visible, /lines hidden/);
  assert.ok(!visible.includes('evidence 1500'));
  assert.ok(!visible.includes('learned ·'));
  assert.ok(!visible.includes('    executed'));
  assert.deepEqual(book.entries.find(event => event.type === 'complete').learned, ['The fixture prints numbered lines.']);
  assert.match(visible, /Execution finished/);
  const id = book.list()[0].id;
  const captured = feed.inspect(id).join('\n');
  assert.match(captured, /evidence 1500/);
  assert.match(captured, /evidence 2999/);
  assert.match(captured, /stderr marker/);
  assert.match(feed.inspect(id, 'explain').join('\n'), /Compare full output/);
  assert.match(feed.transcript().join('\n'), /SERVER local · TOOL local.run/);
  assert.match(feed.transcript().join('\n'), /INPUT/);
  assert.match(feed.map().join('\n'), /VERIFY/);
  const reopened = journal({ root, name: 'fixture' });
  feed.attach(reopened);
  assert.equal(reopened.list()[0].id, id);
  assert.equal(feed.inspect(id).join('\n'), captured);
  assert.equal((await fs.stat(book.location)).mode & 0o777, 0o600);
});

test('large file diffs remain inspectable after their preview and credentials are redacted from saved UI events', async t => {
  const root = await fixture(t);
  const book = journal({ root, name: 'fixture', redact: text => text.replaceAll('private-cookie', '[REDACTED]') });
  const feed = activity({ plain: true, output: { write: () => {} } });
  feed.attach(book);
  feed.notify({ type: 'tool', tool: 'local.write', summary: 'Create a file', arguments: { file: 'sample' } });
  const after = Array.from({ length: 700 }, (_, index) => `line ${index}`).join('\n');
  feed.notify({ type: 'change', file: 'sample', created: true, added: 700, removed: 0, before: '', after, lines: [], truncated: true });
  feed.notify({ type: 'output', stream: 'stdout', text: 'private-cookie\n' });
  feed.notify({ type: 'result', tool: 'local.write', content: '{}', error: false });
  assert.match(feed.inspect(undefined, 'diff').join('\n'), /line 699/);
  assert.ok(!(await fs.readFile(book.location, 'utf8')).includes('private-cookie'));
});

test('transcript and output shortcuts preserve draft input, update live, scroll, and restore the conversation', async t => {
  const input = new Stream(), output = new Stream();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = 45; output.rows = 15;
  let screen = '', events = ['first execution'];
  output.on('data', chunk => { screen += chunk; });
  const ui = terminal({ input, output, transcript: () => events, inspect: () => ['stdout', 'retained output'] });
  t.after(() => ui.close());
  const pending = ui.read();
  input.write('draft');
  input.write('\x14');
  assert.match(screen, /TRANSCRIPT/);
  assert.match(screen, /first execution/);
  events = [...events, 'arriving evidence']; ui.update();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.match(screen, /arriving evidence/);
  input.write('\x1b[5~');
  ui.write('compact event while viewing\n');
  input.write('\x14');
  assert.ok(screen.includes('\x1b[?1049l'));
  assert.match(screen, /compact event while viewing/);
  input.write('\x0f');
  assert.match(screen, /retained output/);
  input.write('\x0f');
  input.write(' preserved\n');
  assert.equal(await pending, 'draft preserved');
  assert.equal(screen.split('\x1b[?1049h').length, 3);
  assert.equal(screen.split('\x1b[?1049l').length, 3);
});

test('approval inspection does not execute or consume queued prompts and session selection returns the selected row', async t => {
  const input = new Stream(), output = new Stream();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = 80; output.rows = 24;
  let screen = ''; output.on('data', chunk => { screen += chunk; });
  const ui = terminal({ input, output }); t.after(() => ui.close()); ui.show();
  input.write('queued task\n');
  const approved = ui.approve({ tool: 'local.edit', summary: 'Fix output', why: 'Observed failure', evidence: ['sample:1'], arguments: { file: 'sample', before: 'old', after: 'new' } });
  input.write('v\n'); assert.match(screen, /PROPOSED ACTION/); assert.match(screen, /- old/); assert.match(screen, /\+ new/);
  input.write('\x1b'); await new Promise(resolve => setTimeout(resolve, 550));
  input.write('e\n'); assert.match(screen, /Observed failure/);
  input.write('\x14'); input.write('\x14');
  input.write('n\n'); assert.equal(await approved, false);
  assert.equal(await ui.read(), 'queued task');
  const rows = [{ id: '11111111', kind: 'agent', title: 'First', status: 'complete', root: '/first', updated: Date.now() }, { id: '22222222', kind: 'agent', title: 'Second', status: 'running', root: '/second', updated: Date.now() }];
  const selected = ui.select(rows); input.write('\x1b[B'); input.write('\n'); assert.equal((await selected).id, '22222222');
});

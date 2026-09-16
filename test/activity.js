import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { writeFileSync as write } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { bridge } from '../module/mcp.js';
import { run } from '../module/agent.js';
import { activity } from '../module/activity.js';

test('MCP streams output before completion and emits diffs only for successful writes', { timeout: 20000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'activity-'));
  const tools = await bridge({ root, autonomous: true });
  t.after(async () => { await tools.close(); await fs.rm(root, { recursive: true, force: true }); });
  const events = [];
  const progress = event => events.push(event);
  let complete = false, received = false;
  const result = await tools.call('local.run', { command: process.execPath, args: ['-e', 'console.log("starting"); const timer=setInterval(()=>{if(require("node:fs").existsSync("ack")){clearInterval(timer);console.error("finished");}},10);setTimeout(()=>process.exit(4),5000).unref();'] }, {
    progress: event => { if (event.type === 'output' && event.text.includes('starting')) { assert.equal(complete, false); received = true; write(path.join(root, 'ack'), 'received'); } progress(event); },
  }).then(result => { complete = true; return result; });
  assert.equal(result.error, false);
  assert.equal(received, true);
  assert.ok(events.some(event => event.stream === 'stderr' && event.text.includes('finished')));
  events.length = 0;
  const written = JSON.parse((await tools.call('local.write', { file: 'sample.js', content: 'console.log(1);\n' }, { progress })).content);
  assert.equal(events[0].type, 'change');
  assert.equal(events[0].created, true);
  assert.equal(events[0].added, 1);
  assert.equal(events.length, 1, 'The committed diff is emitted once despite the final metadata fallback.');
  assert.equal(await fs.readFile(path.join(root, 'sample.js'), 'utf8'), 'console.log(1);\n');
  events.length = 0;
  await tools.call('local.edit', { file: 'sample.js', before: '1', after: '2', hash: written.digest }, { progress });
  assert.equal(events[0].added, 1);
  assert.equal(events[0].removed, 1);
  assert.ok(events[0].lines.some(line => line.kind === 'removed' && line.text === 'console.log(1);'));
  assert.ok(events[0].lines.some(line => line.kind === 'added' && line.text === 'console.log(2);'));
  events.length = 0;
  assert.equal((await tools.call('local.write', { file: 'sample.js', content: 'bad', hash: written.digest }, { progress })).error, true);
  assert.deepEqual(events, []);
  for (let index = 0; index < 12; index++) {
    events.length = 0;
    assert.equal((await tools.call('local.write', { file: `quick${index}.txt`, content: 'small write\n' }, { progress })).error, false);
    assert.equal(events.length, 1, 'Fast results must retain their diff without duplicates.');
  }
});

test('activity sanitizes terminal controls, distinguishes failures, and avoids duplicate streamed output', () => {
  let text = '';
  const feed = activity({ output: { write: value => { text += value; } }, plain: true });
  const args = { command: 'node', args: ['sample.js'] };
  feed.notify({ type: 'tool', tool: 'local.run', summary: 'Verify code', arguments: args });
  feed.notify({ type: 'output', text: '\x1b[2Juniquely streamed\x1b]52;c;YWJj\x07\n' });
  feed.notify({ type: 'result', tool: 'local.run', arguments: args, error: true, content: JSON.stringify({ code: 3, stdout: 'uniquely streamed' }) });
  feed.notify({ type: 'change', file: 'sample.js', added: 1, removed: 1, lines: [{ kind: 'removed', number: 1, text: 'old' }, { kind: 'added', number: 1, text: 'new' }] });
  feed.answer('```js\nconsole.log(2);\n```');
  assert.equal(text.includes('\x1b'), false);
  assert.equal(text.split('uniquely streamed').length, 2);
  assert.match(text, /exit 3/);
  assert.match(text, /Edited sample.js \(\+1 -1\)/);
  assert.match(text, /1 - old/);
  assert.match(text, /1 \+ new/);
  assert.match(text, /console.log\(2\)/);
  assert.doesNotThrow(() => feed.notify({ type: 'tool', tool: 'local.run', arguments: { command: 'node', args: 'invalid' } }));
  assert.doesNotThrow(() => feed.notify({ type: 'result', tool: 'external.example', content: 'null' }));
});

test('agent redacts a credential split across progress chunks before displaying it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'redaction-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events = [];
  let turn = 0;
  await run({ root, task: 'Check output', location: path.join(root, '.agent', 'fixture.json'),
    bridge: { root, tools: [], call: async (name, args, { progress }) => {
      progress({ type: 'output', text: 'before private-', stream: 'stdout' });
      progress({ type: 'output', text: 'credential after\n', stream: 'stdout' });
      return { error: false, content: '{}' };
    } },
    model: async () => ({ text: JSON.stringify(turn++ ? { action: 'final', message: 'Done' } : { action: 'tool', tool: 'local.run', arguments: {}, summary: 'Check' }) }),
    redact: text => text.replaceAll('private-credential', '[REDACTED]'), notify: event => events.push(event),
  });
  const output = events.filter(event => event.type === 'output').map(event => event.text).join('');
  assert.equal(output, 'before [REDACTED] after\n');
  assert.ok(!JSON.stringify(events).includes('private-credential'));
});

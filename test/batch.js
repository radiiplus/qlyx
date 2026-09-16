import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, parse } from '../module/agent.js';
import { bridge } from '../module/mcp.js';
import { activity } from '../module/activity.js';
import { journal } from '../module/journal.js';

const explanation = { summary: 'Check both independent scripts', why: 'Confirm each script produces its expected output.', contribution: 'Verify the scripts before reporting the implementation complete.', parallel: 'Each script writes only to its own stdout and has no shared state.', milestones: [1] };
const tasks = ['alpha', 'beta'].map(name => ({ tool: 'local.run', summary: `Verify ${name}`, arguments: { command: process.execPath, args: ['-e', `console.log('${name}')`] } }));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, location: path.join(root, '.agent', 'fixture.json') };
}

test('a batch explains its plan contribution before approvals, executes real commands, and remains inspectable after reopening', { timeout: 20000 }, async t => {
  const { root, location } = await fixture(t);
  const book = journal({ root, name: 'fixture' });
  let visible = '', approvals = 0;
  const feed = activity({ plain: true, output: { write: text => { visible += text; } } }); feed.attach(book);
  const tools = await bridge({ root, approve: async () => {
    approvals++;
    assert.match(visible, /batch · 2 actions/);
    assert.match(visible, /why · Confirm each script/);
    assert.match(visible, /plan · 1\. \[~\] Verify scripts/);
    assert.match(visible, /contribution · Verify the scripts/);
    assert.match(visible, /parallel · Each script/);
    const checkpoint = JSON.parse(await fs.readFile(location, 'utf8'));
    assert.equal(checkpoint.pending.why, explanation.why);
    assert.equal(checkpoint.pending.contribution, explanation.contribution);
    return true;
  } });
  t.after(() => tools.close());
  let turn = 0;
  const result = await run({ task: 'Verify two scripts.', bridge: tools, location, notify: feed.notify, model: async (prompt, { update }) => {
    assert.match(update || prompt, /Every batch must include/);
    if (turn++ === 0) return { text: JSON.stringify({ action: 'plan', plan: ['[~] Verify scripts'] }) };
    if (turn === 2) return { text: JSON.stringify({ action: 'batch', ...explanation, tasks }) };
    assert.match(update, /alpha/); assert.match(update, /beta/);
    return { text: JSON.stringify({ action: 'final', message: 'Both scripts passed.', plan: ['[x] Verify scripts'] }) };
  } });
  assert.equal(result.status, 'complete'); assert.equal(approvals, 2);
  const batch = book.entries.find(event => event.type === 'batch');
  assert.equal(batch.count, 2);
  assert.deepEqual(batch.plan, ['[~] Verify scripts']);
  assert.ok(book.entries.indexOf(batch) < book.entries.findIndex(event => event.type === 'tool'));
  for (const entry of book.list()) {
    assert.equal(entry.batch, batch.id);
    assert.equal(entry.result.batch, batch.id);
    const description = feed.inspect(entry.id, 'explain').join('\n');
    assert.match(description, /Check both independent scripts/);
    assert.match(description, /1\. \[~\] Verify scripts/);
    assert.match(description, /no shared state/);
  }
  const transcript = feed.transcript().join('\n');
  assert.match(transcript, /2 proposed actions/);
  assert.match(transcript, /Contribution\nVerify the scripts/);
  assert.doesNotMatch(transcript, /"contribution":/);
  feed.attach(journal({ root, name: 'fixture' }));
  assert.equal(feed.transcript().join('\n'), transcript);
});

test('batch schema requires actual explanations and unique numeric plan references', () => {
  for (const key of ['summary', 'why', 'contribution', 'parallel', 'milestones']) {
    const value = { action: 'batch', ...explanation, tasks }; delete value[key];
    assert.throws(() => parse(JSON.stringify(value)), /Every batch requires/);
  }
  for (const value of [{ why: '   ' }, { milestones: [1, 1] }, { milestones: [0] }, { milestones: ['1'] }]) {
    assert.throws(() => parse(JSON.stringify({ action: 'batch', ...explanation, tasks, ...value })));
  }
  assert.deepEqual(parse(JSON.stringify({ action: 'batch', ...explanation, milestones: [], tasks })).milestones, []);
});

test('invalid plan references are corrected without executing or journaling the rejected batch', async t => {
  const { root, location } = await fixture(t);
  let calls = 0, turn = 0;
  const events = [];
  const result = await run({ task: 'Verify scripts', location, notify: event => events.push(event),
    bridge: { root, tools: [], call: async () => { calls++; return { error: false, content: '{"code":0}' }; } },
    model: async (prompt, { update }) => {
      turn++;
      if (turn === 1) return { text: JSON.stringify({ action: 'plan', plan: ['[~] Verify scripts'] }) };
      if (turn === 2) return { text: JSON.stringify({ action: 'batch', ...explanation, milestones: [2], tasks }) };
      if (turn === 3) {
        assert.equal(calls, 0); assert.equal(events.filter(event => event.type === 'batch').length, 0);
        assert.match(update, /must reference existing plan steps/);
        return { text: JSON.stringify({ action: 'batch', ...explanation, tasks }) };
      }
      return { text: '{"action":"final","message":"Verified"}' };
    },
  });
  assert.equal(result.status, 'complete'); assert.equal(calls, 2);
  assert.equal(events.filter(event => event.type === 'batch').length, 1);
});

test('batch explanations without a plan stay honest and are redacted before display and storage', async t => {
  const { root, location } = await fixture(t);
  const book = journal({ root, name: 'fixture' });
  let visible = '', turn = 0;
  const feed = activity({ plain: true, output: { write: value => { visible += value; } } }); feed.attach(book);
  await run({ task: 'Inspect two inputs', location, notify: feed.notify, redact: text => text.replaceAll('private-value', '[REDACTED]'),
    bridge: { root, tools: [], call: async () => ({ error: false, content: '{}' }) },
    model: async () => ({ text: JSON.stringify(turn++ ? { action: 'final', message: 'Inspected' } : { action: 'batch', ...explanation, why: 'Check private-value', milestones: [], tasks }) }),
  });
  assert.match(visible, /plan · Direct task contribution/);
  assert.match(visible, /\[REDACTED\]/);
  assert.match(feed.transcript().join('\n'), /no milestones recorded/);
  assert.doesNotMatch(await fs.readFile(book.location, 'utf8'), /private-value/);
});

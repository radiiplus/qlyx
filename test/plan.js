import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { memory } from '../module/memory.js';
import { run } from '../module/agent.js';
import { plan } from '../module/plan.js';

test('substantial tasks create and update plans automatically without invoking a tool or a slash command', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let turn = 0, calls = 0;
  const events = [];
  const result = await run({ task: 'Build the API, connect a CLI, and verify both components.',
    location: path.join(root, '.agent', 'fixture.json'), notify: event => events.push(event),
    bridge: { root, tools: [], call: async () => { calls++; return { error: false, content: 'components verified' }; } },
    model: async (prompt, { update }) => {
      assert.match(update ?? prompt, /Assess task scope automatically/);
      assert.match(update ?? prompt, /Never ask the user to enable planning/);
      if (turn++ === 0) return { text: JSON.stringify({ action: 'plan', plan: ['[~] Inspect API and CLI', '[ ] Verify integration'] }) };
      if (turn === 2) {
        assert.equal(calls, 0);
        assert.match(await fs.readFile(path.join(root, 'plan.md'), 'utf8'), /\[~\] Inspect API and CLI/);
        return { text: JSON.stringify({ action: 'tool', summary: 'Verify existing components', tool: 'local.run', arguments: {} }) };
      }
      return { text: JSON.stringify({ action: 'final', message: 'Both existing components are verified.', plan: ['[x] Inspect API and CLI', '[x] Verify integration'] }) };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'complete');
  assert.ok(events.some(event => event.type === 'plan' && event.state.plan[0] === '[~] Inspect API and CLI'));
  assert.deepEqual(events.filter(event => event.type === 'plan').at(-1).state.plan, result.plan);
  assert.match(await fs.readFile(path.join(root, 'plan.md'), 'utf8'), /\[x\] Verify integration/);
});

test('plan.md retains user notes and records actual progress, failure, and final milestone state', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'plan.md'), '# Project priorities\n\nKeep the public API stable.\n');
  const notes = await memory(root);
  let turn = 0;
  const result = await run({ task: 'Verify the module', bridge: { root, tools: [], call: async () => ({ error: true, content: '{"code":1,"stderr":"actual failure"}' }) },
    location: path.join(root, '.agent', 'fixture.json'), model: async () => {
      if (turn++) {
        const content = await fs.readFile(path.join(root, 'plan.md'), 'utf8');
        assert.match(content, /Tool failures: 1/);
        assert.match(content, /local.run — failed/);
        return { text: JSON.stringify({ action: 'question', message: 'Which behavior is intended?', plan: ['[x] Inspect failure', '[~] Clarify behavior', '[ ] Implement fix'] }) };
      }
      return { text: JSON.stringify({ action: 'tool', summary: 'Check current behavior', tool: 'local.run', arguments: {}, plan: ['[~] Inspect failure', '[ ] Implement fix'] }) };
    },
  });
  assert.equal(result.status, 'question');
  const content = await fs.readFile(path.join(root, 'plan.md'), 'utf8');
  assert.ok(content.startsWith('# Project priorities\n\nKeep the public API stable.\n'));
  assert.match(content, /Status: question/);
  assert.match(content, /- \[x\] Inspect failure/);
  assert.match(content, /- \[ \] Implement fix/);
  assert.match(await notes.context(), /WORKSPACE PLAN/);
  assert.equal(content.split('<!-- qwen:plan -->').length, 2);
});

test('plan updates refuse symlinks and preserve an interrupted tool as uncertain', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { id: 'fixture', status: 'cancelled', task: 'Change a file', steps: 1, plan: [], history: [], pending: { tool: 'local.write' } };
  await plan(root, state);
  assert.match(await fs.readFile(path.join(root, 'plan.md'), 'utf8'), /interrupted; result uncertain/);
  await fs.writeFile(path.join(root, 'original'), 'preserve');
  await fs.rm(path.join(root, 'plan.md'));
  await fs.symlink('original', path.join(root, 'plan.md'));
  await assert.rejects(plan(root, state), /regular file/);
  assert.equal(await fs.readFile(path.join(root, 'original'), 'utf8'), 'preserve');
});

test('a yielded command stays in progress until its background outcome is observed', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = { id: 'fixture', status: 'running', task: 'Run tests', steps: 1, plan: [], history: [{ role: 'tool', tool: 'local.run', error: false, content: '{"job":"task","status":"running"}' }], jobs: ['task'] };
  await plan(root, state);
  let content = await fs.readFile(path.join(root, 'plan.md'), 'utf8');
  assert.match(content, /Tools completed: 0/); assert.match(content, /\[~\] local.run — running/);
  state.outcomes = { task: 'failed' }; state.jobs = [];
  await plan(root, state);
  content = await fs.readFile(path.join(root, 'plan.md'), 'utf8');
  assert.match(content, /Tools completed: 0/); assert.match(content, /Tool failures: 1/);
});

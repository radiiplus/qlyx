import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { skills } from '../module/skills.js';
import { memory } from '../module/memory.js';
import { run } from '../module/agent.js';

test('approved global skills are reusable, private, and redacted', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-'));
  const root = path.join(folder, 'workspace');
  const location = path.join(folder, 'home', 'session.db');
  await fs.mkdir(root);
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const notes = await memory(root, { location });
  const library = await skills({ location, redact: text => text.replaceAll('private-token', '[REDACTED]') });
  assert.deepEqual((await library.list()).map(item => item.name), ['browser', 'os']);
  const value = { name: 'verifybuild', content: '# Verify build\n\nRun the focused build check, inspect its output, and record the result. private-token' };
  const saved = await library.save(value);
  assert.equal(saved.name, 'verifybuild');
  assert.equal((await fs.stat(saved.location)).mode & 0o777, 0o600);
  assert.match(await notes.context(), /GLOBAL SKILLS[\s\S]*verifybuild[\s\S]*REDACTED/);
  await assert.rejects(library.save({ name: 'unsafe', content: '# Unsafe\n\nUse authorization: bearer abcdefghijklmnopqrstuvwxyz to connect.' }), /credentials/);
});

test('the agent can propose a learned skill and records its result', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'skillrun-'));
  const root = path.join(folder, 'workspace');
  const location = path.join(folder, 'home', 'session.db');
  await fs.mkdir(root);
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const notes = await memory(root, { location });
  const library = await skills({ location });
  let turn = 0;
  const result = await run({ task: 'Learn the verified build procedure.', bridge: { root, tools: [], call: async () => ({ error: false, content: 'ok' }) },
    location: path.join(notes.directory, 'fixture.json'), notes, model: async () => turn++ ? { text: JSON.stringify({ action: 'final', message: 'Saved the reusable procedure.' }) } : { text: JSON.stringify({ action: 'skill', name: 'verifybuild', summary: 'Save the verified build procedure', why: 'Future coding tasks can reuse this checked workflow.', content: '# Verify build\n\nRun the focused build check, inspect its output, and record the result.' }) },
    skill: decision => library.save(decision), steps: 3,
  });
  assert.equal(result.status, 'complete');
  assert.ok(result.history.some(entry => entry.tool === 'global.skill' && !entry.error));
  assert.match((await library.list()).find(item => item.name === 'verifybuild').content, /focused build check/);
});

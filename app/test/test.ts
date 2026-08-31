import assert from 'node:assert/strict';
import { execFile as launch, spawn as start } from 'node:child_process';
import { mkdir, mkdtemp, readFile as fetch, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type WebSocket from 'ws';
import { build } from '../src/server.ts';
import {
  AgentStore,
  Engine,
  Fault,
  loadPrompts,
  setting,
  Tool,
  type Page,
  type Reply,
} from '../src/tool.ts';
import {
  WorkspaceRegistry,
  ensureWorkspace,
  findWorkspace,
  type WorkspaceRecord,
} from '../src/workspace.ts';

const execute = promisify(launch);
const typescript = ['--import', import.meta.resolve('tsx')];

async function session(entry: string, input: string, cwd: string): Promise<string[]> {
  return await new Promise<string[]>((done, fail) => {
    const child = start(process.execPath, [...typescript, entry, 'serve'], { cwd });
    let output = '';
    let error = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { output += chunk; });
    child.stderr.on('data', (chunk: string) => { error += chunk; });
    child.once('error', fail);
    child.once('close', (code) => {
      if (code !== 0) fail(new Error(error || `serve exited with ${code}`));
      else done(output.trim().split('\n').filter(Boolean));
    });
    child.stdin.end(input);
  });
}

async function exchange(socket: WebSocket, value: object): Promise<Record<string, any>> {
  return await new Promise<Record<string, any>>((done, fail) => {
    socket.once('message', (data) => {
      try {
        done(JSON.parse(data.toString()));
      } catch (error) {
        fail(error);
      }
    });
    socket.send(JSON.stringify(value));
  });
}

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-'));
  await mkdir(path.join(root, 'space dir'));
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'notes.txt'), 'one\ntwo\nthree\nfour\nfive\n');
  await writeFile(path.join(root, 'space dir', 'child.txt'), 'child\n');
  await writeFile(path.join(root, 'node_modules', 'module.js'), 'export default true;\n');
  await writeFile(path.join(root, 'data.bin'), Buffer.from([0, 1, 2, 3]));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('lists a native absolute path one level at a time', async (t) => {
  const root = await fixture(t);
  const tool = new Tool();
  const result = await tool.list(root);

  assert.equal(result.path, await tool.resolve(root));
  assert.equal(result.page.total, 4);
  assert.deepEqual(result.items.map((item) => item.name), [
    'node_modules',
    'space dir',
    'data.bin',
    'notes.txt',
  ]);
  assert.equal(result.items[0].volume, true);
  assert.equal(path.isAbsolute(result.items[1].path), true);
  const volume = await tool.list(result.items[0].path);
  assert.equal(volume.items[0].name, 'module.js');
});

test('resolves relative paths from the configured base', async (t) => {
  const root = await fixture(t);
  const tool = new Tool(root);
  const result = await tool.list('space dir');

  assert.equal(result.name, 'space dir');
  assert.equal(result.items[0].name, 'child.txt');
  assert.equal(result.items[0].path, path.join(root, 'space dir', 'child.txt'));
});

test('paginates directories with a numeric continuation point', async (t) => {
  const root = await fixture(t);
  const tool = new Tool(root);
  const first = await tool.list('.', 0, 2);
  const second = await tool.list('.', first.page.next ?? 0, 2);

  assert.equal(first.page.more, true);
  assert.equal(first.page.next, 2);
  assert.equal(second.page.more, false);
  assert.equal(second.items.length, 2);
});

test('uses configured defaults and limits', async (t) => {
  const root = await fixture(t);
  const config = {
    lines: { size: 1, limit: 2 },
    items: { size: 1, limit: 2 },
    exec: { timeout: 1000, limit: 2000, bytes: 1024, store: 4096, shell: false },
    edit: { bytes: 1024 },
    create: { bytes: 1024 },
    engine: { limit: 2, wait: 2000, batch: 10 },
    server: { host: '127.0.0.1', port: 0, path: '/socket', bytes: 1024, token: '' },
    commands: {
      batch: 'group',
      autonomyState: 'agent-state',
      autonomyUpdate: 'agent-update',
      autonomyEvent: 'agent-event',
      list: 'scan',
      read: 'view',
      exec: 'run',
      create: 'make',
      edit: 'change',
      delete: 'erase',
      cancel: 'cancel',
      status: 'state',
      session: 'session',
      serve: 'listen',
      help: 'info',
    },
  };
  const tool = new Tool(root, config);
  const list = await tool.list();
  const read = await tool.read({ path: 'notes.txt' });

  assert.equal(list.items.length, 1);
  assert.equal(list.page.limit, 1);
  assert.equal(read.lines.length, 1);
  assert.equal(read.next?.start, 2);
  await assert.rejects(
    tool.read({ path: 'notes.txt', size: 3 }),
    (error) => error instanceof Fault && error.code === 'RANGE',
  );
});

test('returns remaining lines and follows an automatic cursor', async (t) => {
  const root = await fixture(t);
  const tool = new Tool(root);
  const first = await tool.read({ path: 'notes.txt', size: 2 });

  assert.deepEqual(first.lines, [
    { line: 1, text: 'one' },
    { line: 2, text: 'two' },
  ]);
  assert.deepEqual(first.range, { start: 1, end: 2, total: 5, remain: 3 });
  assert.equal(first.next?.start, 3);
  assert.equal(first.next?.end, 4);

  const second = await tool.read({ cursor: first.next?.cursor });
  assert.deepEqual(second.lines.map((line) => line.line), [3, 4]);
  assert.equal(second.range.remain, 1);

  const third = await tool.read({ cursor: second.next?.cursor });
  assert.deepEqual(third.lines, [{ line: 5, text: 'five' }]);
  assert.equal(third.range.remain, 0);
  assert.equal(third.next, null);
});

test('creates continuation data after an explicit range', async (t) => {
  const root = await fixture(t);
  const tool = new Tool(root);
  const result = await tool.read({ path: 'notes.txt', start: 2, end: 3 });

  assert.deepEqual(result.range, { start: 2, end: 3, total: 5, remain: 2 });
  assert.equal(result.next?.start, 4);
  assert.equal(result.next?.end, 5);
  const next = await tool.read({ cursor: result.next?.cursor });
  assert.deepEqual(next.lines.map((line) => line.text), ['four', 'five']);
});

test('replaces one exact region without changing surrounding content', async (t) => {
  const root = await fixture(t);
  const tool = new Tool(root);
  const file = path.join(root, 'code.ts');
  const original = 'const before = true;\nfunction old() {\n  return false;\n}\nconst after = true;\n';
  const first = 'const before = true;\nfunction current() {\n  return true;\n}\nconst after = true;\n';
  await writeFile(file, original);
  const result = await tool.edit({
    path: file,
    before: 'function old() {\n  return false;\n}',
    after: 'function current() {\n  return true;\n}',
  });
  const backup = `${file}.bak`;

  assert.equal(result.changed, true);
  assert.equal(result.index, 1);
  assert.deepEqual(result.backup, { path: backup, bytes: Buffer.byteLength(original) });
  assert.equal(await fetch(file, 'utf8'), first);
  assert.equal(await fetch(backup, 'utf8'), original);

  const second = await tool.edit({
    path: file,
    before: 'function current() {\n  return true;\n}',
    after: 'function final() {\n  return 42;\n}',
  });
  assert.equal(second.backup?.path, backup);
  assert.match(await fetch(file, 'utf8'), /function final/);
  assert.equal(await fetch(backup, 'utf8'), first);

  await assert.rejects(
    tool.edit({ path: file, before: 'missing', after: 'unsafe' }),
    (error) => error instanceof Fault && error.code === 'MATCH',
  );
  assert.equal(await fetch(backup, 'utf8'), first);
});

test('rejects oversized patches and backup failures without changing the target', async (t) => {
  const root = await fixture(t);
  const config = setting();
  config.edit.bytes = 32;
  const tool = new Tool(root, config);
  const oversized = path.join(root, 'oversized.txt');
  await writeFile(oversized, 'old');

  await assert.rejects(
    tool.edit({ path: oversized, before: 'old', after: 'x'.repeat(33) }),
    (error) => error instanceof Fault && error.code === 'SIZE',
  );
  assert.equal(await fetch(oversized, 'utf8'), 'old');
  await assert.rejects(stat(`${oversized}.bak`));

  const blocked = path.join(root, 'blocked.txt');
  await writeFile(blocked, 'before');
  await mkdir(`${blocked}.bak`);
  await assert.rejects(tool.edit({ path: blocked, before: 'before', after: 'after' }));
  assert.equal(await fetch(blocked, 'utf8'), 'before');
  assert.equal((await stat(`${blocked}.bak`)).isDirectory(), true);
});

test('persists session context, workspace state, and one rolling recovery patch across engines', async (t) => {
  const root = await fixture(t);
  const config = setting();
  const agent = await AgentStore.open(root);
  const engine = new Engine(new Tool(root, config, agent), config, agent);
  const promptBundle = JSON.parse(await fetch(path.join(root, 'qlyx.prompts.json'), 'utf8'));
  assert.equal(promptBundle.version, 1);
  assert.match(promptBundle.autonomy, /Observe -> Reason -> Act -> Verify -> Persist -> Continue/);
  assert.match(promptBundle.autonomy, /Do not write state after routine reads/);
  assert.match(promptBundle.browser, /browser_focus/);
  assert.match(promptBundle.browser, /browser_expand/);
  assert.match(promptBundle.browser, /browser_click/);
  assert.match(promptBundle.browser, /browser_type/);
  assert.match(promptBundle.browser, /browser_evidence/);
  assert.match(promptBundle.browser, /browser_start/);
  assert.match(promptBundle.browser, /browser_status/);
  assert.match(promptBundle.browser, /browser_cancel/);
  assert.match(promptBundle.browser, /browser_event/);
  assert.match(promptBundle.protocol, /# Current Workspace State/);
  assert.match(promptBundle.protocol, /After receiving a material result/);
  assert.match(promptBundle.protocol, /## Automatic Batch Routing/);
  assert.doesNotMatch(promptBundle.protocol, /session_count: <number>|## Stale \/ Removed/);
  assert.deepEqual(promptBundle.scenarios.map((item: { id: string }) => item.id), [
    'planning',
    'exploratory',
    'autonomous',
    'coding',
  ]);
  const initial = await fetch(path.join(root, '.agent', 'context.md'), 'utf8');
  assert.match(initial, /^---\nlast_updated: .+\n---/);
  assert.match(initial, /# Current Workspace State/);
  assert.match(initial, /## Confirmed Facts/);
  assert.doesNotMatch(initial, /Session Summary|Stale \/ Removed/);
  const guide = await fetch(path.join(root, '.agent', 'guide.md'), 'utf8');
  assert.match(guide, /# Qlyx Recovery Guide/);
  assert.match(guide, /Choose and switch modes yourself/);
  assert.match(guide, /read `.agent\/context\.md`/i);
  const context = [
    '---',
    'last_updated: 2026-08-31T09:00:00.000Z',
    '---',
    '# Current Workspace State',
    '## Focus',
    'Fix token expiry validation.',
    '## Status',
    'Three authentication tests fail.',
    '## Confirmed Facts',
    'Expiry comparison uses the wrong clock unit.',
    '## Current Changes',
    'None.',
    '## Blockers',
    'None.',
    '## Next Action',
    'Patch the expiry comparison.',
    '',
  ].join('\n');
  await writeFile(path.join(root, '.agent', 'context.md'), context);

  const continued = await engine.run({
    id: 'continue-claude',
    action: 'session',
    mode: 'continue',
    model: 'Claude',
  });
  assert.equal(continued.ok, true);
  const continuedData = continued.data as {
    prompt: string;
    scenario: string;
    scenarios: Array<{ id: string; name: string; description: string }>;
  };
  const prompt = continuedData.prompt;
  assert.equal(prompt.startsWith(context.trimEnd()), true);
  assert.equal(continuedData.scenario, 'adaptive');
  assert.equal(continuedData.scenarios.length, 4);
  assert.match(prompt, /# Qlyx Agent/);
  assert.match(prompt, /Format \(exactly 3 raw lines\)/);
  assert.match(prompt, /@@qlyx:<action>/);
  assert.match(prompt, /## Adaptive Working Modes/);
  assert.match(prompt, /Choose the working mode that best fits the current phase/);
  assert.match(prompt, /## Mode: Architecture & Planning/);
  assert.match(prompt, /## Mode: Explore & Debug/);
  assert.match(prompt, /## Mode: Autonomous Execution/);
  assert.match(prompt, /## Mode: Implementation/);
  assert.match(prompt, /include the failure in your next response/);
  assert.match(prompt, /## Persistent Workspace State/);
  assert.match(prompt, /## Persistent State Discipline/);
  assert.match(prompt, /Never use `context\.md` as conversation history/);
  assert.match(prompt, /## Current Autonomous State/);
  assert.match(prompt, /## Browser Control/);
  assert.match(prompt, /## Automatic Batch Routing/);
  assert.match(prompt, /never split a valid mixed batch/);
  assert.match(prompt, /logical `page` handle/);
  assert.match(prompt, /Browser observations are ephemeral/);
  assert.match(prompt, /browser_focus/);
  assert.match(prompt, /browser_back/);
  assert.match(prompt, /browser_click/);
  assert.match(prompt, /browser_type/);
  assert.match(prompt, /browser_scroll/);
  assert.match(prompt, /browser_extract/);
  assert.match(prompt, /browser_attributes/);
  assert.match(prompt, /browser_evidence/);
  assert.match(prompt, /browser_start/);
  assert.match(prompt, /browser_status/);
  assert.match(prompt, /browser_cancel/);
  assert.match(prompt, /different pages run concurrently/);
  assert.match(prompt, /interrupted work is marked `INTERRUPTED`/);
  assert.match(prompt, /Extracted observations are never stored in job state/);
  assert.match(prompt, /browser_dump/);
  assert.match(prompt, /## Incremental DOM Exploration/);
  assert.match(prompt, /automatically returns a bounded collapsed semantic page map/);
  assert.match(prompt, /expand nested branches individually/);
  assert.match(prompt, /Main\/Contract\/Source Code/);
  assert.match(prompt, /AMBIGUOUS_PATH/);
  assert.match(prompt, /CSS selectors remain accepted only for legacy compatibility/);
  assert.doesNotMatch(prompt, /<!--|QLYX:|@@AGENT ACTION|type="read_file"/);

  const setup = await engine.run({
    id: 'setup-claude',
    action: 'session',
    mode: 'setup',
    model: 'Claude',
    scenario: 'planning',
    personal: 'Keep public APIs backward compatible.',
  });
  assert.equal(setup.ok, true);
  const setupData = setup.data as { mode: string; context: string; prompt: string; scenario: string };
  assert.equal(setupData.mode, 'setup');
  assert.equal(setupData.context, context);
  assert.equal(setupData.scenario, 'adaptive');
  assert.equal(setupData.prompt.startsWith('# Qlyx Agent'), true);
  assert.equal(setupData.prompt.includes(context), false);
  assert.match(setupData.prompt, /## Mode: Architecture & Planning/);
  assert.match(setupData.prompt, /## Mode: Implementation/);
  assert.equal(setupData.prompt.endsWith('## Task Context\n\nKeep public APIs backward compatible.'), true);

  const target = path.join(root, 'auth.ts');
  await writeFile(target, 'export const expires = token.exp * 1000;\n');
  const edited = await engine.run({
    id: 'patch-expiry',
    action: 'edit',
    path: 'auth.ts',
    before: 'token.exp * 1000',
    after: 'token.exp',
    model: 'Claude',
  });
  assert.equal(edited.ok, true);
  assert.equal(await fetch(target, 'utf8'), 'export const expires = token.exp;\n');

  const patchPath = path.join(root, '.agent', 'evidence', 'last-patch.json');
  const firstPatchSource = await fetch(patchPath, 'utf8');
  const firstPatch = JSON.parse(firstPatchSource);
  assert.equal(firstPatch.sequence, 1);
  assert.equal(firstPatch.path, 'auth.ts');
  assert.equal(firstPatch.snapshot.encoding, 'base64');
  assert.equal(firstPatch.snapshot.bytes, 41);
  assert.equal(Buffer.from(firstPatch.snapshot.data, 'base64').toString('utf8'),
    'export const expires = token.exp * 1000;\n');
  assert.deepEqual(firstPatch.replacement, { before: 'token.exp * 1000', after: 'token.exp' });

  const blocked = await engine.run({
    id: 'blocked-history',
    action: 'edit',
    path: 'auth.ts',
    before: 'missing expression',
    after: 'token.exp + skew',
    model: 'Claude',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error?.code, 'MATCH');
  assert.equal(await fetch(target, 'utf8'), 'export const expires = token.exp;\n');
  assert.equal(await fetch(patchPath, 'utf8'), firstPatchSource);

  const refined = await engine.run({
    id: 'patch-skew',
    action: 'edit',
    path: 'auth.ts',
    before: 'token.exp',
    after: 'token.exp + skew',
    model: 'Claude',
  });
  assert.equal(refined.ok, true);
  assert.equal(await fetch(target, 'utf8'), 'export const expires = token.exp + skew;\n');
  assert.equal(await fetch(`${target}.bak`, 'utf8'), 'export const expires = token.exp;\n');

  const agentFiles = (await readdir(path.join(root, '.agent'))).sort();
  assert.deepEqual(agentFiles, [
    'context.md',
    'decisions.md',
    'events.log',
    'evidence',
    'guide.md',
    'hypotheses.md',
    'objectives.md',
    'state.json',
  ]);
  assert.deepEqual((await readdir(path.join(root, '.agent', 'evidence'))).sort(), [
    'index.md',
    'last-patch.json',
  ]);
  const patch = JSON.parse(await fetch(patchPath, 'utf8'));
  assert.equal(patch.sequence, 2);
  assert.equal(patch.path, 'auth.ts');
  assert.equal(Buffer.from(patch.snapshot.data, 'base64').toString('utf8'),
    'export const expires = token.exp;\n');
  assert.deepEqual(patch.replacement, { before: 'token.exp', after: 'token.exp + skew' });

  const protectedFile = await engine.run({
    id: 'protect-state',
    action: 'delete',
    path: '.agent/state.json',
    model: 'Claude',
  });
  assert.equal(protectedFile.ok, false);
  assert.equal(protectedFile.error?.code, 'AGENT');

  const firstState = JSON.parse(await fetch(path.join(root, '.agent', 'state.json'), 'utf8'));
  const firstMetadata = firstState.session;
  assert.equal(firstState.version, 1);
  assert.equal(typeof firstState.id, 'string');
  assert.equal(firstState.name, path.basename(root));
  assert.equal(firstMetadata.model, 'Claude');
  assert.deepEqual(firstMetadata.models, ['Claude']);
  const firstStateSource = await fetch(path.join(root, '.agent', 'state.json'), 'utf8');
  const firstEvents = await fetch(path.join(root, '.agent', 'events.log'), 'utf8');
  assert.equal(firstEvents, '');

  const routine = await engine.run({ id: 'routine-read', action: 'read', path: 'auth.ts' });
  assert.equal(routine.ok, true);
  assert.equal(await fetch(path.join(root, '.agent', 'state.json'), 'utf8'), firstStateSource);
  assert.equal(await fetch(path.join(root, '.agent', 'events.log'), 'utf8'), firstEvents);

  const reopened = await AgentStore.open(root);
  const next = new Engine(new Tool(root, config, reopened), config, reopened);
  const resumed = await next.run({
    id: 'continue-chatgpt',
    action: 'session',
    mode: 'continue',
    model: 'ChatGPT',
  });
  const secondState = JSON.parse(await fetch(path.join(root, '.agent', 'state.json'), 'utf8'));
  const secondMetadata = secondState.session;
  assert.equal(resumed.ok, true);
  assert.equal((resumed.data as { session: { id: string } }).session.id, firstMetadata.id);
  assert.equal(secondMetadata.startedAt, firstMetadata.startedAt);
  assert.equal(secondMetadata.model, 'ChatGPT');
  assert.deepEqual(secondMetadata.models, ['Claude', 'ChatGPT']);
  assert.equal(secondState.id, firstState.id);
});

test('persists validated autonomous state, evidence, decisions, and paged events', async (t) => {
  const root = await fixture(t);
  const config = setting();
  const agent = await AgentStore.open(root);
  const engine = new Engine(new Tool(root, config, agent), config, agent);

  const started = await engine.run({
    id: 'autonomy-start',
    action: 'autonomy_update',
    reset: true,
    status: 'running',
    phase: 'observe',
    objective: 'Diagnose token expiry validation',
    iteration: 1,
    plan: [
      { id: 'inspect', text: 'Inspect the authentication path', status: 'active' },
      { id: 'verify', text: 'Run focused authentication tests', status: 'pending' },
    ],
    hypotheses: [{ id: 'clock-unit', text: 'Expiry uses the wrong clock unit', status: 'open', evidence: ['auth-line'] }],
    evidence: [{ id: 'auth-line', summary: 'Middleware multiplies the expiry by 1000', source: 'auth.ts:1' }],
    decisions: [{ id: 'keep-api', summary: 'Preserve the public API', rationale: 'Only comparison units need to change' }],
    next: 'Read the authentication tests.',
    model: 'Claude',
  } as never);
  assert.equal(started.ok, true);
  const startedState = (started.data as { state: Record<string, any> }).state;
  assert.equal(startedState.revision, 1);
  assert.equal(startedState.eventSequence, 1);
  assert.equal(startedState.objective, 'Diagnose token expiry validation');
  assert.equal(startedState.evidence[0].id, 'auth-line');
  assert.match(await fetch(path.join(root, '.agent', 'objectives.md'), 'utf8'), /Diagnose token expiry validation/);
  assert.match(await fetch(path.join(root, '.agent', 'hypotheses.md'), 'utf8'), /clock-unit.*\[open\]/);
  assert.match(await fetch(path.join(root, '.agent', 'decisions.md'), 'utf8'), /Preserve the public API/);
  assert.match(await fetch(path.join(root, '.agent', 'evidence', 'index.md'), 'utf8'), /auth-line/);

  const verified = await engine.run({
    id: 'autonomy-verified',
    action: 'autonomy_event',
    event: 'verification.passed',
    summary: 'Focused authentication tests passed.',
    detail: '3 tests passed with no failures.',
    refs: ['auth-line'],
    model: 'Claude',
  } as never);
  assert.equal(verified.ok, true);

  const stateReply = await engine.run({
    id: 'autonomy-read',
    action: 'autonomy_state',
    limit: 1,
  });
  assert.equal(stateReply.ok, true);
  const stateData = stateReply.data as { state: Record<string, any>; events: Record<string, any>[]; page: Record<string, any> };
  assert.equal(stateData.state.eventSequence, 2);
  assert.equal(stateData.events.length, 1);
  assert.equal(stateData.events[0]?.event, 'verification.passed');
  assert.equal(stateData.page.total, 2);
  assert.equal((await fetch(path.join(root, '.agent', 'events.log'), 'utf8')).trim().split('\n').length, 2);
  const storedState = JSON.parse(await fetch(path.join(root, '.agent', 'state.json'), 'utf8'));
  assert.equal(storedState.run.eventSequence, 2);

  const invalid = await engine.run({
    id: 'autonomy-invalid',
    action: 'autonomy_update',
    plan: [
      { id: 'same', text: 'One', status: 'pending' },
      { id: 'same', text: 'Two', status: 'active' },
    ],
  } as never);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, 'AUTONOMY');

  const reopened = await AgentStore.open(root);
  const resumed = new Engine(new Tool(root, config, reopened), config, reopened);
  const promptReply = await resumed.run({
    id: 'autonomy-resume',
    action: 'session',
    mode: 'setup',
    scenario: 'autonomous',
    model: 'ChatGPT',
  });
  assert.equal(promptReply.ok, true);
  const prompt = (promptReply.data as { prompt: string }).prompt;
  assert.match(prompt, /Diagnose token expiry validation/);
  assert.match(prompt, /verification\.passed/);
  assert.match(prompt, /Observe -> Reason -> Act -> Verify -> Persist -> Continue/);

  const protectedState = await resumed.run({
    id: 'autonomy-protected',
    action: 'edit',
    path: '.agent/state.json',
    before: 'running',
    after: 'complete',
  });
  assert.equal(protectedState.ok, false);
  assert.equal(protectedState.error?.code, 'AGENT');
});

test('loads custom prompt bundles and keeps mode selection agent-owned', async (t) => {
  const root = await fixture(t);
  const bundle = {
    version: 1,
    base: '# Custom Base',
    protocol: 'Custom protocol',
    scenarios: [{
      id: 'coding',
      name: 'Custom coding',
      description: 'A custom implementation mode',
      content: '## Custom Mode',
    }],
  };
  const source = path.join(root, 'prompts.json');
  await writeFile(source, JSON.stringify(bundle));
  assert.deepEqual(loadPrompts(source), bundle);

  const duplicate = {
    ...bundle,
    scenarios: [bundle.scenarios[0], { ...bundle.scenarios[0] }],
  };
  await writeFile(source, JSON.stringify(duplicate));
  assert.throws(
    () => loadPrompts(source),
    (error) => error instanceof Fault && error.code === 'PROMPTS' && /unique/.test(error.message),
  );

  await mkdir(path.join(root, '.agent'));
  await writeFile(path.join(root, '.agent', 'prompts.json'), JSON.stringify(bundle));
  const config = setting();
  const agent = await AgentStore.open(root);
  const engine = new Engine(new Tool(root, config, agent), config, agent);
  const custom = await engine.run({
    id: 'custom-prompts',
    action: 'session',
    mode: 'setup',
    personal: 'Use the custom bundle.',
  });
  assert.equal(custom.ok, true);
  const customPrompt = (custom.data as { prompt: string }).prompt;
  assert.match(customPrompt, /^# Custom Base\n\nCustom protocol\n\n## Automatic Batch Routing/);
  assert.match(customPrompt, /top-level control operations\.\n\n## Adaptive Working Modes/);
  assert.match(customPrompt, /### Custom coding \(`coding`\)[\s\S]+## Custom Mode/);
  assert.match(customPrompt, /## Persistent State Discipline/);
  assert.match(customPrompt, /default browser evidence directory is `\.agent\/evidence\/browser\/`/);
  assert.equal(customPrompt.endsWith('## Task Context\n\nUse the custom bundle.'), true);

  const unknown = await engine.run({
    id: 'unknown-prompts',
    action: 'session',
    mode: 'setup',
    scenario: 'missing',
  });
  assert.equal(unknown.ok, true);
  assert.equal((unknown.data as { scenario: string }).scenario, 'adaptive');
  assert.match((unknown.data as { prompt: string }).prompt, /## Adaptive Working Modes/);

  const invalidPersonal = await engine.run({
    id: 'invalid-personal',
    action: 'session',
    personal: 42,
  } as never);
  assert.equal(invalidPersonal.ok, false);
  assert.equal(invalidPersonal.error?.code, 'SESSION');

  const entry = path.resolve('src/tool.ts');
  const cli = await execute(process.execPath, [
    ...typescript,
    entry,
    'session',
    '--mode',
    'setup',
    '--scenario',
    'coding',
    '--personal',
    'CLI task context.',
  ], { cwd: root });
  const cliReply = JSON.parse(cli.stdout);
  assert.equal(cliReply.ok, true);
  assert.equal(cliReply.data.scenario, 'adaptive');
  assert.equal(cliReply.data.prompt.endsWith('## Task Context\n\nCLI task context.'), true);

  const guideEntry = path.resolve('src/cli.ts');
  const guideCli = await execute(process.execPath, [
    ...typescript,
    guideEntry,
    'guide',
    root,
    '--json',
  ]);
  const guideReply = JSON.parse(guideCli.stdout);
  assert.equal(guideReply.workspace.length > 0, true);
  assert.equal(guideReply.path, path.join(root, '.agent', 'guide.md'));
  assert.match(guideReply.content, /# Qlyx Recovery Guide/);
});

test('rejects missing and ambiguous regions unless an index is supplied', async (t) => {
  const root = await fixture(t);
  const tool = new Tool(root);
  const file = path.join(root, 'repeat.txt');
  await writeFile(file, 'same\nmiddle\nsame\n');

  await assert.rejects(
    tool.edit({ path: file, before: 'missing', after: 'new' }),
    (error) => error instanceof Fault && error.code === 'MATCH',
  );
  await assert.rejects(
    tool.edit({ path: file, before: 'same', after: 'new' }),
    (error) => error instanceof Fault && error.code === 'MATCH',
  );
  const result = await tool.edit({ path: file, before: 'same', after: 'new', index: 2 });
  const content = await fetch(file, 'utf8');
  assert.equal(result.index, 2);
  assert.equal(content, 'same\nmiddle\nnew\n');
});

test('loads multiline edit specifications through the CLI', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'code.ts');
  const patch = path.join(root, 'change.json');
  await writeFile(file, 'function old() {\n  return false;\n}\n');
  await writeFile(patch, JSON.stringify({
    path: file,
    before: 'function old() {\n  return false;\n}',
    after: 'function current() {\n  return true;\n}',
  }));

  const entry = path.resolve('src/tool.ts');
  const result = await execute(process.execPath, [...typescript, entry, 'edit', '--spec', patch], { cwd: root });
  const body = JSON.parse(result.stdout);
  const content = await fetch(file, 'utf8');
  assert.equal(body.ok, true);
  assert.equal(body.data.changed, true);
  assert.match(content, /function current/);
});

test('deletes files and links without deleting link targets', async (t) => {
  const root = await fixture(t);
  const tool = new Tool(root);
  const file = path.join(root, 'remove.txt');
  const target = path.join(root, 'target.txt');
  const link = path.join(root, 'remove.link');
  await writeFile(file, 'remove');
  await writeFile(target, 'keep');
  await symlink(target, link);

  const removed = await tool.remove(file);
  const unlinked = await tool.remove(link);
  assert.equal(removed.type, 'file');
  assert.equal(unlinked.type, 'link');
  await assert.rejects(stat(file));
  assert.equal(await fetch(target, 'utf8'), 'keep');
  await assert.rejects(
    tool.remove('space dir'),
    (error) => error instanceof Fault && error.code === 'FILE',
  );
});

test('runs direct commands with output, errors, and exit codes', async (t) => {
  const root = await fixture(t);
  const tool = new Tool(root);
  const script = "process.stdout.write('out');process.stderr.write('err');process.exit(3)";
  const result = await tool.exec({ words: [process.execPath, '-e', script] });

  assert.equal(result.command, process.execPath);
  assert.deepEqual(result.args, ['-e', script]);
  assert.equal(result.cwd, root);
  assert.equal(result.code, 3);
  assert.equal(result.output, 'out');
  assert.equal(result.error, 'err');
  assert.equal(result.timed, false);
});

test('passes input and supports the platform shell', async (t) => {
  const root = await fixture(t);
  const tool = new Tool(root);
  const input = await tool.exec({
    words: [process.execPath, '-e', "process.stdin.pipe(process.stdout)"],
    input: 'answer',
  });
  const shell = await tool.exec({ words: ['echo shell'], shell: true });

  assert.equal(input.output, 'answer');
  assert.match(shell.output, /shell/);
  assert.equal(shell.code, 0);
});

test('enforces command time and output limits', async (t) => {
  const root = await fixture(t);
  const config = setting();
  config.exec.timeout = 1000;
  config.exec.limit = 1000;
  config.exec.bytes = 4;
  const tool = new Tool(root, config);
  const engine = new Engine(tool, config);
  const first = await engine.run({
    id: 'output',
    action: 'exec',
    words: [
      process.execPath,
      '-e',
      "process.stdout.write('abcdefgh');process.stderr.write('123456')",
    ],
  });
  const output = first.data as { output: string; error: string; cut: { output: boolean }; page: { output: Page; error: Page } };
  const next = await engine.run({
    id: 'output-next',
    action: 'status',
    target: 'output',
    out: output.page.output.next ?? 0,
    err: output.page.error.next ?? 0,
  });
  const page = next.data as { output: string; error: string; page: { output: Page; error: Page } };
  const timed = await tool.exec({
    words: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    timeout: 50,
  });

  assert.equal(output.output, 'abcd');
  assert.equal(output.error, '1234');
  assert.equal(output.cut.output, false);
  assert.equal(output.page.output.remain, 4);
  assert.equal(output.page.output.next, 4);
  assert.equal(page.output, 'efgh');
  assert.equal(page.error, '56');
  assert.equal(page.page.output.next, null);
  config.exec.store = 6;
  const short = await new Tool(root, config).exec({
    words: [process.execPath, '-e', "process.stdout.write('abcdefgh')"],
  });
  assert.equal(short.output, 'abcd');
  assert.equal(short.cut.output, true);
  assert.equal(short.page.output.stored, 6);
  assert.equal(short.page.output.lost, 2);
  assert.equal(timed.timed, true);
  assert.notEqual(timed.signal, null);
  const shell = await tool.exec({
    words: [`"${process.execPath}" -e "setInterval(() => {}, 1000)"`],
    shell: true,
    timeout: 50,
  });
  assert.equal(shell.timed, true);
  assert.ok(shell.duration < 2000);
  await assert.rejects(
    tool.exec({ words: [process.execPath, '-e', ''], timeout: 1001 }),
    (error) => error instanceof Fault && error.code === 'RANGE',
  );
});

test('tracks concurrent operations with independent response envelopes', async (t) => {
  const root = await fixture(t);
  const config = setting();
  config.engine.limit = 2;
  const engine = new Engine(new Tool(root, config), config);
  const script = "setTimeout(() => process.stdout.write('done'), 150)";
  const first = engine.run({ id: 'first', action: 'exec', words: [process.execPath, '-e', script] });
  const second = engine.run({ id: 'second', action: 'exec', words: [process.execPath, '-e', script] });
  const third = engine.run({ id: 'third', action: 'list', path: root });
  await new Promise<void>((done) => setImmediate(done));

  assert.equal(engine.active, 2);
  assert.equal(engine.queue.length, 1);
  const replies = await Promise.all([first, second, third]);
  assert.deepEqual(replies.map((reply) => reply.id), ['first', 'second', 'third']);
  assert.equal(replies.every((reply) => reply.ok), true);

  const repeat = await engine.run({ id: 'first', action: 'list', path: root });
  assert.equal(repeat.ok, false);
  assert.equal(repeat.error?.code, 'ID');
});

test('streams grouped batch progress while preserving filesystem order', async (t) => {
  const root = await fixture(t);
  const config = setting();
  config.engine.limit = 3;
  const engine = new Engine(new Tool(root, config), config);
  const updates: Array<Record<string, any>> = [];

  await engine.batch({
    id: 'batch-1',
    action: 'batch',
    operations: [
      { id: 'create-1', action: 'create', path: 'batch.txt', type: 'file', content: 'before' },
      { id: 'edit-1', action: 'edit', path: 'batch.txt', before: 'before', after: 'after' },
      {
        id: 'slow-1',
        action: 'exec',
        words: [process.execPath, '-e', "setTimeout(() => process.stdout.write('done'), 180)"],
      },
    ],
  }, (reply) => { updates.push(reply as Record<string, any>); });

  assert.equal(updates.length >= 2, true);
  assert.equal(updates[0]?.id, 'batch-1');
  assert.equal(updates[0]?.data.complete, false);
  assert.equal(updates.at(-1)?.data.completed, 3);
  assert.equal(updates.at(-1)?.data.pending, 0);
  assert.equal(updates.at(-1)?.data.complete, true);
  assert.deepEqual(
    updates.flatMap((update) => update.data.results).map((reply: { id: string }) => reply.id),
    ['create-1', 'edit-1', 'slow-1'],
  );
  assert.equal(await fetch(path.join(root, 'batch.txt'), 'utf8'), 'after');

  const invalid: Array<Record<string, any>> = [];
  await engine.batch({
    id: 'batch-invalid',
    action: 'batch',
    operations: [{ id: 'poll-inside', action: 'status', target: 'slow-1' }],
  }, (reply) => { invalid.push(reply as Record<string, any>); });
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0]?.ok, false);
  assert.equal(invalid[0]?.error.code, 'BATCH');
});

test('routes durable state and workspace observations in one batch', async (t) => {
  const root = await fixture(t);
  const config = setting();
  const agent = await AgentStore.open(root);
  const engine = new Engine(new Tool(root, config, agent), config, agent);
  const updates: Reply[] = [];

  await engine.batch({
    id: 'mixed-observation',
    action: 'batch',
    operations: [
      { id: 'state-check', action: 'autonomy_state', limit: 1 },
      { id: 'workspace-check', action: 'list', path: '.agent', limit: 20 },
    ],
  }, (reply) => { updates.push(reply); });

  const results = updates.flatMap((reply) => (
    (reply.data as { results: Reply[] }).results
  ));
  assert.deepEqual(results.map((reply) => reply.id), ['state-check', 'workspace-check']);
  assert.equal(results.every((reply) => reply.ok), true);
  assert.equal((results[0]?.data as { state: { status: string } }).state.status, 'idle');
  assert.equal(
    ((results[1]?.data as { items: Array<{ name: string }> }).items).some((item) => item.name === 'state.json'),
    true,
  );
  assert.equal((updates.at(-1)?.data as { complete: boolean }).complete, true);
});

test('returns progress after a soft wait and keeps the execution running', async (t) => {
  const root = await fixture(t);
  const config = setting();
  config.engine.wait = 3000;
  const engine = new Engine(new Tool(root, config), config);
  const script = "process.stdout.write('start');setTimeout(() => process.stdout.write(' end'), 1500)";
  const first = await engine.run({
    id: 'job',
    action: 'exec',
    words: [process.execPath, '-e', script],
    wait: 600,
  });

  assert.equal(first.ok, true);
  assert.equal((first.data as { state: string }).state, 'running');
  assert.equal(engine.active, 1);

  const current = await engine.run({ id: 'poll-1', action: 'status', target: 'job' });
  assert.equal((current.data as { state: string }).state, 'running');
  assert.equal((current.data as { target: string }).target, 'job');

  const final = await engine.run({ id: 'poll-2', action: 'status', target: 'job', wait: 2500 });
  assert.equal((final.data as { state: string }).state, 'done');
  assert.equal((final.data as { output: string }).output, 'start end');
  assert.equal(engine.active, 0);
});

test('registers queued executions before a concurrency slot is available', async (t) => {
  const root = await fixture(t);
  const config = setting();
  config.engine.limit = 1;
  config.engine.wait = 3000;
  const engine = new Engine(new Tool(root, config), config);
  t.after(() => engine.close());

  const blocker = await engine.run({
    id: 'blocker',
    action: 'exec',
    words: [process.execPath, '-e', 'setTimeout(() => {}, 250)'],
    wait: 0,
  });
  assert.equal((blocker.data as { state: string }).state, 'running');

  const queued = engine.run({
    id: 'queued-job',
    action: 'exec',
    words: [process.execPath, '-e', "process.stdout.write('queued ran')"],
    wait: 0,
  });
  await new Promise<void>((done) => setImmediate(done));
  const status = await engine.run({ id: 'queued-status', action: 'status', target: 'queued-job' });

  assert.equal(status.ok, true);
  assert.equal((status.data as { target: string }).target, 'queued-job');
  assert.equal((status.data as { state: string }).state, 'queued');
  await engine.run({ id: 'blocker-status', action: 'status', target: 'blocker', wait: 1000 });
  const started = await queued;
  assert.equal(started.ok, true);
  const finished = await engine.run({ id: 'queued-final', action: 'status', target: 'queued-job', wait: 1000 });
  assert.equal((finished.data as { state: string }).state, 'done');
  assert.equal((finished.data as { output: string }).output, 'queued ran');
});

test('deduplicates identical operation IDs without repeating side effects', async (t) => {
  const root = await fixture(t);
  const config = setting();
  const engine = new Engine(new Tool(root, config), config);
  t.after(() => engine.close());
  const request = {
    id: 'one-side-effect',
    action: 'exec',
    words: [
      process.execPath,
      '-e',
      "require('node:fs').appendFileSync('counter.txt', 'x')",
    ],
    cwd: root,
  };

  const [first, duplicate] = await Promise.all([engine.run(request), engine.run({ ...request })]);
  assert.deepEqual(duplicate, first);
  assert.equal(await fetch(path.join(root, 'counter.txt'), 'utf8'), 'x');

  const conflict = await engine.run({ ...request, words: [process.execPath, '-e', ''] });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error?.code, 'ID');
  assert.match(conflict.error?.message || '', /different request/i);
});

test('cancels queued and running executions by their original IDs', async (t) => {
  const root = await fixture(t);
  const config = setting();
  config.engine.limit = 1;
  config.engine.wait = 3000;
  const engine = new Engine(new Tool(root, config), config);
  t.after(() => engine.close());

  const running = await engine.run({
    id: 'running-cancel-target',
    action: 'exec',
    words: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    timeout: 3000,
    wait: 0,
  });
  assert.equal((running.data as { state: string }).state, 'running');

  const queued = engine.run({
    id: 'queued-cancel-target',
    action: 'exec',
    words: [process.execPath, '-e', "require('node:fs').writeFileSync('must-not-exist.txt', 'unsafe')"],
    cwd: root,
  });
  await new Promise<void>((done) => setImmediate(done));

  const queuedCancel = await engine.run({
    id: 'cancel-queued',
    action: 'cancel',
    target: 'queued-cancel-target',
  });
  assert.equal(queuedCancel.ok, true);
  assert.equal((queuedCancel.data as { state: string }).state, 'cancelled');

  const runningCancel = await engine.run({
    id: 'cancel-running',
    action: 'cancel',
    target: 'running-cancel-target',
  });
  assert.equal(runningCancel.ok, true);
  assert.equal((runningCancel.data as { state: string }).state, 'stopping');

  const runningFinal = await engine.run({
    id: 'running-cancel-status',
    action: 'status',
    target: 'running-cancel-target',
    wait: 2000,
  });
  assert.equal((runningFinal.data as { state: string }).state, 'done');
  assert.equal((runningFinal.data as { cancelled: boolean }).cancelled, true);

  const queuedReply = await queued;
  assert.equal(queuedReply.ok, false);
  assert.equal(queuedReply.error?.code, 'CANCELLED');
  await assert.rejects(fetch(path.join(root, 'must-not-exist.txt'), 'utf8'));
});

test('cancels active exec children through their batch ID', async (t) => {
  const root = await fixture(t);
  const config = setting();
  config.engine.limit = 2;
  const engine = new Engine(new Tool(root, config), config);
  t.after(() => engine.close());
  const updates: Reply[] = [];

  const batch = engine.batch({
    id: 'cancel-batch',
    action: 'batch',
    operations: [
      {
        id: 'cancel-child-1',
        action: 'exec',
        words: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        timeout: 3000,
      },
      {
        id: 'cancel-child-2',
        action: 'exec',
        words: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
        timeout: 3000,
      },
    ],
  }, (reply) => { updates.push(reply); });
  await new Promise((done) => setTimeout(done, 100));

  const cancelled = await engine.run({ id: 'cancel-batch-request', action: 'cancel', target: 'cancel-batch' });
  assert.equal(cancelled.ok, true);
  assert.equal((cancelled.data as { cancelled: boolean }).cancelled, true);
  await batch;

  const final = updates.at(-1)?.data as Record<string, any>;
  assert.equal(final.complete, true);
  assert.equal(final.cancelled, true);
  assert.equal(final.failed, 2);
  assert.deepEqual(final.errors.map((error: { code: string }) => error.code), ['CANCELLED', 'CANCELLED']);
});

test('reports cumulative batch status and child failure summaries', async (t) => {
  const root = await fixture(t);
  const config = setting();
  config.engine.wait = 3000;
  const engine = new Engine(new Tool(root, config), config);
  t.after(() => engine.close());
  const updates: Reply[] = [];

  const request = {
    id: 'tracked-batch',
    action: 'batch',
    operations: [
      { id: 'missing-child', action: 'read', path: 'missing.txt' },
      {
        id: 'slow-child',
        action: 'exec',
        words: [process.execPath, '-e', "setTimeout(() => process.stdout.write('done'), 250)"],
        wait: 0,
      },
    ],
  };
  const batch = engine.batch(request, (reply) => { updates.push(reply); });

  await new Promise((done) => setTimeout(done, 50));
  const running = await engine.run({ id: 'batch-status-1', action: 'status', target: 'tracked-batch' });
  const runningData = running.data as Record<string, any>;
  assert.equal(running.ok, true);
  assert.equal(runningData.target, 'tracked-batch');
  assert.equal(runningData.state, 'running');
  assert.equal(runningData.total, 2);
  assert.equal(runningData.failed, 1);
  assert.equal(runningData.errors[0]?.id, 'missing-child');

  await batch;
  const finished = await engine.run({ id: 'batch-status-2', action: 'status', target: 'tracked-batch' });
  const finishedData = finished.data as Record<string, any>;
  assert.equal(finishedData.state, 'done');
  assert.equal(finishedData.complete, true);
  assert.equal(finishedData.completed, 2);
  assert.equal(finishedData.succeeded, 1);
  assert.equal(finishedData.failed, 1);
  assert.deepEqual(finishedData.results.map((reply: Reply) => reply.id), ['missing-child', 'slow-child']);
  assert.equal((updates.at(-1)?.data as Record<string, any>).errors[0]?.id, 'missing-child');

  const replay: Reply[] = [];
  await engine.batch({ ...request, operations: request.operations.map((operation) => ({ ...operation })) }, (reply) => {
    replay.push(reply);
  });
  assert.equal(replay.length, 1);
  assert.deepEqual(
    (replay[0]?.data as Record<string, any>).results.map((reply: Reply) => reply.id),
    ['missing-child', 'slow-child'],
  );
});

test('streams concurrent serve responses as each operation completes', async (t) => {
  const root = await fixture(t);
  const entry = path.resolve('src/tool.ts');
  const slow = {
    id: 'slow',
    action: 'exec',
    words: [process.execPath, '-e', "setTimeout(() => process.stdout.write('slow'), 300)"],
  };
  const fast = { id: 'fast', action: 'list', path: root };
  const lines = await session(entry, `${JSON.stringify(slow)}\n${JSON.stringify(fast)}\n`, root);
  const replies = lines.map((line) => JSON.parse(line));

  assert.equal(replies.length, 2);
  assert.equal(replies[0].id, 'fast');
  assert.equal(replies[1].id, 'slow');
  assert.equal(replies.every((reply) => reply.ok), true);
});

test('registers multiple initialized workspaces in one machine registry', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const state = await mkdtemp(path.join(os.tmpdir(), 'qlyx-state-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const registry = new WorkspaceRegistry(state);
  const firstMarker = await ensureWorkspace(first, 'First project');
  const secondMarker = await ensureWorkspace(second, 'Second project');

  const firstRecord = await registry.register(first, firstMarker);
  const secondRecord = await registry.register(second, secondMarker);
  const data = await registry.read();
  assert.equal(data.defaultId, secondRecord.id);
  assert.deepEqual(data.workspaces.map((item) => item.id), [firstRecord.id, secondRecord.id]);
  assert.equal((await findWorkspace(path.join(first, 'space dir'))).marker.id, firstRecord.id);

  const selected = await registry.use('First project');
  assert.equal(selected.id, firstRecord.id);
  assert.equal((await registry.read()).defaultId, firstRecord.id);
  await registry.deactivate(firstRecord.id);
  assert.equal((await registry.read()).workspaces.find((item) => item.id === firstRecord.id)?.active, false);
});

test('serves correlated concurrent operations over WebSocket', async (t) => {
  const root = await fixture(t);
  const config = setting();
  config.server.port = 0;
  const app = await build({ base: root, config, logger: false });
  await app.ready();

  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.json().ok, true);
  assert.equal(health.json().defaultWorkspace, 'default-workspace');
  assert.equal(health.json().workspaces[0]?.root, root);
  const socket = await app.injectWS(config.server.path);
  t.after(async () => {
    socket.terminate();
    await app.close();
  });
  const replies = await new Promise<Array<Record<string, unknown>>>((done, fail) => {
    const found: Array<Record<string, unknown>> = [];
    socket.once('error', fail);
    socket.on('message', (data) => {
      try {
        found.push(JSON.parse(data.toString()));
        if (found.length === 2) done(found);
      } catch (error) {
        fail(error);
      }
    });
    socket.send(JSON.stringify({
      id: 'socket-slow',
      action: 'exec',
      words: [process.execPath, '-e', "setTimeout(() => process.stdout.write('done'), 250)"],
    }));
    socket.send(JSON.stringify({ id: 'socket-fast', action: 'list', path: root }));
  });

  const [first, second] = replies;
  assert.equal(first.id, 'socket-fast');
  assert.equal(first.ok, true);
  assert.equal(second.id, 'socket-slow');
  assert.equal(second.ok, true);
});

test('routes one WebSocket connection across registered workspace roots', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  const state = await mkdtemp(path.join(os.tmpdir(), 'qlyx-router-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const registry = new WorkspaceRegistry(state);
  const firstRecord = await registry.register(first, await ensureWorkspace(first, 'Alpha'));
  const secondRecord = await registry.register(second, await ensureWorkspace(second, 'Beta'));
  const config = setting();
  config.server.port = 0;
  const app = await build({ config, logger: false, registry });
  await app.ready();
  const socket = await app.injectWS(config.server.path);
  t.after(async () => {
    socket.terminate();
    await app.close();
  });

  const catalog = await exchange(socket, { id: 'workspace-list', kind: 'workspace.list' });
  assert.equal(catalog.ok, true);
  assert.deepEqual(catalog.data.workspaces.map((item: WorkspaceRecord) => item.id), [
    firstRecord.id,
    secondRecord.id,
  ]);

  const createdFirst = await exchange(socket, {
    id: 'create-alpha',
    action: 'create',
    workspace: firstRecord.id,
    path: 'owned.txt',
    type: 'file',
    content: 'alpha',
  });
  const createdSecond = await exchange(socket, {
    id: 'create-beta',
    action: 'create',
    workspace: secondRecord.id,
    path: 'owned.txt',
    type: 'file',
    content: 'beta',
  });
  assert.equal(createdFirst.workspace, firstRecord.id);
  assert.equal(createdSecond.workspace, secondRecord.id);
  assert.equal(await fetch(path.join(first, 'owned.txt'), 'utf8'), 'alpha');
  assert.equal(await fetch(path.join(second, 'owned.txt'), 'utf8'), 'beta');

  const stopped = await exchange(socket, {
    id: 'stop-alpha',
    kind: 'workspace.stop',
    workspace: firstRecord.id,
  });
  assert.equal(stopped.ok, true);
  const inactive = await exchange(socket, {
    id: 'inactive-alpha',
    action: 'list',
    workspace: firstRecord.id,
    path: '.',
  });
  assert.equal(inactive.id, 'inactive-alpha');
  assert.equal(inactive.ok, false);
  assert.equal(inactive.error.code, 'WORKSPACE');
  const beta = await exchange(socket, {
    id: 'active-beta',
    action: 'list',
    workspace: secondRecord.id,
    path: '.',
  });
  assert.equal(beta.ok, true);
});

test('streams batch completion chunks over WebSocket', async (t) => {
  const root = await fixture(t);
  const config = setting();
  config.server.port = 0;
  const app = await build({ base: root, config, logger: false });
  await app.ready();
  const socket = await app.injectWS(config.server.path);
  t.after(async () => {
    socket.terminate();
    await app.close();
  });

  const replies = await new Promise<Array<Record<string, any>>>((done, fail) => {
    const found: Array<Record<string, any>> = [];
    socket.once('error', fail);
    socket.on('message', (data) => {
      try {
        const reply = JSON.parse(data.toString());
        found.push(reply);
        if (reply.data?.complete === true) done(found);
      } catch (error) {
        fail(error);
      }
    });
    socket.send(JSON.stringify({
      id: 'socket-batch',
      action: 'batch',
      operations: [
        { id: 'socket-list', action: 'list', path: '.' },
        {
          id: 'socket-exec',
          action: 'exec',
          words: [process.execPath, '-e', "setTimeout(() => process.stdout.write('done'), 180)"],
        },
      ],
    }));
  });

  assert.equal(replies.length, 2);
  assert.equal(replies.every((reply) => reply.id === 'socket-batch' && reply.ok === true), true);
  assert.equal(replies[0]?.data.complete, false);
  assert.equal(replies[0]?.data.pending, 1);
  assert.equal(replies[1]?.data.complete, true);
  assert.equal(replies[1]?.data.completed, 2);
});

test('answers WebSocket keepalive messages without using an operation id', async (t) => {
  const root = await fixture(t);
  const config = setting();
  config.server.port = 0;
  const app = await build({ base: root, config, logger: false });
  await app.ready();
  const socket = await app.injectWS(config.server.path);
  t.after(async () => {
    socket.terminate();
    await app.close();
  });

  const reply = await exchange(socket, { kind: 'ping' });
  assert.equal(reply.kind, 'pong');
  assert.equal(reply.defaultWorkspace, 'default-workspace');
  assert.equal(reply.workspaces[0]?.root, root);
});

test('authenticates exposed WebSocket servers', async (t) => {
  const root = await fixture(t);
  const exposed = setting();
  exposed.server.host = '0.0.0.0';
  exposed.server.token = '';
  await assert.rejects(
    build({ base: root, config: exposed, logger: false }),
    (error) => error instanceof Fault && error.code === 'AUTH',
  );

  const config = setting();
  config.server.port = 0;
  config.server.token = 'secret';
  const app = await build({ base: root, config, logger: false });
  await app.ready();
  const denied = await app.inject({ method: 'GET', url: config.server.path });
  assert.equal(denied.statusCode, 401);
  const socket = await app.injectWS(config.server.path, {
    headers: { authorization: 'Bearer secret' },
  });
  socket.terminate();
  await app.close();
});

test('rejects stale cursors and binary files', async (t) => {
  const root = await fixture(t);
  const tool = new Tool(root);
  const result = await tool.read({ path: 'notes.txt', size: 2 });
  await writeFile(path.join(root, 'notes.txt'), 'changed\n');

  await assert.rejects(
    tool.read({ cursor: result.next?.cursor }),
    (error) => error instanceof Fault && error.code === 'STALE',
  );
  await assert.rejects(
    tool.read({ path: 'data.bin' }),
    (error) => error instanceof Fault && error.code === 'BINARY',
  );
});

test('uses JSON for CLI output and supports absolute paths with spaces', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'space dir', 'child.txt');
  const entry = path.resolve('src/tool.ts');
  const result = await execute(
    process.execPath,
    [...typescript, entry, 'read', file, '--size', '1', '--id', 'file-1'],
    { cwd: root },
  );
  const body = JSON.parse(result.stdout);

  assert.equal(body.id, 'file-1');
  assert.equal(body.action, 'read');
  assert.equal(body.ok, true);
  assert.equal(body.data.path, file);
  assert.deepEqual(body.data.lines, [{ line: 1, text: 'child' }]);
  assert.equal(body.data.next, null);
});

test('loads alternate command names and ranges from a file', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'config.json');
  const data = {
    lines: { size: 1, limit: 2 },
    items: { size: 1, limit: 2 },
    exec: { timeout: 1000, limit: 2000, bytes: 1024, store: 4096, shell: false },
    edit: { bytes: 1024 },
    create: { bytes: 1024 },
    engine: { limit: 2, wait: 2000, batch: 10 },
    server: { host: '127.0.0.1', port: 0, path: '/socket', bytes: 1024, token: '' },
    commands: {
      batch: 'group',
      autonomyState: 'agent-state',
      autonomyUpdate: 'agent-update',
      autonomyEvent: 'agent-event',
      list: 'scan',
      read: 'view',
      exec: 'run',
      create: 'make',
      edit: 'change',
      delete: 'erase',
      cancel: 'cancel',
      status: 'state',
      session: 'session',
      serve: 'listen',
      help: 'info',
    },
  };
  await writeFile(file, JSON.stringify(data));
  assert.deepEqual(setting(file), data);

  const entry = path.resolve('src/tool.ts');
  const result = await execute(process.execPath, [...typescript, entry, 'view', 'notes.txt', '--config', file], { cwd: root });
  const body = JSON.parse(result.stdout);
  assert.deepEqual(body.data.lines, [{ line: 1, text: 'one' }]);
  assert.equal(body.data.next.start, 2);

  const run = await execute(process.execPath, [
    ...typescript,
    entry,
    'run',
    '--config',
    file,
    '--',
    process.execPath,
    '-e',
    "process.stdout.write('done')",
  ], { cwd: root });
  assert.equal(JSON.parse(run.stdout).data.output, 'done');
});

test('rejects invalid configuration values', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'config.json');
  await writeFile(file, JSON.stringify({
    lines: { size: 20, limit: 10 },
    items: { size: 1, limit: 2 },
    exec: { timeout: 1000, limit: 2000, bytes: 1024, store: 4096, shell: false },
    edit: { bytes: 1024 },
    create: { bytes: 1024 },
    engine: { limit: 2, wait: 2000, batch: 10 },
    server: { host: '127.0.0.1', port: 0, path: '/socket', bytes: 1024, token: '' },
    commands: {
      batch: 'batch',
      list: 'run',
      read: 'run',
      exec: 'exec',
      create: 'create',
      edit: 'edit',
      delete: 'delete',
      cancel: 'cancel',
      status: 'status',
      session: 'session',
      serve: 'serve',
      help: 'info',
    },
  }));

  assert.throws(
    () => setting(file),
    (error) => error instanceof Fault && error.code === 'CONFIG',
  );
});

test('rejects links to non-files when a file read is requested', async (t) => {
  const root = await fixture(t);
  const tool = new Tool(root);
  await symlink(path.join(root, 'space dir'), path.join(root, 'link'));

  await assert.rejects(
    tool.read({ path: 'link' }),
    (error) => error instanceof Fault && error.code === 'FILE',
  );
});

test('runs the complete filesystem and CLI workflow through WebSocket', async (t) => {
  const root = await fixture(t);
  const config = setting();
  config.server.port = 0;
  config.server.token = 'secret';
  const app = await build({ base: root, config, logger: false });
  await app.ready();

  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().ok, true);
  assert.equal(health.json().workspaces[0]?.root, root);

  const socket = await app.injectWS('/socket', {
    headers: { authorization: 'Bearer secret' },
  });
  t.after(async () => {
    socket.terminate();
    await app.close();
  });

  const folder = await exchange(socket, {
    id: 'folder',
    action: 'create',
    path: 'work/nested',
    type: 'directory',
    parents: true,
  });
  assert.equal(folder.ok, true);
  assert.equal(folder.data.type, 'directory');

  const file = await exchange(socket, {
    id: 'file',
    action: 'create',
    path: 'work/nested/code.txt',
    type: 'file',
    content: 'hello world',
  });
  assert.equal(file.ok, true);
  assert.equal(file.data.bytes, 11);

  const listed = await exchange(socket, {
    id: 'list',
    action: 'list',
    path: 'work/nested',
  });
  assert.deepEqual(listed.data.items.map((item: { name: string }) => item.name), ['code.txt']);

  const edited = await exchange(socket, {
    id: 'edit',
    action: 'edit',
    path: 'work/nested/code.txt',
    before: 'world',
    after: 'socket',
  });
  assert.equal(edited.data.changed, true);

  const read = await exchange(socket, {
    id: 'read',
    action: 'read',
    path: 'work/nested/code.txt',
  });
  assert.deepEqual(read.data.lines, [{ line: 1, text: 'hello socket' }]);

  const exec = await exchange(socket, {
    id: 'cli',
    action: 'exec',
    cwd: 'work/nested',
    words: [process.execPath, '-e', "process.stdout.write(process.cwd())"],
  });
  assert.equal(exec.ok, true);
  assert.equal(exec.data.code, 0);
  assert.equal(exec.data.output, path.join(root, 'work', 'nested'));

  const removed = await exchange(socket, {
    id: 'delete',
    action: 'delete',
    path: 'work/nested/code.txt',
  });
  assert.equal(removed.data.deleted, true);

  const empty = await exchange(socket, {
    id: 'empty',
    action: 'list',
    path: 'work/nested',
  });
  assert.deepEqual(empty.data.items.map((item: { name: string }) => item.name), ['code.txt.bak']);
  const backup = await exchange(socket, {
    id: 'backup',
    action: 'read',
    path: 'work/nested/code.txt.bak',
  });
  assert.deepEqual(backup.data.lines, [{ line: 1, text: 'hello world' }]);
});

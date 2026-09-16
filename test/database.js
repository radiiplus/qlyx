import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath as filename } from 'node:url';
import { database } from '../module/database.js';
import { memory, write } from '../module/memory.js';
import { store, origin } from '../module/session.js';
import { store as storage } from '../module/store.js';

const entry = filename(new URL('../chat.js', import.meta.url));
const source = new URL('../module/database.js', import.meta.url).href;
const state = () => ({ schema: 1, account: null, remote: null, parent: null, model: null, pending: false,
  history: [{ role: 'user', content: 'Remember cobalt' }, { role: 'assistant', content: 'Noted' }] });
function run(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, options);
    child.stdin.end();
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}
async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'database-'));
  const root = path.join(folder, 'workspace');
  await fs.mkdir(root);
  await memory(root);
  await fs.mkdir(path.join(root, '.agent'), { recursive: true });
  const location = path.join(folder, 'central', 'session.db');
  const catalog = await database({ location });
  t.after(async () => { catalog.close(); await fs.rm(folder, { recursive: true, force: true }); });
  return { folder, root, location, catalog };
}
async function prompt(root, name = 'prompt') {
  const directory = path.join(root, '.agent', 'chat');
  await fs.mkdir(directory, { recursive: true });
  await write(path.join(directory, `${name}.json`), JSON.stringify(state()));
}
async function agent(root) {
  const id = crypto.randomUUID();
  const value = { schema: 1, id, root, task: 'Continue the fixture task', status: 'limit', steps: 1,
    history: [{ role: 'tool', tool: 'local.read', error: false, content: '{"text":"Earlier observation"}' }], plan: ['Finish'], pending: null };
  await write(path.join(root, '.agent', `${id}.json`), JSON.stringify(value));
  return value;
}

test('SQLite gives stable global IDs, distinct workspace names, private files, and filtered metadata', async t => {
  const { root, folder, location, catalog } = await fixture(t);
  const other = path.join(folder, 'other');
  await fs.mkdir(other);
  const first = catalog.chat(root, 'prompt', state());
  const second = catalog.chat(other, 'prompt', state());
  assert.notEqual(first, second);
  assert.equal(catalog.chat(root, 'prompt', state()), first);
  assert.equal(catalog.get(first.slice(0, 8)).id, first);
  assert.equal(catalog.list({ root }).length, 1);
  assert.equal(catalog.list({ query: 'COBALT' }).length, 2);
  assert.equal(catalog.list({ query: "' OR 1=1 --" }).length, 0);
  assert.equal(catalog.list({ limit: 1, offset: 1 }).length, 1);
  assert.ok(!Object.hasOwn(catalog.get(first), 'conversation'));
  assert.equal((await fs.stat(location)).mode & 0o777, 0o600);
  const reopened = await database({ location });
  try { assert.equal(reopened.chat(root, 'prompt', state()), first); }
  finally { reopened.close(); }
});

test('home templates seed portable workspace files while runtime state stays central', async t => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'templates-'));
  const first = path.join(folder, 'first');
  const second = path.join(folder, 'second');
  const location = path.join(folder, 'home', 'session.db');
  await fs.mkdir(first);
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const notes = await memory(first, { location });
  const paths = storage(first, { location });
  await fs.writeFile(path.join(paths.templates, 'context.md'), '# Shared context template\n');
  await fs.mkdir(second);
  const copied = await memory(second, { location });
  assert.equal(await fs.readFile(path.join(second, 'context.md'), 'utf8'), '# Shared context template\n');
  assert.match(await fs.readFile(path.join(second, 'skill.md'), 'utf8'), /# Coding skill/);
  assert.match(await fs.readFile(path.join(second, 'plan.md'), 'utf8'), /qwen:plan/);
  assert.equal(notes.directory, paths.runs);
  assert.equal(copied.directory, storage(second, { location }).runs);
  await assert.rejects(fs.access(path.join(first, '.agent')));
  await assert.rejects(fs.access(path.join(second, '.agent')));
});

test('imports are idempotent, preserve separate snapshots, and report invalid records without reading config', async t => {
  const { root, catalog } = await fixture(t);
  const checkpoint = await agent(root);
  await prompt(root, checkpoint.id);
  await prompt(root);
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'config', 'session.json'), 'not a checkpoint');
  await fs.writeFile(path.join(root, '.agent', `${crypto.randomUUID()}.json`), '{broken');
  const first = await catalog.scan(root);
  assert.equal(first.count, 2);
  assert.equal(first.errors.length, 1);
  const rows = catalog.list();
  assert.equal(rows.find(row => row.kind === 'agent').status, 'limit');
  assert.equal((await catalog.scan(root)).count, 2);
  assert.deepEqual(catalog.list().map(row => row.id).sort(), rows.map(row => row.id).sort());
  const row = rows.find(row => row.kind === 'agent');
  catalog.agent(root, { ...checkpoint, status: 'complete' }, { time: Date.now() + 1000 });
  catalog.chat(root, checkpoint.id, { ...state(), pending: true }, { kind: 'agent', time: Date.now() + 2000 });
  assert.equal(catalog.get(row.id).status, 'complete');
  await catalog.scan(root);
  assert.equal(catalog.get(row.id).status, 'complete', 'An older imported snapshot must not replace a newer saved state');
});

test('resolve uses central state, restores database snapshots, and refuses unavailable workspaces and uncertain tools', async t => {
  const { root, location, catalog } = await fixture(t);
  const checkpoint = await agent(root);
  const id = catalog.agent(root, checkpoint);
  const resolved = await catalog.resolve(id);
  assert.equal(resolved.root, root);
  await write(resolved.location, JSON.stringify({ ...checkpoint, pending: { tool: 'local.run', arguments: {} } }));
  await assert.rejects(catalog.resolve(id), /uncertain pending tool/);
  catalog.agent(root, checkpoint, { time: Date.now() + 1000 });
  await fs.rm(resolved.location);
  await fs.rm(path.join(root, '.agent', `${checkpoint.id}.json`));
  assert.equal((await catalog.resolve(id)).location, path.join(storage(root, { location }).runs, `${checkpoint.id}.json`));
  await fs.rm(root, { recursive: true });
  assert.equal(catalog.get(id).id, id);
  await assert.rejects(catalog.resolve(id), /workspace is unavailable/);
});

test('independent processes concurrently register a single stable session without lost rows', { timeout: 20000 }, async t => {
  const { folder, root, location, catalog } = await fixture(t);
  const worker = path.join(folder, 'worker.mjs');
  await fs.writeFile(worker, `import { database } from ${JSON.stringify(source)};
const catalog = await database({location:process.argv[2]});
try { for(let i=0;i<15;i++) catalog.chat(process.argv[3], 'shared', ${JSON.stringify(state())}); }
finally {catalog.close();}`);
  const results = await Promise.all([run([worker, location, root]), run([worker, location, root])]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(catalog.list().length, 1);
  assert.equal(catalog.list()[0].name, 'shared');
});

test('central CLI resumes both runtime types from another directory without losing workspace context', { timeout: 30000 }, async t => {
  const { folder, root, location, catalog } = await fixture(t);
  const checkpoint = await agent(root);
  const coding = catalog.agent(root, checkpoint);
  await prompt(root);
  const chatting = catalog.chat(root, 'prompt', state());
  const credentials = path.join(folder, 'authentication.json');
  await store(credentials, { schema: 1, origin, local: {}, tab: {}, cookies: [{ name: 'token', value: 'test-token', domain: 'chat.qwen.ai', path: '/', expires: -1 }] });
  const preload = path.join(folder, 'provider.mjs');
  const requests = path.join(folder, 'requests.json');
  await fs.writeFile(preload, `import fs from 'node:fs/promises';
globalThis.fetch = async (url, options) => {
  if(url.pathname.endsWith('/auths/')) return Response.json({id:'fixture-user'});
  if(url.pathname.endsWith('/models/')) return Response.json({data:{data:[{id:'fixture'}]}});
  if(url.pathname.endsWith('/new')) return Response.json({data:{id:'remote'}});
  const body=JSON.parse(options.body);
  await fs.appendFile(${JSON.stringify(requests)}, JSON.stringify(body)+'\\n');
  const text=body.messages[0].content.includes('Earlier observation') ? JSON.stringify({action:'final',message:'Agent resumed.'}) : 'Prompt resumed.';
  return new Response('data: '+JSON.stringify({'response.created':{response_id:'response'}})+'\\n\\n'+'data: '+JSON.stringify({choices:[{delta:{phase:'answer',content:text,status:'finished'}}]})+'\\n\\n',{headers:{'content-type':'text/event-stream'}});
};`);
  const env = { ...process.env, DATABASE: location, SESSION: credentials, NODE_OPTIONS: `--import=${preload}` };
  for (const id of [coding, chatting]) {
    const result = await run([entry, '--resume', id, '--unattended', '--plain', ...(id === chatting ? ['Continue'] : ['/continue'])], { cwd: folder, env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /resumed\./);
  }
  assert.equal(catalog.get(coding).status, 'complete');
  assert.equal(catalog.get(chatting).status, 'ready');
  const calls = (await fs.readFile(requests, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.match(calls[0].messages[0].content, /Earlier observation/);
  assert.match(calls[0].messages[0].content, new RegExp(root));
  assert.match(calls[1].messages[0].content, /Remember cobalt/);
});

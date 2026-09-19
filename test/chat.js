import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { create } from '../module/client.js';
import { chat } from '../module/chat.js';
import { memory } from '../module/memory.js';
import { store, origin } from '../module/session.js';
import { run } from '../module/agent.js';
import { bridge } from '../module/mcp.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const location = path.join(root, 'config', 'session.json');
  await store(location, { schema: 1, origin, local: {}, tab: {}, cookies: [{ name: 'token', value: 'credential-secret', domain: 'chat.qwen.ai', path: '/', expires: -1 }] });
  const calls = [];
  const chats = new Map();
  let account = 'alpha';
  let count = 0;
  let fail = false;
  const replies = [];
  async function client() {
    const owner = account;
    return create({ location, request: async (url, options) => {
      if (url.pathname.endsWith('/auths/')) return Response.json({ id: owner });
      if (url.pathname.endsWith('/models/')) return Response.json({ data: { data: [{ id: 'fixture' }] } });
      const body = JSON.parse(options.body);
      if (url.pathname.endsWith('/new')) {
        const id = `chat-${++count}`;
        chats.set(id, { owner, parent: null });
        return Response.json({ data: { id } });
      }
      const remote = chats.get(body.chat_id);
      assert.equal(remote?.owner, owner, 'Remote chat IDs must not cross accounts');
      assert.equal(body.parent_id, remote.parent);
      assert.equal(body.messages[0].parent_id, remote.parent);
      assert.equal(body.messages[0].parentId, remote.parent);
      calls.push(body);
      const id = `response-${calls.length}`;
      const text = replies.shift() || `Answer ${calls.length}`;
      remote.parent = id;
      const content = `data: ${JSON.stringify({ 'response.created': { response_id: id } })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: { phase: 'answer', content: text, status: 'typing' } }] })}\n\n` +
        (fail ? '' : 'data: {"choices":[{"delta":{"phase":"answer","status":"finished"}}]}\n\n');
      fail = false;
      return new Response(content, { headers: { 'content-type': 'text/event-stream' } });
    } });
  }
  async function open(options = {}) { return chat({ root, client: await client(), ...options }); }
  return { root, location, calls, chats, replies, open, switch: value => { account = value; }, fail: () => { fail = true; } };
}

test('chat persists across client restarts and cookie refresh with correct response parents', async t => {
  const setup = await fixture(t);
  let conversation = await setup.open();
  const location = conversation.location;
  await conversation.send('Remember cobalt');
  await conversation.close();
  const config = JSON.parse(await fs.readFile(setup.location));
  config.cookies[0].value = 'credential-rotated';
  await store(setup.location, config);
  conversation = await setup.open();
  try { await conversation.send('Which color?'); } finally { await conversation.close(); }
  assert.equal(setup.chats.size, 1);
  assert.equal(setup.calls[1].parent_id, 'response-1');
  assert.equal(setup.calls[1].messages[0].content, 'Which color?');
  const saved = JSON.parse(await fs.readFile(location));
  assert.equal(saved.history.length, 4);
  assert.equal(saved.parent, 'response-2');
  assert.equal(saved.pending, false);
  assert.equal((await fs.stat(location)).mode & 0o777, 0o600);
});

test('chat sends prompts beyond the former local context thresholds', async t => {
  const setup = await fixture(t);
  const prompt = `large-context-marker\n${'x'.repeat(180000)}`;
  const conversation = await setup.open({ name: 'large', snapshot: true });
  try { await conversation.send(prompt); } finally { await conversation.close(); }
  assert.equal(setup.calls.length, 1);
  assert.equal(setup.calls[0].messages[0].content, prompt);
});

test('account change restores transcript and editable context/skill without reusing remote IDs', async t => {
  const setup = await fixture(t);
  await fs.writeFile(path.join(setup.root, 'context.md'), 'Project fact: use SQLite.');
  await fs.writeFile(path.join(setup.root, 'skill.md'), 'Project skill: run targeted tests.');
  let conversation = await setup.open();
  await conversation.send('Remember cobalt credential-secret');
  await conversation.close();
  setup.switch('beta');
  conversation = await setup.open();
  try { await conversation.send('Continue'); } finally { await conversation.close(); }
  assert.equal(setup.chats.size, 2);
  assert.equal(setup.calls[1].parent_id, null);
  const content = setup.calls[1].messages[0].content;
  for (const expected of ['SQLite', 'targeted tests', 'Remember cobalt', 'Answer 1', '[REDACTED]']) assert.ok(content.includes(expected));
  assert.ok(!content.includes('credential-secret'));
  assert.equal(await fs.readFile(path.join(setup.root, 'context.md'), 'utf8'), 'Project fact: use SQLite.');
});

test('explicit new chat keeps context; distinct names isolate transcripts and reject concurrent writers', async t => {
  const setup = await fixture(t);
  let conversation = await setup.open();
  await assert.rejects(setup.open(), /already open/);
  await conversation.send('Remember violet');
  await conversation.close();
  conversation = await setup.open({ fresh: true });
  await conversation.send('Continue');
  await conversation.close();
  assert.equal(setup.chats.size, 2);
  assert.match(setup.calls[1].messages[0].content, /Remember violet/);
  conversation = await setup.open({ name: 'other' });
  try { await conversation.send('Independent'); } finally { await conversation.close(); }
  assert.equal(setup.chats.size, 3);
  assert.ok(!setup.calls[2].messages[0].content.includes('Remember violet'));
});

test('stale central and legacy workspace locks do not require manual cleanup', async t => {
  const setup = await fixture(t);
  let conversation = await setup.open();
  const location = conversation.location;
  await conversation.close();
  await fs.writeFile(location + '.lock', JSON.stringify({ pid: 2147483647 }) + '\n');
  await fs.mkdir(path.join(setup.root, '.agent', 'chat'), { recursive: true });
  await fs.writeFile(path.join(setup.root, '.agent', 'chat', 'prompt.json.lock'), JSON.stringify({ pid: process.pid }) + '\n');
  conversation = await setup.open();
  await conversation.close();
  await assert.rejects(fs.access(location + '.lock'));
});

test('interrupted responses preserve completed history and restore to a new remote branch', async t => {
  const setup = await fixture(t);
  let conversation = await setup.open();
  await conversation.send('Remember copper');
  setup.fail();
  await assert.rejects(conversation.send('Unfinished request'), /disconnected/);
  const location = conversation.location;
  await conversation.close();
  assert.equal(JSON.parse(await fs.readFile(location)).pending, true);
  conversation = await setup.open();
  try { await conversation.send('Resume from the completed exchange'); } finally { await conversation.close(); }
  assert.equal(setup.chats.size, 2);
  const content = setup.calls[2].messages[0].content;
  assert.match(content, /Remember copper/);
  assert.ok(!content.includes('Unfinished request'));
  assert.ok(!content.includes('Answer 2'));
  assert.equal(setup.calls[2].parent_id, null);
});

test('agent continuation sends new observations; new account resumes the exact MCP checkpoint', { timeout: 20000 }, async t => {
  const setup = await fixture(t);
  const tools = await bridge({ root: setup.root, autonomous: true });
  t.after(() => tools.close());
  const id = crypto.randomUUID();
  const location = path.join(setup.root, '.agent', `${id}.json`);
  setup.replies.push(JSON.stringify({ action: 'tool', summary: 'Create code.', tool: 'local.write', arguments: { file: 'hello.js', content: 'console.log("continued");' } }));
  let conversation = await setup.open({ name: id, snapshot: true });
  const model = (prompt, options) => conversation.send(prompt, options);
  const first = await run({ task: 'Create hello.js, run it, and report.', model, bridge: tools, location, steps: 1 });
  await conversation.close();
  assert.equal(first.status, 'limit');
  assert.equal(await (await memory(setup.root)).latest(), id);
  assert.match(await fs.readFile(path.join((await memory(setup.root)).directory, 'context.md'), 'utf8'), /local.write: completed/);
  setup.switch('beta');
  setup.replies.push(JSON.stringify({ action: 'tool', summary: 'Verify code.', tool: 'local.run', arguments: { command: process.execPath, args: ['hello.js'] } }));
  setup.replies.push(JSON.stringify({ action: 'final', message: 'Verified continued output.' }));
  conversation = await setup.open({ name: id, snapshot: true });
  let result;
  try { result = await run({ model, bridge: tools, location, resume: true, steps: 3 }); }
  finally { await conversation.close(); }
  assert.equal(result.status, 'complete');
  assert.equal(setup.chats.size, 2);
  assert.match(setup.calls[1].messages[0].content, /local.write/);
  assert.match(setup.calls[2].messages[0].content, /NEW OBSERVATIONS/);
  assert.match(setup.calls[2].messages[0].content, /continued/);
  assert.ok(!setup.calls[2].messages[0].content.includes('Operating guidance:'));
  assert.deepEqual(result.history.filter(item => item.role === 'tool').map(item => item.tool), ['local.write', 'local.run']);
});

test('malformed state and symlinked project memory fail without overwriting data', async t => {
  const setup = await fixture(t);
  const conversation = await setup.open();
  const location = conversation.location;
  await conversation.close();
  await fs.writeFile(location, '{bad');
  await assert.rejects(setup.open());
  assert.equal(await fs.readFile(location, 'utf8'), '{bad');
  await fs.rm(location);
  await fs.rm(path.join(setup.root, 'context.md'));
  await fs.symlink(setup.location, path.join(setup.root, 'context.md'));
  const another = await setup.open();
  try { await assert.rejects(another.send('hello'), /regular text file/); }
  finally { await another.close(); }
  assert.equal(setup.calls.length, 0);
});

test('latest resume discovers legacy checkpoints and preserves uncertain tool markers', async t => {
  const setup = await fixture(t);
  const notes = await memory(setup.root);
  await assert.rejects(notes.latest(), /No latest run/);
  const id = crypto.randomUUID();
  const state = { schema: 1, id, root: setup.root, task: 'Legacy task.', status: 'cancelled', steps: 1, plan: ['Verify work'], history: [], pending: { tool: 'local.run', arguments: { command: 'node' } } };
  const location = path.join(notes.directory, `${id}.json`);
  await fs.writeFile(location, JSON.stringify(state));
  assert.equal(await notes.latest(), id);
  assert.match(await fs.readFile(path.join(notes.directory, 'context.md'), 'utf8'), /local.run/);
  await assert.rejects(run({ bridge: { root: setup.root }, location, resume: true, model: async () => { throw new Error('Must not call model'); } }), /may have run/);
  assert.deepEqual(JSON.parse(await fs.readFile(location)).pending, state.pending);
});

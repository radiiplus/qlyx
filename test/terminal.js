import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath as filename } from 'node:url';
import { database } from '../module/database.js';
import { store, origin } from '../module/session.js';
import { store as storage } from '../module/store.js';
import { PassThrough as Stream } from 'node:stream';
import { terminal } from '../module/terminal.js';
import { stripVTControlCharacters as strip } from 'node:util';

const entry = filename(new URL('../chat.js', import.meta.url));

test('input has a separate shaded container and margins while edits survive loading, wrapping, and resizing', async t => {
  const term = process.env.TERM; process.env.TERM = 'xterm-256color';
  t.after(() => { if (term === undefined) delete process.env.TERM; else process.env.TERM = term; });
  const input = new Stream(), output = new Stream();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {};
  output.columns = 48; output.rows = 20;
  let screen = ''; output.on('data', chunk => { screen += chunk; });
  const ui = terminal({ input, output }); t.after(() => ui.close());
  const pending = ui.read();
  input.write('A long draft with 中文 and enough text to wrap across several terminal rows.');
  screen = '';
  ui.status('Running verification');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.match(strip(screen), /Running verification/);
  // A status update must leave the shaded draft and its margins untouched.
  assert.doesNotMatch(strip(screen), /› A long draft/);
  assert.ok(!screen.includes('\x1b[J'));
  ui.write('command output\n');
  output.columns = 32; output.emit('resize');
  input.write('\x1b[D\x7f!');
  input.write('\x14\x14\n');
  const expected = 'A long draft with 中文 and enough text to wrap across several terminal row!.';
  assert.equal(await pending, expected);
  const next = ui.read();
  input.write('\x1b[A\n');
  assert.equal(await next, expected);
});

test('terminal preserves partially typed prompts through activity redraws and keeps approval input separate', async t => {
  const input = new Stream();
  const output = new Stream();
  input.isTTY = output.isTTY = true;
  input.setRawMode = () => {};
  output.columns = 80;
  output.resume();
  const ui = terminal({ input, output });
  t.after(() => ui.close());
  const first = ui.read();
  input.write('Follow');
  ui.status('Running node');
  ui.write('  │ command output\n');
  input.write(' up\n');
  assert.equal(await first, 'Follow up');
  input.write('queued task\n');
  const approval = ui.approve({ tool: 'local.run', arguments: { command: 'node' } });
  input.write('y\n');
  assert.equal(await approval, true);
  assert.equal(await ui.read(), 'queued task');
  const controller = new AbortController();
  const pending = ui.approve({ tool: 'local.write', arguments: { file: 'sample' } }, controller.signal);
  controller.abort();
  assert.equal(await pending, false);
  input.end();
  assert.equal(await ui.read(), null);
});
async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-'));
  const root = path.join(folder, 'workspace');
  await fs.mkdir(root);
  const location = path.join(folder, 'session.db');
  const credentials = path.join(folder, 'authentication.json');
  await store(credentials, { schema: 1, origin, local: {}, tab: {}, cookies: [{ name: 'token', value: 'fixture-token', domain: 'chat.qwen.ai', path: '/', expires: -1 }] });
  const provider = path.join(folder, 'provider.mjs');
  const requests = path.join(folder, 'requests.json');
  await fs.writeFile(provider, `import fs from 'node:fs/promises';
let turn=0, remote=0;
const actions=[
 {action:'tool',summary:'Create an executable script',tool:'local.write',arguments:{file:'hello.js',content:'console.log("verified");\\n'}},
 {action:'tool',summary:'Verify the script in the terminal',tool:'local.run',arguments:{command:process.execPath,args:['hello.js']}},
 {action:'final',message:'Created and verified hello.js.'},
 {action:'tool',summary:'Read the existing script',tool:'local.read',arguments:{file:'hello.js'}},
 {action:'final',message:'Follow-up retained the original task and script.'}
];
globalThis.fetch=async (url,options)=>{
 if(url.pathname.endsWith('/auths/'))return Response.json({id:'fixture-user'});
 if(url.pathname.endsWith('/models/'))return Response.json({data:{data:[{id:'fixture'}]}});
 if(url.pathname.endsWith('/new'))return Response.json({data:{id:'remote-'+process.pid+'-'+(++remote)}});
 const body=JSON.parse(options.body);
 await fs.appendFile(${JSON.stringify(requests)},JSON.stringify(body)+'\\n');
 const text=JSON.stringify(actions[turn++]||{action:'final',message:'Resumed from saved context.'});
 return new Response('data: '+JSON.stringify({'response.created':{response_id:'response-'+turn}})+'\\n\\n'+'data: '+JSON.stringify({choices:[{delta:{phase:'answer',content:text,status:'finished'}}]})+'\\n\\n',{headers:{'content-type':'text/event-stream'}});
};`);
  const env = { ...process.env, DATABASE: location, SESSION: credentials, NODE_OPTIONS: `--import=${provider}` };
  const catalog = await database({ location });
  t.after(async () => { catalog.close(); await fs.rm(folder, { recursive: true, force: true }); });
  return { folder, root, location, provider, requests, env, catalog };
}
function run(t, args, input, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, '--plain', '--unattended', ...args], options);
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('chat accepts queued follow-ups, executes real MCP tools, and resumes globally with the same remote conversation', { timeout: 30000 }, async t => {
  const { root, folder, location, env, catalog, requests, provider } = await fixture(t);
  const result = await run(t, ['--root', root, '--autonomous'], 'Create and verify a script\nRead it again\n/history\n/sessions\n/exit\n', { cwd: folder, env });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Added hello.js \(\+1 -0\)/);
  assert.match(result.stdout, /\$ .*hello.js/);
  assert.match(result.stdout, /│ verified/);
  assert.match(result.stdout, /exit 0/);
  assert.match(result.stdout, /Follow-up retained/);
  assert.match(result.stdout, /Saved conversation/);
  assert.equal(result.stdout.includes('\x1b'), false);
  assert.equal(await fs.readFile(path.join(root, 'hello.js'), 'utf8'), 'console.log("verified");\n');
  const rows = catalog.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'complete');
  const state = JSON.parse(await fs.readFile(path.join(storage(root, { location }).runs, rows[0].name + '.json'), 'utf8'));
  await assert.rejects(fs.access(path.join(root, '.agent')));
  assert.ok(state.history.some(entry => entry.role === 'user' && entry.content === 'Read it again'));
  let calls = (await fs.readFile(requests, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 5);
  assert.ok(calls.every(call => call.chat_id === calls[0].chat_id));
  assert.match(calls[3].messages[0].content, /Read it again/);
  await fs.writeFile(provider, (await fs.readFile(provider, 'utf8')).replace('let turn=0, remote=0;', 'let turn=5, remote=0;'));
  const resumed = await run(t, ['--resume', rows[0].id.slice(0, 8)], 'Continue with the same context\n/reset\n/mode passive\nChange branch\n/new\nDifferent task\n/exit\n', { cwd: folder, env });
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.match(resumed.stdout, /Resumed from saved context/);
  assert.match(resumed.stdout, /Previous conversation/);
  assert.match(resumed.stdout, /Create and verify a script/);
  assert.match(resumed.stdout, /Previous conversation[\s\S]*Created and verified hello\.js\./);
  assert.doesNotMatch(resumed.stdout, /\[object Object\]/);
  assert.match(resumed.stdout, new RegExp(root));
  assert.equal(catalog.list().length, 2);
  calls = (await fs.readFile(requests, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls[5].chat_id, calls[0].chat_id);
  assert.equal(calls[5].parent_id, 'response-5');
  assert.notEqual(calls[6].chat_id, calls[5].chat_id);
  assert.match(calls[6].messages[0].content, /Read it again/);
  assert.notEqual(calls[7].chat_id, calls[6].chat_id);
  assert.match(calls[7].messages[0].content, /Different task/);
  const restored = await run(t, ['--resume', rows[0].id], '/plan\n/exit\n', { cwd: folder, env });
  assert.equal(restored.code, 0, restored.stderr);
  assert.match(restored.stdout, new RegExp('Run: ' + rows[0].name));
});

test('chat remains hidden until startup authentication succeeds', { timeout: 15000 }, async t => {
  const { root, folder, env, catalog } = await fixture(t);
  env.SESSION = path.join(folder, 'missing.json');
  const result = await run(t, ['--root', root], '/continue\nTry a prompt\n/help\n/new\n/mode passive\n/sessions\n/exit\n', { cwd: folder, env });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /Error: No saved Qwen session/);
  assert.doesNotMatch(result.stdout, /QLYX · coding/);
  assert.doesNotMatch(result.stdout, /Type a prompt/);
  assert.doesNotMatch(result.stdout, /→ you/);
  assert.equal(catalog.list().length, 0);
});

test('cancelling a running tool keeps the chat open and prevents automatic replay', { timeout: 20000 }, async t => {
  const { root, folder, env, catalog, provider } = await fixture(t);
  await fs.writeFile(provider, (await fs.readFile(provider, 'utf8')).replace('args:[\'hello.js\']', 'args:[\'-e\',\'console.log("waiting");setInterval(()=>{},1000)\']'));
  const child = spawn(process.execPath, [entry, '--root', root, '--autonomous', '--plain', '--unattended'], { cwd: folder, env });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '', stderr = '', stopped = false, resumed = false;
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => {
    stdout += data;
    if (!stopped && stdout.includes('│ waiting')) { stopped = true; child.kill('SIGINT'); }
    if (!resumed && stdout.includes('Turn cancelled.')) { resumed = true; child.stdin.end('Try again\n/help\n/exit\n'); }
  });
  const exit = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  child.stdin.write('Run a long command\n');
  assert.equal(await exit, 0, stderr);
  assert.equal(stopped, true);
  assert.match(stdout, /previous tool has an uncertain result/);
  assert.match(stdout, /Ctrl\+C cancels/);
  assert.equal(catalog.list()[0].status, 'cancelled');
  const state = JSON.parse(await fs.readFile(path.join(storage(root, { location: catalog.location }).runs, catalog.list()[0].name + '.json'), 'utf8'));
  assert.equal(state.pending.tool, 'local.run');
});

test('model and automatic approval settings change through chat commands without losing the session', { timeout: 30000 }, async t => {
  const { root, folder, env, catalog, provider, requests } = await fixture(t);
  let text = await fs.readFile(provider, 'utf8');
  text = text.replace("[{id:'fixture'}]", "[{id:'fixture'},{id:'alternate'}]");
  text = text.replace("{action:'final',message:'Created and verified hello.js.'}", "{action:'final',message:'Created and verified hello.js.',plan:['[x] Create the script','[x] Verify output']}");
  await fs.writeFile(provider, text);
  const result = await run(t, ['--root', root], '/plan status\n/approval on\n/plan status\nCreate and verify a script\n/model alternate\nRead it again\n/auto off\n/plan\n/exit\n', { cwd: folder, env });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Model: alternate/);
  assert.match(result.stdout, /autonomous → guided/);
  assert.equal(result.stdout.split('QLYX · coding').length - 1, 1);
  const runs = [...result.stdout.matchAll(/Run: ([a-f0-9-]{36})/g)].map(match => match[1]);
  assert.ok(runs.length >= 2);
  assert.equal(runs[0], runs[1]);
  assert.equal(catalog.list().length, 1);
  const calls = (await fs.readFile(requests, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls[0].model, 'fixture');
  assert.equal(calls[3].model, 'alternate');
  assert.notEqual(calls[3].chat_id, calls[0].chat_id);
  assert.match(calls[3].messages[0].content, /Create and verify a script/);
  const plan = await fs.readFile(path.join(root, 'plan.md'), 'utf8');
  assert.match(plan, /Status: complete/);
  assert.match(plan, /Tools completed: 3/);
  assert.match(plan, /Read it again/);
  const state = JSON.parse(await fs.readFile(path.join(storage(root, { location: catalog.location }).runs, catalog.list()[0].name + '.json'), 'utf8'));
  assert.equal(state.id, runs[0]);
  assert.ok(state.history.some(entry => entry.content?.plan?.includes('[x] Verify output')));
  assert.deepEqual(state.plan, []);
});

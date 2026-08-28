import assert from 'node:assert/strict';
import { execFile as launch, spawn as start } from 'node:child_process';
import { mkdir, mkdtemp, readFile as fetch, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type WebSocket from 'ws';
import { build } from '../src/server.ts';
import { Engine, Fault, setting, Tool, type Page } from '../src/tool.ts';

const execute = promisify(launch);

async function session(entry: string, input: string, cwd: string): Promise<string[]> {
  return await new Promise<string[]>((done, fail) => {
    const child = start(process.execPath, [entry, 'serve'], { cwd });
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
    engine: { limit: 2, wait: 2000 },
    server: { host: '127.0.0.1', port: 0, path: '/socket', bytes: 1024, token: '' },
    commands: {
      list: 'scan',
      read: 'view',
      exec: 'run',
      create: 'make',
      edit: 'change',
      delete: 'erase',
      status: 'state',
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
  await writeFile(file, 'const before = true;\nfunction old() {\n  return false;\n}\nconst after = true;\n');
  const result = await tool.edit({
    path: file,
    before: 'function old() {\n  return false;\n}',
    after: 'function current() {\n  return true;\n}',
  });
  const content = await fetch(file, 'utf8');

  assert.equal(result.changed, true);
  assert.equal(result.index, 1);
  assert.equal(content, 'const before = true;\nfunction current() {\n  return true;\n}\nconst after = true;\n');
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
  const result = await execute(process.execPath, [entry, 'edit', '--spec', patch], { cwd: root });
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

test('returns progress after a soft wait and keeps the execution running', async (t) => {
  const root = await fixture(t);
  const config = setting();
  config.engine.wait = 2000;
  const engine = new Engine(new Tool(root, config), config);
  const script = "process.stdout.write('start');setTimeout(() => process.stdout.write(' end'), 700)";
  const first = await engine.run({
    id: 'job',
    action: 'exec',
    words: [process.execPath, '-e', script],
    wait: 250,
  });

  assert.equal(first.ok, true);
  assert.equal((first.data as { state: string }).state, 'running');
  assert.match((first.data as { output: string }).output, /start/);
  assert.equal(engine.active, 1);

  const current = await engine.run({ id: 'poll-1', action: 'status', target: 'job' });
  assert.equal((current.data as { state: string }).state, 'running');
  assert.equal((current.data as { target: string }).target, 'job');

  const final = await engine.run({ id: 'poll-2', action: 'status', target: 'job', wait: 1500 });
  assert.equal((final.data as { state: string }).state, 'done');
  assert.equal((final.data as { output: string }).output, 'start end');
  assert.equal(engine.active, 0);
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

test('serves correlated concurrent operations over WebSocket', async (t) => {
  const root = await fixture(t);
  const config = setting();
  config.server.port = 0;
  const app = await build({ base: root, config, logger: false });
  await app.ready();

  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.deepEqual(health.json(), { ok: true });
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
  assert.deepEqual(reply, { kind: 'pong' });
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
  const result = await execute(process.execPath, [entry, 'read', file, '--size', '1', '--id', 'file-1']);
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
    engine: { limit: 2, wait: 2000 },
    server: { host: '127.0.0.1', port: 0, path: '/socket', bytes: 1024, token: '' },
    commands: {
      list: 'scan',
      read: 'view',
      exec: 'run',
      create: 'make',
      edit: 'change',
      delete: 'erase',
      status: 'state',
      serve: 'listen',
      help: 'info',
    },
  };
  await writeFile(file, JSON.stringify(data));
  assert.deepEqual(setting(file), data);

  const entry = path.resolve('src/tool.ts');
  const result = await execute(process.execPath, [entry, 'view', 'notes.txt', '--config', file], { cwd: root });
  const body = JSON.parse(result.stdout);
  assert.deepEqual(body.data.lines, [{ line: 1, text: 'one' }]);
  assert.equal(body.data.next.start, 2);

  const run = await execute(process.execPath, [
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
    engine: { limit: 2, wait: 2000 },
    server: { host: '127.0.0.1', port: 0, path: '/socket', bytes: 1024, token: '' },
    commands: {
      list: 'run',
      read: 'run',
      exec: 'exec',
      create: 'create',
      edit: 'edit',
      delete: 'delete',
      status: 'status',
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
  assert.deepEqual(health.json(), { ok: true });

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
  assert.equal(empty.data.items.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough as Stream } from 'node:stream';
import { stripVTControlCharacters as strip } from 'node:util';
import { journal } from '../module/journal.js';
import { activity } from '../module/activity.js';
import { terminal } from '../module/terminal.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'view-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const book = journal({ root, name: 'fixture' });
  const feed = activity({ plain: true, output: { write() {} }, redact: text => text.replaceAll('secret', '[REDACTED]') });
  feed.attach(book);
  return { root, book, feed };
}

test('saved session, progress, directory and file events render content instead of JSON envelopes', async t => {
  const { book, feed, root } = await fixture(t);
  book.append({ type: 'session', id: 'session', run: 'run', root });
  book.append({ type: 'pending', step: 2 });
  book.append({ type: 'tool', tool: 'local.list', summary: 'Inspect workspace', arguments: { directory: '.' } });
  book.append({ type: 'result', tool: 'local.list', content: JSON.stringify({ directory: '.', entries: [{ name: 'src', type: 'directory' }, { name: 'package.json', type: 'file' }], truncated: false }) });
  const listing = feed.inspect().join('\n');
  assert.match(listing, /Directory: \.\n  src\/\n  package.json/);
  book.append({ type: 'tool', tool: 'local.read', arguments: { file: 'server.ts' } });
  book.append({ type: 'result', tool: 'local.read', content: JSON.stringify({ file: 'server.ts', content: 'const server = "secret";\nserver.listen();', digest: 'digest', start: 1, total: 2 }) });
  const output = feed.inspect().join('\n');
  assert.match(output, /const server = "\[REDACTED\]";\nserver.listen\(\);/);
  assert.equal(feed.inspect(undefined, 'output', { rich: true }).find(row => row.kind === 'code').language, 'typescript');
  feed.attach(journal({ root, name: 'fixture' }));
  const transcript = feed.transcript().join('\n');
  assert.match(transcript, /Session connected/);
  assert.match(transcript, /Waiting for Qwen · step 2/);
  assert.match(transcript, /INPUT\nDirectory: \./);
  assert.match(transcript, /  src\//);
  assert.doesNotMatch(transcript + listing + output, /"(?:type|entries|digest|directory|content)":|\\n|secret|\[object Object\]/);
  assert.equal(feed.inspect().join('\n'), output);
});

test('output shows streams, exit reason and capture limits without repeating streamed output', async t => {
  const { book, feed } = await fixture(t);
  book.append({ type: 'tool', tool: 'local.run', arguments: { command: 'node', args: ['server.js'] } });
  book.append({ type: 'output', stream: 'stdout', text: 'listening\n' });
  book.append({ type: 'output', stream: 'stderr', text: 'connection closed\n' });
  book.append({ type: 'result', tool: 'local.run', error: true, content: JSON.stringify({ stdout: 'listening\n', stderr: 'connection closed\n', code: 1, signal: 'SIGTERM', reason: 'Timed out', truncated: true, omitted: 12 }) });
  const output = feed.inspect().join('\n');
  assert.equal(output.match(/listening/g).length, 1);
  assert.match(output, /stderr\nconnection closed/);
  assert.match(output, /Exit code: 1/);
  assert.match(output, /Terminated by signal: SIGTERM/);
  assert.match(output, /Reason: Timed out/);
  assert.match(output, /Capture limit: 12/);
  assert.match(feed.transcript().join('\n'), /\$ node server.js/);
});

test('generic results use labeled fields and Markdown fences become code rows', async t => {
  const { book, feed } = await fixture(t);
  book.append({ type: 'tool', tool: 'custom.fetch', arguments: { url: 'https://example.test' } });
  book.append({ type: 'result', tool: 'custom.fetch', content: JSON.stringify({ title: 'Example', links: [{ text: 'Docs', url: '/docs' }], message: 'Example:\n```strange\n<literal>\n```', truncated: true }) });
  assert.match(feed.inspect().join('\n'), /Title: Example/);
  assert.match(feed.inspect().join('\n'), /Url: \/docs/);
  assert.match(feed.inspect().join('\n'), /Saved result is an excerpt/);
  assert.ok(feed.inspect(undefined, 'output', { rich: true }).some(row => row.kind === 'code' && row.text === '<literal>' && row.language === 'strange'));
});

test('Ctrl+T and Ctrl+O retain syntax and full row backgrounds through wrapping, scrolling and live refresh', async t => {
  const term = process.env.TERM, color = process.env.NO_COLOR;
  process.env.TERM = 'xterm-256color'; delete process.env.NO_COLOR;
  t.after(() => { if (term === undefined) delete process.env.TERM; else process.env.TERM = term; if (color !== undefined) process.env.NO_COLOR = color; });
  const { book, feed } = await fixture(t);
  book.append({ type: 'tool', tool: 'local.read', arguments: { file: 'server.ts' } });
  book.append({ type: 'result', tool: 'local.read', content: JSON.stringify({ file: 'server.ts', content: 'const server = "a sufficiently long string that wraps";\n\nserver.listen();' }) });
  const input = new Stream(), output = new Stream();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = 36; output.rows = 30;
  let screen = ''; output.on('data', chunk => { screen += chunk; });
  const ui = terminal({ input, output, transcript: () => feed.transcript({ rich: true }), inspect: () => feed.inspect(undefined, 'output', { rich: true }) });
  t.after(() => ui.close());
  const pending = ui.read(); input.write('draft'); screen = ''; input.write('\x14');
  assert.match(screen, /\x1b\[35mconst/);
  assert.ok(screen.includes('\x1b[48;2;22;24;29;97m' + ' '.repeat(35) + '\x1b[0m'));
  for (const line of strip(screen).split('\n').filter(line => /const server|that wraps|server.listen/.test(line))) assert.equal(line.length, 35);
  assert.doesNotMatch(screen, /"content":|\[object Object\]/);
  book.append({ type: 'pending', step: 3 }); ui.update();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.match(strip(screen), /Waiting for Qwen · step 3/);
  screen = ''; input.write('\x0f');
  assert.match(screen, /OUTPUT/); assert.match(screen, /\x1b\[35mconst/);
  output.columns = 28; output.emit('resize');
  assert.ok(screen.includes('\x1b[48;2;22;24;29;97m' + ' '.repeat(27) + '\x1b[0m'));
  input.write('\x1b[5~'); input.write('\x1b[F'); input.write('\x0f'); input.write('\n');
  assert.equal(await pending, 'draft');
});

test('noninteractive viewers print semantic rows without object strings or colors', () => {
  const input = new Stream(), output = new Stream();
  let screen = ''; output.on('data', chunk => { screen += chunk; });
  const ui = terminal({ input, output });
  ui.view('output', () => [{ text: 'const answer = 42;', kind: 'code', language: 'javascript' }]);
  ui.close();
  assert.equal(screen, 'const answer = 42;\n');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters as strip } from 'node:util';
import { PassThrough as Stream } from 'node:stream';
import { syntax, shell, language } from '../module/style.js';
import { terminal } from '../module/terminal.js';

test('code uses white defaults, language syntax, contrasting diff backgrounds, and plain fallback', () => {
  const text = 'const answer = "hello";';
  assert.equal(language('src/index.ts'), 'typescript');
  const code = syntax(text, 'typescript');
  assert.match(code, /\x1b\[97m/);
  assert.match(code, /\x1b\[35mconst/);
  assert.equal(strip(code), text);
  const unknown = syntax('literal source', 'unknown');
  assert.equal(unknown, '\x1b[97mliteral source\x1b[0m');
  assert.match(syntax(text, 'typescript', { kind: 'added' }), /48;2;18;36;25/);
  assert.match(syntax(text, 'typescript', { kind: 'removed' }), /48;2;42;23;26/);
  assert.ok(!syntax(text, 'typescript', { kind: 'context' }).includes('48;'));
  assert.equal(syntax(text, 'typescript', { plain: true, kind: 'added' }), text);
  const command = 'node --test "my test.js" | cat';
  assert.equal(strip(shell(command)), command);
  assert.match(shell(command), /\x1b\[33mnode/);
  assert.match(shell(command), /\x1b\[36m--test/);
});

test('slash dropdown filters, navigates, fills without submitting, and preserves input through transcript toggles', async t => {
  const input = new Stream(), output = new Stream();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = 60;
  let screen = ''; output.on('data', chunk => { screen += chunk; });
  const commands = [{ value: '/model', description: 'Choose model' }, { value: '/auto on', description: 'Enable approval' }, { value: '/auto off', description: 'Disable approval' }];
  const ui = terminal({ input, output, suggest: value => commands.filter(item => item.value.startsWith(value)) });
  t.after(() => ui.close());
  const pending = ui.read(); let submitted = false; pending.then(() => { submitted = true; });
  input.write('/');
  assert.match(screen, /Choose model/);
  input.write('\x1b[B'); input.write('\t');
  await Promise.resolve(); assert.equal(submitted, false);
  input.write('\x14'); input.write('\x14'); input.write('\r');
  assert.equal(await pending, '/auto on');
  const next = ui.read(); input.write('/mod'); input.write('\r');
  assert.equal(await next, '/model');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough as Stream } from 'node:stream';
import { suggest, resolve } from '../module/menu.js';
import { terminal } from '../module/terminal.js';

test('slash categories drill down locally and only submit leaf commands', async t => {
  const input = new Stream(), output = new Stream();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = 80;
  let screen = ''; output.on('data', chunk => { screen += chunk; });
  const ui = terminal({ input, output, suggest }); t.after(() => ui.close());
  assert.ok(suggest('/').every(item => !item.value.includes(' ')));
  assert.deepEqual(suggest('/plan ').map(item => item.label), ['status', 'steps', 'progress']);
  assert.equal(resolve('/inspect output abc'), '/output abc');
  assert.equal(resolve('/session resume'), '/sessions');
  assert.equal(resolve('/approval on'), '/auto on');
  let submitted = false;
  const pending = ui.read(); pending.then(() => { submitted = true; });
  input.write('/plan\r');
  await Promise.resolve(); assert.equal(submitted, false);
  assert.match(screen, /Inspect live milestones/);
  input.write('\x1b'); await new Promise(resolve => setTimeout(resolve, 550));
  assert.match(screen, /Tool permissions/);
  input.write('approval\r'); input.write('\r');
  assert.equal(await pending, '/auto on');
  assert.ok(!screen.includes('\x1b[?1049h'));
});

test('inline selection filters and cancels without a new screen or consuming the draft', async t => {
  const input = new Stream(), output = new Stream();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.columns = 70;
  let screen = ''; output.on('data', chunk => { screen += chunk; });
  const ui = terminal({ input, output }); t.after(() => ui.close());
  const pending = ui.read(); input.write('keep this draft');
  const rows = [{ id: 'fast', title: 'Fast model' }, { id: 'deep', title: 'Deep model' }];
  const selected = ui.select(rows, 'model');
  input.write('deep\n');
  assert.equal((await selected).id, 'deep');
  const cancelled = ui.select(rows, 'model'); input.write('\x03');
  assert.equal(await cancelled, null);
  input.write('\n'); assert.equal(await pending, 'keep this draft');
  assert.match(screen, /Deep model/);
  assert.ok(!screen.includes('\x1b[?1049h'));
});

test('an arriving tool approval dismisses inline progress inspection and receives its own answer', async t => {
  const input = new Stream(), output = new Stream();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {}; output.resume();
  const ui = terminal({ input, output }); t.after(() => ui.close()); ui.show();
  const selected = ui.select([{ id: 'step', title: '[~] Verify the script' }], 'plan');
  const approved = ui.approve({ tool: 'local.run', summary: 'Verify the script', arguments: { command: 'node' } });
  assert.equal(await selected, null);
  input.write('y\n');
  assert.equal(await approved, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough as Stream } from 'node:stream';
import { terminal } from '../module/terminal.js';

function fixture(t, options = {}) {
  const term = process.env.TERM; process.env.TERM = 'xterm-256color';
  t.after(() => { if (term === undefined) delete process.env.TERM; else process.env.TERM = term; });
  const input = new Stream(), output = new Stream();
  input.isTTY = output.isTTY = true; input.setRawMode = () => {};
  output.columns = 70; output.rows = 22;
  const chunks = [];
  output.on('data', chunk => chunks.push(String(chunk)));
  const ui = terminal({ input, output, ...options });
  t.after(() => ui.close());
  return { input, output, chunks, ui };
}
const pause = () => new Promise(resolve => setTimeout(resolve, 70));

test('spinner frames only update the status row and retain the editing cursor', async t => {
  const { input, chunks, ui } = fixture(t);
  const pending = ui.read();
  input.write('a draft'); input.write('\x1b[D');
  chunks.length = 0; ui.status('Running checks'); await pause();
  assert.match(chunks.join(''), /Running checks/);
  chunks.length = 0;
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.ok(chunks.length >= 1 && chunks.length <= 4);
  for (const chunk of chunks) {
    assert.match(chunk, /Running checks/);
    assert.doesNotMatch(chunk, /a draft|\x1b\[J|\x1b\[2J|\n/);
    assert.ok(chunk.startsWith('\x1b[?25l') && chunk.endsWith('\x1b[?25h'));
  }
  input.write('!\n'); assert.equal(await pending, 'a draf!t');
});

test('bursts of activity share one redraw and keep output order and the queued draft', async t => {
  const { input, chunks, ui } = fixture(t);
  const pending = ui.read(); input.write('keep'); chunks.length = 0;
  for (let index = 0; index < 100; index++) { ui.write(`log ${index}\n`); ui.status('Checks'); ui.context({ plan: 'plan 1/2' }); }
  assert.equal(chunks.length, 0);
  await pause();
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].includes(Array.from({ length: 100 }, (_, index) => `log ${index}\n`).join('')));
  assert.equal(chunks[0].split('\x1b[J').length - 1, 1);
  input.write(' typing\n'); assert.equal(await pending, 'keep typing');
});

test('unchanged footers and viewers emit nothing; scrolling and incoming entries repaint changed rows only', async t => {
  let events = Array.from({ length: 35 }, (_, index) => 'event ' + index);
  const { input, chunks, ui } = fixture(t, { transcript: () => events });
  const pending = ui.read(); input.write('preserve');
  ui.context({ mode: 'guided' }); await pause(); chunks.length = 0;
  for (let index = 0; index < 20; index++) { ui.context({ mode: 'guided' }); ui.show(); ui.update(); }
  await pause(); assert.equal(chunks.length, 0);
  input.write('\x14'); assert.match(chunks.join(''), /TRANSCRIPT/); chunks.length = 0;
  for (let index = 0; index < 20; index++) ui.update();
  await pause(); assert.equal(chunks.length, 0);
  input.write('\x1b[H'); chunks.length = 0;
  events.push('incoming'); ui.update(); await pause();
  assert.doesNotMatch(chunks.join(''), /event 0|incoming|\x1b\[2J/);
  chunks.length = 0; input.write('\x1b[F');
  assert.match(chunks.join(''), /incoming/); assert.doesNotMatch(chunks.join(''), /\x1b\[2J/);
  input.write('\x14\n'); assert.equal(await pending, 'preserve');
});

test('closing flushes buffered output and leaves no delayed redraw', async t => {
  const { chunks, ui } = fixture(t); ui.show(); chunks.length = 0;
  ui.write('last output\n'); ui.close();
  assert.match(chunks.join(''), /last output/);
  const length = chunks.length; await pause(); assert.equal(chunks.length, length);
});

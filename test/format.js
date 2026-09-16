import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters as strip } from 'node:util';
import { format } from '../module/format.js';

function fixture(options = {}) {
  const chunks = [];
  const renderer = format({ output: { isTTY: true, columns: 60, write: (text) => chunks.push(text) }, color: true, ...options });
  return { renderer, text: () => chunks.join('') };
}

const example = 'Here is **a closure** using `count`:\n\n```javascript\nfunction createCounter() {\n  let count = 0;\n  return () => ++count;\n}\n```\n\nIt remembers its state.\n';

test('chunk boundaries do not change code capture or formatting', () => {
  const first = fixture();
  first.renderer.write(example);
  first.renderer.finish();
  const second = fixture();
  for (const char of example) second.renderer.write(char);
  second.renderer.finish();
  assert.equal(first.text(), second.text());
  assert.match(first.text(), /\u001b\[35mfunction/);
  assert.match(strip(first.text()), /╭─ javascript/);
  assert.match(strip(first.text()), /│   let count = 0;/);
  assert.ok(!strip(first.text()).includes('```'));
  assert.match(strip(first.text()), /Here is a closure using count:/);
  assert.deepEqual(first.renderer.blocks, [{ language: 'javascript', code: 'function createCounter() {\n  let count = 0;\n  return () => ++count;\n}', complete: true }]);
});

test('pipes and plain mode preserve Markdown and emit no styling', () => {
  for (const options of [{ plain: true }, { output: { isTTY: false } }]) {
    const chunks = [];
    const renderer = format({ ...options, output: { isTTY: !options.output, write: (text) => chunks.push(text) } });
    for (const char of example) renderer.write(char);
    renderer.finish();
    assert.equal(chunks.join(''), example);
    assert.ok(!chunks.join('').includes('\u001b'));
  }
});

test('longer and tilde fences keep shorter fences inside code', () => {
  const { renderer, text } = fixture({ color: false });
  renderer.write('````markdown\n```js\nconst x = 1;\n```\n````\n~~~python\nprint("hi")\n~~~\n');
  renderer.finish();
  assert.equal(renderer.blocks.length, 2);
  assert.equal(renderer.blocks[0].code, '```js\nconst x = 1;\n```');
  assert.equal(renderer.blocks[1].language, 'python');
  assert.ok(!text().includes('\u001b'));
});

test('unknown languages and unlabeled code preserve literal source', () => {
  const { renderer, text } = fixture();
  renderer.write('```unknownlanguage\n**literal** <tag> & value\n```\n```\nplain code\n```');
  renderer.finish();
  assert.equal(renderer.blocks[0].code, '**literal** <tag> & value');
  assert.match(strip(text()), /\*\*literal\*\* <tag> & value/);
  assert.match(strip(text()), /╭─ code/);
});

test('partial code is flushed once and marked incomplete', () => {
  const { renderer, text } = fixture({ color: false });
  renderer.write('```js\nconst answer = 42;');
  renderer.finish();
  const finished = text();
  renderer.finish();
  assert.equal(text(), finished);
  assert.match(text(), /const answer = 42;/);
  assert.match(text(), /incomplete/);
  assert.equal(renderer.blocks[0].complete, false);
  assert.throws(() => renderer.write('more'), /finished/);
});

test('CRLF, empty blocks, and final prose without newline render correctly', () => {
  const { renderer, text } = fixture({ color: false });
  renderer.write('# Title\r\n\r\n```\r\n```\r\n- **Done**');
  renderer.finish();
  assert.equal(renderer.blocks[0].code, '');
  assert.match(text(), /^Title\n/);
  assert.match(text(), /• Done\n$/);
});

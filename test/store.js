import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrate } from '../module/store.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qlyx-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { source: path.join(root, 'qwen'), target: path.join(root, 'qlyx') };
}

test('legacy state moves into the qlyx data directory', async t => {
  const { source, target } = await fixture(t);
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'session.json'), 'saved');
  assert.equal(await migrate(source, target), true);
  assert.equal(await fs.readFile(path.join(target, 'session.json'), 'utf8'), 'saved');
  await assert.rejects(fs.access(source), error => error.code === 'ENOENT');
  assert.equal((await fs.stat(target)).mode & 0o777, 0o700);
});

test('legacy state fills missing qlyx files without replacing current state', async t => {
  const { source, target } = await fixture(t);
  await fs.mkdir(source);
  await fs.mkdir(target);
  await fs.writeFile(path.join(source, 'session.json'), 'old');
  await fs.writeFile(path.join(source, 'skill.md'), 'skill');
  await fs.writeFile(path.join(target, 'session.json'), 'current');
  assert.equal(await migrate(source, target), true);
  assert.equal(await fs.readFile(path.join(target, 'session.json'), 'utf8'), 'current');
  assert.equal(await fs.readFile(path.join(target, 'skill.md'), 'utf8'), 'skill');
  assert.equal(await migrate(path.join(source, 'missing'), target), false);
});

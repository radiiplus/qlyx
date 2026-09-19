import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { bridge } from '../module/mcp.js';
import { run, parse } from '../module/agent.js';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-'));
  const tools = await bridge({ root, autonomous: true, ...options });
  t.after(async () => { await tools.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, tools, location: path.join(root, '.agent', 'fixture.json') };
}
const decode = (result) => JSON.parse(result.content);
const action = (tool, args) => ({ text: JSON.stringify({ action: 'tool', summary: 'Perform the next verified step.', tool, arguments: args }) });

test('MCP tools edit with digests, reject stale writes, search and enforce file scope', { timeout: 20000 }, async (t) => {
  const { root, tools } = await fixture(t);
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'config', 'session.json'), 'secret');
  await fs.writeFile(path.join(root, '.env'), 'secret');
  assert.equal((await tools.call('local.write', { file: 'sample.js', content: 'const answer = 1;\n' })).error, false);
  const original = decode(await tools.call('local.read', { file: 'sample.js' }));
  assert.equal((await tools.call('local.edit', { file: 'sample.js', before: '1', after: '2', hash: original.digest })).error, false);
  assert.equal((await tools.call('local.write', { file: 'sample.js', content: 'bad', hash: original.digest })).error, true);
  assert.equal(await fs.readFile(path.join(root, 'sample.js'), 'utf8'), 'const answer = 2;\n');
  for (const file of ['../outside', 'config/session.json', '.env']) assert.equal((await tools.call('local.read', { file })).error, true);
  await fs.symlink(os.tmpdir(), path.join(root, 'escape'));
  assert.equal((await tools.call('local.read', { file: 'escape/anything' })).error, true);
  assert.match(decode(await tools.call('local.search', { query: 'answer' })).stdout, /answer = 2/);
  assert.ok(!decode(await tools.call('local.list', {})).entries.some((item) => item.name === 'config' || item.name === '.env'));
});

test('guided and passive MCP modes enforce execution policy', { timeout: 20000 }, async (t) => {
  const { tools } = await fixture(t, { autonomous: false });
  assert.equal((await tools.call('local.write', { file: 'blocked', content: 'no' })).error, true);
  const passive = await fixture(t, { passive: true });
  assert.ok(!passive.tools.tools.some((tool) => ['local.run', 'local.write', 'local.click'].includes(tool.name)));
  await assert.rejects(passive.tools.call('local.run', { command: 'echo' }), /Unknown or disabled/);
});

test('MCP command output, failure and timeout are returned to the caller', { timeout: 20000 }, async (t) => {
  const { tools } = await fixture(t);
  const result = await tools.call('local.run', { command: process.execPath, args: ['-e', 'console.log("evidence"); process.exit(3)'] });
  assert.equal(result.error, true);
  assert.equal(decode(result).code, 3);
  assert.match(decode(result).stdout, /evidence/);
  const timeout = await tools.call('local.run', { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeout: 200 });
  assert.equal(timeout.error, true);
  assert.equal(decode(timeout).reason, 'timeout');
});

test('MCP browsing extracts text and resolves links', { timeout: 20000 }, async (t) => {
  const server = http.createServer((request, response) => { response.setHeader('content-type', 'text/html'); response.end(`<html><head><title>Fixture</title></head><body><script>secret()</script><h1>Evidence</h1><a href="/next">Next</a><p>${'Introduction '.repeat(2000)}</p><h2>Target heading<span id="detail"></span></h2><p>Relevant detail</p></body></html>`); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { tools } = await fixture(t);
  const result = decode(await tools.call('local.browse', { url: `http://127.0.0.1:${server.address().port}` }));
  assert.equal(result.title, 'Fixture');
  assert.match(result.text, /Evidence/);
  assert.ok(!result.text.includes('secret()'));
  assert.match(result.links[0].url, /\/next$/);
  assert.equal(result.truncated, true);
  assert.ok(!result.text.includes('Relevant detail'));
  const section = decode(await tools.call('local.browse', { url: `http://127.0.0.1:${server.address().port}/#detail` }));
  assert.match(section.text, /^Target heading\s+Relevant detail/);
  assert.equal(section.truncated, false);
  assert.ok(!section.text.includes('Introduction'));
  assert.match(section.url, /#detail$/);
  assert.equal((await tools.call('local.browse', { url: `http://127.0.0.1:${server.address().port}/#missing` })).error, true);
});

test('agent consumes real MCP feedback, writes code, verifies it, and checkpoints completion', { timeout: 20000 }, async (t) => {
  const { root, tools, location } = await fixture(t);
  let turn = 0;
  const result = await run({ task: 'Create and verify a small script.', bridge: tools, location, steps: 5, model: async (prompt, { update }) => {
    assert.match(update ?? prompt, /Do not include routine Evidence sections/);
    assert.match(update ?? prompt, /Still state material failures/);
    turn++;
    if (turn === 1) return action('local.list', {});
    if (turn === 2) { assert.match(prompt, /entries/); return action('local.write', { file: 'hello.js', content: 'console.log("verified");\n' }); }
    if (turn === 3) return action('local.run', { command: process.execPath, args: ['hello.js'] });
    assert.match(prompt, /verified/);
    return { text: JSON.stringify({ action: 'final', message: 'Created hello.js and verified its output.' }) };
  } });
  assert.equal(result.status, 'complete');
  assert.equal(await fs.readFile(path.join(root, 'hello.js'), 'utf8'), 'console.log("verified");\n');
  const saved = JSON.parse(await fs.readFile(location, 'utf8'));
  assert.equal(saved.pending, null);
  assert.equal(saved.history.filter((entry) => entry.role === 'tool').length, 3);
  assert.equal((await fs.stat(location)).mode & 0o777, 0o600);
});

test('agent validates actions and supports bounded resume without repeating completed tools', { timeout: 20000 }, async (t) => {
  const { tools, location } = await fixture(t);
  assert.throws(() => parse('prose {"action":"final","message":"done"}'));
  assert.throws(() => parse('{"action":"tool","tool":"local.run","arguments":{},"summary":"x","extra":true}'));
  const result = await run({ task: 'Inspect.', bridge: tools, location, steps: 1, model: async () => action('local.list', {}) });
  assert.equal(result.status, 'limit');
  const resumed = await run({ task: '', bridge: tools, location, resume: true, model: async (prompt) => {
    assert.match(prompt, /local.list/);
    return { text: '{"action":"final","message":"Inspected."}' };
  } });
  assert.equal(resumed.status, 'complete');
  const review = await run({ task: 'Now review the result.', bridge: tools, location, resume: true, model: async prompt => {
    assert.match(prompt, /Now review the result/);
    return { text: '{"action":"final","message":"Reviewed."}' };
  } });
  assert.equal(review.message, 'Reviewed.');
  const state = JSON.parse(await fs.readFile(location, 'utf8'));
  state.pending = { tool: 'local.run', arguments: {} };
  await fs.writeFile(location, JSON.stringify(state));
  await assert.rejects(run({ bridge: tools, location, resume: true, model: async () => { throw new Error('must not request'); } }), /may have run/);
});

test('invalid model outputs never execute tools and stop after three failures', async (t) => {
  const { tools, location } = await fixture(t);
  let calls = 0;
  const events = [];
  await assert.rejects(run({ task: 'Do something', bridge: { ...tools, call: async () => { calls++; } }, location, notify: (event) => events.push(event), redact: (text) => text.replaceAll('secret', '[REDACTED]'), model: async () => ({ text: 'not JSON secret' }) }), /invalid actions three times/);
  assert.equal(calls, 0);
  const state = JSON.parse(await fs.readFile(location, 'utf8'));
  assert.equal(state.status, 'error');
  assert.equal(state.rejected.length, 3);
  assert.ok(state.rejected.every((entry) => entry.content === 'not JSON [REDACTED]'));
  assert.equal(events.filter((event) => event.type === 'invalid').length, 3);
});

test('native tool errors recover through explicit text transport guidance without executing the invalid reply', async t => {
  const { root, location } = await fixture(t);
  let turn = 0, calls = 0;
  const result = await run({ task: 'Inspect the workspace.', location,
    bridge: { root, tools: [], call: async () => { calls++; return { error: false, content: '{"entries":[]}' }; } },
    model: async (prompt, { update }) => {
      if (!turn++) return { text: 'Tool local.list does not exists.' };
      if (turn === 2) {
        assert.equal(calls, 0);
        assert.match(update, /NOT native provider tools/);
        assert.match(update, /ordinary answer text/);
        return action('local.list', {});
      }
      return { text: '{"action":"final","message":"Workspace inspected."}' };
    },
  });
  assert.equal(result.status, 'complete');
  assert.equal(calls, 1);
});

test('agent removes irrelevant search snippets and recovers once from provider inspection', async t => {
  const { root, location } = await fixture(t);
  let turn = 0;
  const result = await run({ task: 'Research the relevant source.', location,
    bridge: { root, tools: [], call: async () => ({ error: false, content: JSON.stringify({ query: 'site:github.com solidity delegatecall', results: [
      { title: 'Relevant Solidity source', url: 'https://github.com/example/source', description: 'delegatecall implementation' },
      { title: 'blocked marker', url: 'https://irrelevant.example/', description: 'unrelated blocked marker' },
    ] }) }) },
    model: async prompt => {
      turn++;
      if (turn === 1) return action('local.web', { query: 'site:github.com solidity delegatecall' });
      if (turn === 2) {
        assert.match(prompt, /Relevant Solidity source/);
        assert.doesNotMatch(prompt, /blocked marker/);
        const error = new Error('inspection'); error.inspection = true; throw error;
      }
      assert.match(prompt, /Raw local\.web output omitted/);
      assert.doesNotMatch(prompt, /Relevant Solidity source|blocked marker/);
      return { text: '{"action":"final","message":"Research recovered."}' };
    },
  });
  assert.equal(result.status, 'complete');
  assert.equal(turn, 3);
});

test('agent compacts oversized history and continues without a local context stop', async t => {
  const { root, location } = await fixture(t);
  const history = Array.from({ length: 12 }, (_, index) => ({ role: 'tool', tool: 'local.browse', error: false,
    content: `${'x'.repeat(19950)} ${index === 0 ? 'old-marker' : index === 11 ? 'latest-marker' : index}` }));
  await fs.mkdir(path.dirname(location), { recursive: true });
  await fs.writeFile(location, JSON.stringify({ schema: 1, id: 'fixture', root, task: 'Continue the research.', status: 'context', plan: ['[~] Research'], history, steps: 12, pending: null }));
  const result = await run({ task: '', bridge: { root, tools: [], call: async () => ({ error: false, content: '{}' }) }, location, resume: true,
    model: async prompt => {
      assert.ok(prompt.length < 180000);
      assert.match(prompt, /latest-marker/);
      assert.doesNotMatch(prompt, /old-marker/);
      assert.match(prompt, /Context window management/);
      return { text: '{"action":"final","message":"Research continued."}' };
    },
  });
  assert.equal(result.status, 'complete');
  const saved = JSON.parse(await fs.readFile(location, 'utf8'));
  assert.match(saved.history[0].content, /old-marker/);
  assert.ok(saved.history[0].content.length > 19000);
});

test('agent sends prompts beyond the former local context threshold', async t => {
  const { root, tools, location } = await fixture(t);
  const marker = 'workspace-context-marker';
  let called = false;
  const result = await run({ task: 'Continue despite the large context.', bridge: tools, location,
    notes: {
      context: async () => `${marker}\n${'x'.repeat(190000)}`,
      save: async () => {},
    },
    model: async prompt => {
      called = true;
      assert.ok(prompt.length > 180000);
      assert.match(prompt, new RegExp(marker));
      return { text: '{"action":"final","message":"Continued without a local context pause."}' };
    },
  });
  assert.equal(called, true);
  assert.equal(result.status, 'complete');
});

test('batch actions execute independent MCP tools concurrently and return each result', async t => {
  const { root, location } = await fixture(t);
  const starts = [], ends = [];
  const result = await run({ task: 'Inspect two files.', location,
    bridge: { root, tools: [], call: async (tool, args) => { starts.push(tool); await new Promise(resolve => setTimeout(resolve, 30)); ends.push(tool); return { error: false, content: JSON.stringify({ file: args.file }) }; } },
    model: async (prompt, { update }) => {
      if (!starts.length) return { text: JSON.stringify({ action: 'batch', summary: 'Inspect independent inputs', why: 'Understand the existing workspace.', contribution: 'Gather inputs for the requested inspection.', parallel: 'These reads do not modify files or depend on each other.', milestones: [], tasks: [
        { tool: 'local.read', summary: 'Read package', arguments: { file: 'package.json' } },
        { tool: 'local.read', summary: 'Read config', arguments: { file: 'tsconfig.json' } },
      ] }) };
      assert.match(update, /package\.json/); assert.match(update, /tsconfig\.json/);
      return { text: '{"action":"final","message":"Both files inspected."}' };
    },
  });
  assert.equal(result.status, 'complete');
  assert.deepEqual(starts.sort(), ['local.read', 'local.read']);
  assert.equal(ends.length, 2);
  assert.ok(result.history.filter(entry => entry.role === 'tool').length === 2);
});

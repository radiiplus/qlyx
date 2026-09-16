import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath as filename } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as Transport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport as Http } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function bridge({ root = process.cwd(), config, passive = false, autonomous = false, approve = async () => false, log = () => {}, notify = () => {} } = {}) {
  root = await fs.realpath(root);
  const definitions = [{ name: 'local', command: process.execPath, args: [filename(new URL('../server.js', import.meta.url)), root, ...(passive ? ['--passive'] : [])], env: Object.fromEntries(['ENDPOINT', 'PROFILE'].filter((key) => process.env[key]).map((key) => [key, process.env[key]])) }];
  if (config) {
    const data = JSON.parse(await fs.readFile(config, 'utf8'));
    if (!Array.isArray(data.servers)) throw new Error('MCP config must contain a servers array.');
    definitions.push(...data.servers);
  }
  const connections = [];
  const tools = [];
  const routes = new Map();
  const names = new Set();
  const tasks = new Map(), updates = new Map();
  let timer, checking, closed = false;
  async function close() { closed = true; clearInterval(timer); await checking?.catch(() => {}); await Promise.allSettled(connections.map(({ client }) => client.close())); }
  function check() {
    if (closed) return Promise.resolve();
    if (checking) return checking;
    checking = Promise.allSettled([...tasks.values()].map(async task => {
      try {
        const result = await call('local.poll', { job: task.job, cursor: task.cursor });
        const value = JSON.parse(result.content);
        if (!value.status) throw new Error(value.error || result.content);
        task.cursor = value.cursor;
        if (value.stdout || value.stderr || value.status !== 'running' || Date.now() - task.updated >= 10000) {
          const event = { ...value, type: 'job', id: task.id, tool: 'local.run' };
          notify(event);
          const previous = updates.get(task.job);
          updates.set(task.job, { ...value, stdout: ((previous?.stdout || '') + value.stdout).slice(-12000), stderr: ((previous?.stderr || '') + value.stderr).slice(-12000) });
          task.updated = Date.now();
        }
        if (value.status !== 'running' && !value.more) tasks.delete(task.job);
      } catch (error) {
        // A status lookup failure says nothing about the process outcome.
        if (Date.now() - task.updated >= 10000) {
          const event = { type: 'job', id: task.id, job: task.job, status: 'unknown', message: error.message };
          notify(event); updates.set(task.job, event); task.updated = Date.now();
        }
      }
    })).finally(() => { checking = undefined; });
    return checking;
  }
  async function observe() {
    await check();
    const events = [...updates.values()]; updates.clear();
    return { events, running: [...tasks.keys()] };
  }
  try {
    for (const definition of definitions) {
      if (!/^[a-z][a-z0-9]*$/.test(definition.name) || names.has(definition.name)) throw new Error('MCP server names must be unique single words.');
      names.add(definition.name);
      if (Boolean(definition.url) === Boolean(definition.command)) throw new Error('Configure exactly one MCP command or HTTP URL.');
      const client = new Client({ name: 'qlyx', version: '1.0.0' });
      const transport = definition.url
        ? new Http(new URL(definition.url), { requestInit: definition.headers ? { headers: definition.headers } : undefined })
        : new Transport({ command: definition.command, args: definition.args || [], cwd: root, env: definition.env, stderr: 'pipe' });
      connections.push({ client, transport });
      if (transport.stderr) transport.stderr.on('data', (data) => log(data.toString()));
      await client.connect(transport, { timeout: 30000 });
      let cursor;
      do {
        const result = await client.listTools(cursor ? { cursor } : {});
        for (const tool of result.tools) {
          if (passive && (definition.name !== 'local' || tool.annotations?.readOnlyHint !== true)) continue;
          const name = `${definition.name}.${tool.name}`;
          if (routes.has(name)) throw new Error('MCP server returned duplicate tool names.');
          const read = definition.name === 'local' && tool.annotations?.readOnlyHint === true;
          routes.set(name, { client, name: tool.name, read });
          tools.push({ name, description: tool.description || '', schema: tool.inputSchema, read });
        }
        cursor = result.nextCursor;
      } while (cursor);
    }
  } catch (error) { await close(); throw error; }
  async function call(name, args, { signal, progress = () => {}, summary, why, evidence, id, confirmed = false } = {}) {
    const route = routes.get(name);
    if (!route) throw new Error(`Unknown or disabled tool: ${name}`);
    if (!route.read && !autonomous && !(confirmed && name === 'local.stop') && !await approve({ tool: name, arguments: args, summary, why, evidence })) {
      return { error: true, content: 'Tool execution was not approved. Do not bypass this decision; ask the user for direction or continue independent read-only work.' };
    }
    const seen = new Set();
    function receive(value) {
      if (!name.startsWith('local.') || !value || !['output', 'change', 'capture'].includes(value.type) || !Number.isSafeInteger(value.sequence) || seen.has(value.sequence)) return;
      seen.add(value.sequence);
      progress(value);
    }
    const result = await route.client.callTool({ name: route.name, arguments: args }, undefined, { timeout: 130000, signal,
      onprogress: event => {
        if (!name.startsWith('local.')) return;
        try {
          receive(JSON.parse(event.message || 'null'));
        } catch { /* Progress is optional and never changes the tool result. */ }
      },
    });
    // The SDK may retire its progress handler before dispatching notifications
    // received in the same stdio chunk as the final response. Reconcile by sequence.
    if (Array.isArray(result._meta?.events)) for (const event of result._meta.events) receive(event);
    const text = result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    if (name === 'local.run' && !result.isError) {
      try {
        const value = JSON.parse(text);
        if (value.status === 'running' && value.job) {
          tasks.set(value.job, { job: value.job, id, cursor: value.cursor || 0, updated: Date.now() });
          if (!timer) { timer = setInterval(() => void check(), 2000); timer.unref(); }
        }
      } catch {}
    }
    return { error: Boolean(result.isError), content: name === 'local.poll' ? text : text.slice(0, 29000) + (text.length > 29000 ? '\n[Output truncated. Use a narrower tool request.]' : '') };
  }
  async function cancel() {
    let ids = [...tasks.keys()];
    // Include commands whose start response was interrupted before registration.
    try { ids = JSON.parse((await call('local.jobs', {})).content).jobs.filter(job => job.status === 'running').map(job => job.job); } catch {}
    await Promise.allSettled(ids.map(job => call('local.stop', { job }, { confirmed: true })));
    await check();
  }
  return { root, tools, call, close, observe, refresh: check, cancel, get running() { return [...tasks.keys()]; } };
}

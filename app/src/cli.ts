#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { resolve as absolute } from 'node:path';
import { pathToFileURL as url } from 'node:url';
import WebSocket from 'ws';

declare const __QLYX_CLI_BUNDLE__: boolean;
import { AgentStore, Fault, setting, type Config } from './tool.ts';
import { start as startServer } from './server.ts';
import {
  WorkspaceRegistry,
  ensureWorkspace,
  findWorkspace,
  type WorkspaceRecord,
} from './workspace.ts';

type Health = {
  ok: boolean;
  pid: number;
  defaultWorkspace: string;
  workspaces: WorkspaceRecord[];
};

type Parsed = {
  command: string;
  target?: string;
  name?: string;
  json: boolean;
  noStart: boolean;
  follow: boolean;
};

function parse(args: string[]): Parsed {
  const command = args[0] || 'help';
  let target: string | undefined;
  let name: string | undefined;
  let json = false;
  let noStart = false;
  let follow = false;
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index] as string;
    if (value === '--json') json = true;
    else if (value === '--no-start') noStart = true;
    else if (value === '--follow' || value === '-f') follow = true;
    else if (value === '--name') {
      name = args[index + 1];
      if (!name) throw new Fault('OPTION', '--name requires a value.');
      index += 1;
    } else if (!target) target = value;
    else throw new Fault('OPTION', `Unexpected argument: ${value}`);
  }
  return { command, target, name, json, noStart, follow };
}

function endpoint(config: Config): { health: string; socket: string } {
  const host = process.env.QLYX_HOST || process.env.READER_HOST || config.server.host;
  const configuredPort = process.env.QLYX_PORT || process.env.READER_PORT;
  const port = configuredPort ? Number(configuredPort) : config.server.port;
  const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return {
    health: `http://${displayHost}:${port}/health`,
    socket: `ws://${displayHost}:${port}${config.server.path}`,
  };
}

async function health(config: Config, timeout = 600): Promise<Health | undefined> {
  try {
    const response = await fetch(endpoint(config).health, { signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return undefined;
    const value = await response.json() as Partial<Health>;
    if (value.ok !== true || !Number.isInteger(value.pid) || !Array.isArray(value.workspaces)) return undefined;
    return value as Health;
  } catch {
    return undefined;
  }
}

async function control(
  config: Config,
  kind: string,
  workspace?: string,
): Promise<Record<string, unknown>> {
  const id = `${kind}-${crypto.randomUUID()}`;
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const secret = process.env.QLYX_TOKEN || process.env.READER_TOKEN || config.server.token;
    const client = new WebSocket(endpoint(config).socket, {
      headers: secret ? { authorization: `Bearer ${secret}` } : undefined,
    });
    const timer = setTimeout(() => {
      client.terminate();
      reject(new Fault('DAEMON', `Daemon request timed out: ${kind}`));
    }, 3000);
    client.once('open', () => client.send(JSON.stringify({ id, kind, workspace })));
    client.once('message', (raw) => {
      clearTimeout(timer);
      client.close();
      try {
        const reply = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (reply.ok !== true) {
          const error = reply.error as { code?: string; message?: string } | undefined;
          reject(new Fault(error?.code || 'DAEMON', error?.message || `Daemon request failed: ${kind}`));
          return;
        }
        resolve(reply);
      } catch (error) {
        reject(new Fault('DAEMON', `Daemon returned invalid JSON: ${(error as Error).message}`));
      }
    });
    client.once('error', (error) => {
      clearTimeout(timer);
      reject(new Fault('DAEMON', `Cannot connect to the Qlyx daemon: ${error.message}`));
    });
  });
}

async function runDaemon(registry: WorkspaceRegistry): Promise<void> {
  const config = setting();
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer({ config, registry });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : config.server.port;
    await registry.writeDaemon({
      version: 1,
      pid: process.pid,
      host: config.server.host,
      port,
      startedAt: new Date().toISOString(),
    });
    app.server.once('close', () => { void registry.clearDaemon(process.pid); });
    const close = (): void => { void app?.close(); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } catch (error) {
    await registry.clearDaemon(process.pid).catch(() => {});
    await app?.close().catch(() => {});
    throw error;
  }
}

async function ensureDaemon(registry: WorkspaceRegistry, config: Config): Promise<{
  health: Health;
  started: boolean;
}> {
  const current = await health(config);
  if (current) return { health: current, started: false };

  await mkdir(registry.directory, { recursive: true, mode: 0o700 });
  const log = await open(registry.logPath, 'a', 0o600);
  const entry = absolute(process.argv[1] || '');
  const child = spawn(process.execPath, [...process.execArgv, entry, '__daemon'], {
    detached: true,
    env: process.env,
    stdio: ['ignore', log.fd, log.fd],
    windowsHide: true,
  });
  child.unref();
  await log.close();

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const ready = await health(config, 300);
    if (ready) return { health: ready, started: true };
    if (child.exitCode !== null) break;
  }
  let detail = '';
  try {
    detail = (await readFile(registry.logPath, 'utf8')).trim().split('\n').slice(-4).join(' ');
  } catch {
    detail = '';
  }
  throw new Fault('DAEMON', `Qlyx daemon did not start.${detail ? ` ${detail}` : ''}`);
}

function print(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === 'string') process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function workspaceLine(record: WorkspaceRecord, selected: boolean): string {
  const state = record.active ? 'active' : 'inactive';
  return `${selected ? '*' : ' '} ${record.name}  ${state}  ${record.id}\n  ${record.root}`;
}

async function currentWorkspace(target?: string): Promise<{ root: string; id: string; name: string }> {
  if (target) {
    const root = await realpath(absolute(target));
    const marker = await ensureWorkspace(root);
    return { root, id: marker.id, name: marker.name };
  }
  const current = await findWorkspace();
  return { root: current.root, id: current.marker.id, name: current.marker.name };
}

async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parse(args);
  const registry = new WorkspaceRegistry();
  const config = setting();

  if (parsed.command === '__daemon') {
    await runDaemon(registry);
    return;
  }
  if (parsed.command === 'init') {
    const root = await realpath(absolute(parsed.target || process.cwd()));
    const marker = await ensureWorkspace(root, parsed.name);
    await AgentStore.open(root);
    const record = await registry.register(root, marker);
    const daemon = parsed.noStart ? undefined : await ensureDaemon(registry, config);
    print(parsed.json ? { workspace: record, daemon } : [
      `Initialized ${record.name}`,
      `Workspace: ${record.id}`,
      `Root: ${record.root}`,
      parsed.noStart ? 'Daemon: not started' : `Daemon: ${daemon?.started ? 'started' : 'attached'} (PID ${daemon?.health.pid})`,
      `Extension: ${endpoint(config).socket}`,
    ].join('\n'), parsed.json);
    return;
  }
  if (parsed.command === 'start') {
    const selected = await currentWorkspace(parsed.target);
    await registry.use(selected.id);
    const daemon = await ensureDaemon(registry, config);
    print(parsed.json ? daemon : `Qlyx daemon ${daemon.started ? 'started' : 'already running'} (PID ${daemon.health.pid}).`, parsed.json);
    return;
  }
  if (parsed.command === 'list') {
    const data = await registry.read();
    print(parsed.json ? data : data.workspaces.length
      ? data.workspaces.map((item) => workspaceLine(item, item.id === data.defaultId)).join('\n')
      : 'No Qlyx workspaces are registered.', parsed.json);
    return;
  }
  if (parsed.command === 'guide') {
    const selected = await currentWorkspace(parsed.target);
    const agent = await AgentStore.open(selected.root);
    const content = await readFile(agent.guide, 'utf8');
    print(parsed.json ? {
      workspace: selected.id,
      path: agent.guide,
      content,
    } : content.trimEnd(), parsed.json);
    return;
  }
  if (parsed.command === 'status') {
    const daemon = await health(config);
    const data = await registry.read();
    let workspace: WorkspaceRecord | undefined;
    try {
      const current = await findWorkspace();
      workspace = data.workspaces.find((item) => item.id === current.marker.id);
    } catch {
      workspace = data.workspaces.find((item) => item.id === data.defaultId);
    }
    print(parsed.json ? { daemon, workspace, registry: registry.path } : [
      `Daemon: ${daemon ? `running (PID ${daemon.pid})` : 'offline'}`,
      `Workspace: ${workspace ? `${workspace.name} (${workspace.active ? 'active' : 'inactive'})` : 'none'}`,
      workspace ? `Root: ${workspace.root}` : '',
      `Registry: ${registry.path}`,
    ].filter(Boolean).join('\n'), parsed.json);
    return;
  }
  if (parsed.command === 'use') {
    if (!parsed.target) throw new Fault('OPTION', 'use requires a workspace id or name.');
    const record = await registry.use(parsed.target);
    if (await health(config)) await control(config, 'workspace.use', record.id);
    print(parsed.json ? record : `Selected ${record.name} (${record.id}).`, parsed.json);
    return;
  }
  if (parsed.command === 'stop') {
    const selected = await currentWorkspace(parsed.target);
    const daemon = await health(config);
    if (daemon) await control(config, 'workspace.stop', selected.id);
    else await registry.deactivate(selected.id);
    print(parsed.json ? { stopped: selected.id } : `Stopped workspace ${selected.name}; the shared daemon remains available.`, parsed.json);
    return;
  }
  if (parsed.command === 'remove') {
    const selected = await currentWorkspace(parsed.target);
    const daemon = await health(config);
    if (daemon) await control(config, 'workspace.remove', selected.id);
    else await registry.remove(selected.id);
    print(parsed.json ? { removed: selected.id } : `Unregistered workspace ${selected.name}.`, parsed.json);
    return;
  }
  if (parsed.command === 'logs') {
    const content = await readFile(registry.logPath, 'utf8').catch(() => '');
    process.stdout.write(content);
    if (parsed.follow) {
      throw new Fault('OPTION', 'Live log following is not implemented; rerun qlyx logs to refresh.');
    }
    return;
  }
  if (parsed.command === 'doctor') {
    const daemon = await health(config);
    const data = await registry.read();
    const runtime = await registry.daemon();
    print({
      ok: Boolean(daemon) && data.workspaces.length > 0,
      daemon,
      runtime,
      registry: registry.path,
      log: registry.logPath,
      endpoint: endpoint(config),
      workspaces: data.workspaces,
    }, true);
    return;
  }
  if (parsed.command === 'daemon') {
    if (parsed.target === 'start') {
      const daemon = await ensureDaemon(registry, config);
      print(parsed.json ? daemon : `Qlyx daemon ${daemon.started ? 'started' : 'already running'} (PID ${daemon.health.pid}).`, parsed.json);
      return;
    }
    if (parsed.target === 'stop') {
      if (!await health(config)) {
        await registry.clearDaemon();
        print(parsed.json ? { stopping: false, offline: true } : 'Qlyx daemon is already offline.', parsed.json);
        return;
      }
      await control(config, 'daemon.stop');
      for (let attempt = 0; attempt < 30 && await health(config, 150); attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      print(parsed.json ? { stopping: true } : 'Qlyx daemon stopped.', parsed.json);
      return;
    }
    throw new Fault('OPTION', 'daemon requires start or stop.');
  }
  print([
    'Qlyx workspace bridge',
    '',
    'qlyx init [path] [--name name] [--no-start]',
    'qlyx start [path]',
    'qlyx list [--json]',
    'qlyx guide [path] [--json]',
    'qlyx status [--json]',
    'qlyx use <id|name>',
    'qlyx stop [path]',
    'qlyx remove [path]',
    'qlyx logs',
    'qlyx doctor',
    'qlyx daemon start|stop',
  ].join('\n'), false);
}

const entry = process.argv[1] ? url(process.argv[1]).href : '';
if (typeof __QLYX_CLI_BUNDLE__ !== 'undefined' || import.meta.url === entry) {
  try {
    await main();
  } catch (error) {
    const fault = error instanceof Fault ? error : new Fault('UNKNOWN', (error as Error).message);
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: fault.code, message: fault.message } }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

export { main };

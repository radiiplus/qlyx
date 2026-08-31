import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID as uuid, timingSafeEqual as safe } from 'node:crypto';
import { basename } from 'node:path';
import { pathToFileURL as url } from 'node:url';
import WebSocket, { type RawData } from 'ws';

declare const __QLYX_CLI_BUNDLE__: boolean;
import {
  AgentStore,
  Engine,
  Fault,
  Tool,
  request,
  setting,
  type Config,
  type Reply,
} from './tool.ts';
import {
  WorkspaceRegistry,
  ensureWorkspace,
  type WorkspaceRecord,
} from './workspace.ts';

export type Options = {
  base?: string;
  config?: Config;
  logger?: boolean;
  registry?: WorkspaceRegistry;
};

type Runtime = {
  agent: AgentStore;
  record: WorkspaceRecord;
};

type Connection = {
  engines: Map<string, Engine>;
};

type Control = {
  id: string;
  kind: string;
  workspace?: string;
};

function failure(error: unknown, id: string = uuid(), action = ''): Reply {
  const fault = error instanceof Fault ? error : new Fault('UNKNOWN', (error as Error).message);
  return {
    id,
    action,
    ok: false,
    error: { code: fault.code, message: fault.message },
  };
}

function token(actual: string | undefined, expected: string): boolean {
  if (!expected) return true;
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(`Bearer ${expected}`);
  return left.length === right.length && safe(left, right);
}

function local(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function send(socket: WebSocket, value: object): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function publicWorkspace(record: WorkspaceRecord): WorkspaceRecord {
  return { ...record };
}

class WorkspaceRouter {
  config: Config;
  registry?: WorkspaceRegistry;
  transient?: WorkspaceRecord;
  runtimes = new Map<string, Runtime>();

  constructor(config: Config, options: { base?: string; registry?: WorkspaceRegistry }) {
    this.config = config;
    this.registry = options.registry;
    if (options.base) {
      const now = new Date().toISOString();
      this.transient = {
        version: 1,
        id: 'default-workspace',
        name: basename(options.base),
        root: options.base,
        active: true,
        createdAt: now,
        registeredAt: now,
        lastUsedAt: now,
      };
    }
  }

  async catalog(): Promise<{ defaultId: string; workspaces: WorkspaceRecord[] }> {
    if (this.transient) {
      return { defaultId: this.transient.id, workspaces: [publicWorkspace(this.transient)] };
    }
    if (!this.registry) throw new Fault('REGISTRY', 'Workspace registry is not initialized.');
    const registry = await this.registry.read();
    return {
      defaultId: registry.defaultId,
      workspaces: registry.workspaces.map(publicWorkspace),
    };
  }

  async resolve(id?: string): Promise<Runtime> {
    const catalog = await this.catalog();
    const record = this.transient || catalog.workspaces.find((item) => item.id === (id || catalog.defaultId));
    if (!record) {
      throw new Fault('WORKSPACE', id
        ? `Workspace is not registered: ${id}`
        : 'No active Qlyx workspace is selected. Run qlyx init in a project first.');
    }
    if (!record.active) throw new Fault('WORKSPACE', `Workspace is inactive: ${record.name}`);
    const cached = this.runtimes.get(record.id);
    if (cached) {
      if (cached.record.root !== record.root) throw new Fault('WORKSPACE', 'Registered workspace root changed unexpectedly.');
      cached.record = record;
      return cached;
    }
    if (!this.transient) {
      const marker = await ensureWorkspace(record.root);
      if (marker.id !== record.id) {
        throw new Fault('WORKSPACE', `Workspace marker does not match the registry for ${record.root}.`);
      }
    }
    const runtime = { record, agent: await AgentStore.open(record.root) };
    this.runtimes.set(record.id, runtime);
    return runtime;
  }

  async use(id: string): Promise<WorkspaceRecord> {
    if (!this.registry) throw new Fault('WORKSPACE', 'The transient test workspace cannot be changed.');
    return await this.registry.use(id);
  }

  async deactivate(id: string): Promise<WorkspaceRecord> {
    if (!this.registry) throw new Fault('WORKSPACE', 'The transient test workspace cannot be deactivated.');
    return await this.registry.deactivate(id);
  }

  async remove(id: string): Promise<WorkspaceRecord> {
    if (!this.registry) throw new Fault('WORKSPACE', 'The transient test workspace cannot be removed.');
    const record = await this.registry.remove(id);
    this.runtimes.delete(id);
    return record;
  }
}

async function closeWorkspace(connections: Set<Connection>, workspace: string): Promise<void> {
  await Promise.all([...connections].map(async (connection) => {
    const current = connection.engines.get(workspace);
    if (!current) return;
    connection.engines.delete(workspace);
    await current.close();
  }));
}

async function workspaceEngine(connection: Connection, router: WorkspaceRouter, workspace?: string): Promise<{
  engine: Engine;
  workspace: WorkspaceRecord;
}> {
  const runtime = await router.resolve(workspace);
  let current = connection.engines.get(runtime.record.id);
  if (!current) {
    current = new Engine(new Tool(runtime.record.root, router.config, runtime.agent), router.config, runtime.agent);
    connection.engines.set(runtime.record.id, current);
  }
  return { engine: current, workspace: runtime.record };
}

async function control(
  socket: WebSocket,
  value: Control,
  router: WorkspaceRouter,
  connections: Set<Connection>,
  app: FastifyInstance,
): Promise<void> {
  try {
    if (!value.id) throw new Fault('REQUEST', 'Control requests require an id.');
    if (value.kind === 'workspace.list') {
      send(socket, { id: value.id, kind: value.kind, ok: true, data: await router.catalog() });
      return;
    }
    if (value.kind === 'daemon.stop') {
      send(socket, { id: value.id, kind: value.kind, ok: true, data: { stopping: true } });
      setTimeout(() => { void app.close(); }, 20);
      return;
    }
    if (!value.workspace) throw new Fault('WORKSPACE', 'workspace is required.');
    if (value.kind === 'workspace.use') {
      const selected = await router.use(value.workspace);
      send(socket, { id: value.id, kind: value.kind, ok: true, data: { workspace: selected } });
      return;
    }
    if (value.kind === 'workspace.stop') {
      const stopped = await router.deactivate(value.workspace);
      await closeWorkspace(connections, stopped.id);
      send(socket, { id: value.id, kind: value.kind, ok: true, data: { workspace: stopped } });
      return;
    }
    if (value.kind === 'workspace.remove') {
      await closeWorkspace(connections, value.workspace);
      const removed = await router.remove(value.workspace);
      send(socket, { id: value.id, kind: value.kind, ok: true, data: { workspace: removed } });
      return;
    }
    throw new Fault('ACTION', `Unknown control request: ${value.kind}`);
  } catch (error) {
    const reply = failure(error, value.id, value.kind);
    send(socket, { ...reply, kind: value.kind });
  }
}

async function handle(
  socket: WebSocket,
  connection: Connection,
  router: WorkspaceRouter,
  connections: Set<Connection>,
  app: FastifyInstance,
  data: RawData,
  binary: boolean,
): Promise<void> {
  let id: string = uuid();
  let action = '';
  let workspace: string | undefined;
  try {
    if (binary) throw new Fault('MESSAGE', 'Binary WebSocket messages are not supported.');
    const value: unknown = JSON.parse(data.toString());
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const input = value as Record<string, unknown>;
      if (typeof input.id === 'string' && input.id) id = input.id;
      if (typeof input.action === 'string') action = input.action;
      if (typeof input.workspace === 'string') workspace = input.workspace;
      if (input.kind === 'ping') {
        const catalog = await router.catalog();
        send(socket, { kind: 'pong', defaultWorkspace: catalog.defaultId, workspaces: catalog.workspaces });
        return;
      }
      if (typeof input.kind === 'string') {
        await control(socket, {
          id: typeof input.id === 'string' ? input.id : '',
          kind: input.kind,
          workspace: typeof input.workspace === 'string' ? input.workspace : undefined,
        }, router, connections, app);
        return;
      }
    }
    const work = request(value);
    id = work.id;
    action = work.action;
    workspace = work.workspace;
    const selected = await workspaceEngine(connection, router, work.workspace);
    const write = (reply: Reply): void => send(socket, { ...reply, workspace: selected.workspace.id });
    if (work.action === selected.engine.config.commands.batch) {
      await selected.engine.batch(work, write);
      return;
    }
    write(await selected.engine.run(work));
  } catch (error) {
    const fault = error instanceof SyntaxError ? new Fault('JSON', error.message) : error;
    send(socket, { ...failure(fault, id, action), workspace });
  }
}

export async function build(options: Options = {}): Promise<FastifyInstance> {
  const config = options.config || setting();
  const secret = process.env.QLYX_TOKEN || process.env.READER_TOKEN || config.server.token;
  if (!local(config.server.host) && !secret) {
    throw new Fault('AUTH', 'A bearer token is required when the server is not bound to loopback.');
  }
  const router = new WorkspaceRouter(config, {
    base: options.base,
    registry: options.base ? undefined : options.registry || new WorkspaceRegistry(),
  });
  if (options.base) await router.resolve();

  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: config.server.bytes,
  });
  const connections = new Set<Connection>();
  await app.register(websocket, {
    options: { maxPayload: config.server.bytes },
    preClose(done) {
      for (const socket of this.websocketServer.clients) socket.terminate();
      this.websocketServer.close(done);
    },
  });

  app.get('/health', async () => {
    const catalog = await router.catalog();
    return { ok: true, pid: process.pid, defaultWorkspace: catalog.defaultId, workspaces: catalog.workspaces };
  });
  app.get(config.server.path, {
    websocket: true,
    preValidation: async (request, reply) => {
      if (!token(request.headers.authorization, secret)) {
        await reply.code(401).send({ error: { code: 'AUTH', message: 'Bearer token is invalid.' } });
      }
    },
  }, (socket) => {
    const connection: Connection = { engines: new Map() };
    connections.add(connection);
    socket.on('message', (data, binary) => {
      void handle(socket, connection, router, connections, app, data, binary);
    });
    socket.once('close', () => {
      connections.delete(connection);
      void Promise.all([...connection.engines.values()].map(async (current) => await current.close()));
      connection.engines.clear();
    });
  });
  app.addHook('onClose', async () => {
    await Promise.all([...connections].flatMap((connection) => [...connection.engines.values()])
      .map(async (current) => await current.close()));
    connections.clear();
  });
  return app;
}

export async function start(options: {
  config?: Config;
  logger?: boolean;
  registry?: WorkspaceRegistry;
} = {}): Promise<FastifyInstance> {
  const config = options.config || setting();
  const host = process.env.QLYX_HOST || process.env.READER_HOST;
  const port = process.env.QLYX_PORT || process.env.READER_PORT;
  if (host) config.server.host = host;
  if (port) {
    const value = Number(port);
    if (!Number.isInteger(value) || value < 0 || value > 65535) {
      throw new Fault('CONFIG', 'QLYX_PORT must be an integer from 0 through 65535.');
    }
    config.server.port = value;
  }
  const app = await build({ config, logger: options.logger, registry: options.registry });
  await app.listen({ host: config.server.host, port: config.server.port });
  return app;
}

async function run(): Promise<void> {
  const registry = new WorkspaceRegistry();
  let app: FastifyInstance | undefined;
  try {
    const marker = await ensureWorkspace(process.cwd());
    await AgentStore.open(process.cwd());
    await registry.register(process.cwd(), marker);
    app = await start({ registry });
    const config = setting();
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
    const fault = error instanceof Fault ? error : new Fault('SERVER', (error as Error).message);
    process.stderr.write(`${JSON.stringify({ error: { code: fault.code, message: fault.message } }, null, 2)}\n`);
    process.exitCode = 1;
    await app?.close().catch(() => {});
  }
}

const entry = process.argv[1] ? url(process.argv[1]).href : '';
if (typeof __QLYX_CLI_BUNDLE__ === 'undefined' && import.meta.url === entry) await run();

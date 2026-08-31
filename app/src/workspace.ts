import { randomUUID as uuid } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, resolve as absolute } from 'node:path';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { Fault } from './tool.ts';

export type WorkspaceMarker = {
  version: 1;
  id: string;
  name: string;
  createdAt: string;
};

export type WorkspaceRecord = WorkspaceMarker & {
  root: string;
  active: boolean;
  registeredAt: string;
  lastUsedAt: string;
};

export type RegistryFile = {
  version: 1;
  defaultId: string;
  workspaces: WorkspaceRecord[];
};

export type DaemonRecord = {
  version: 1;
  pid: number;
  host: string;
  port: number;
  startedAt: string;
};

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{7,}$/i.test(value);
}

function platformStateRoot(): string {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || process.env.APPDATA || absolute(homedir(), 'AppData', 'Local');
  }
  if (process.platform === 'darwin') return absolute(homedir(), 'Library', 'Application Support');
  return process.env.XDG_STATE_HOME || absolute(homedir(), '.local', 'state');
}

export function stateDirectory(input?: string): string {
  return absolute(input || process.env.QLYX_STATE_DIR || platformStateRoot(), 'qlyx');
}

async function atomic(path: string, value: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${uuid()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function withLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = absolute(directory, 'registry.lock');
  let file: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      file = await open(lock, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const info = await stat(lock);
        if (Date.now() - info.mtimeMs > 30000) await rm(lock, { force: true });
      } catch (inspectError) {
        if ((inspectError as NodeJS.ErrnoException).code !== 'ENOENT') throw inspectError;
      }
      await wait(40);
    }
  }
  if (!file) throw new Fault('REGISTRY', 'The Qlyx workspace registry is busy.');
  try {
    return await work();
  } finally {
    await file.close();
    await rm(lock, { force: true });
  }
}

function emptyRegistry(): RegistryFile {
  return { version: 1, defaultId: '', workspaces: [] };
}

function parseMarker(value: unknown, source: string): WorkspaceMarker {
  if (!value || typeof value !== 'object') throw new Fault('WORKSPACE', `${source} must be an object.`);
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || !validId(data.id) || typeof data.name !== 'string' || !data.name.trim()
    || typeof data.createdAt !== 'string' || !data.createdAt) {
    throw new Fault('WORKSPACE', `${source} contains invalid workspace metadata.`);
  }
  return { version: 1, id: data.id, name: data.name.trim(), createdAt: data.createdAt };
}

function parseRegistry(value: unknown): RegistryFile {
  if (!value || typeof value !== 'object') throw new Fault('REGISTRY', 'Workspace registry must be an object.');
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || !Array.isArray(data.workspaces)) {
    throw new Fault('REGISTRY', 'Workspace registry metadata is invalid.');
  }
  const workspaces = data.workspaces.map((item, index): WorkspaceRecord => {
    const marker = parseMarker(item, `workspaces[${index}]`);
    const record = item as Record<string, unknown>;
    if (typeof record.root !== 'string' || !record.root || typeof record.active !== 'boolean'
      || typeof record.registeredAt !== 'string' || !record.registeredAt
      || typeof record.lastUsedAt !== 'string' || !record.lastUsedAt) {
      throw new Fault('REGISTRY', `workspaces[${index}] contains invalid runtime metadata.`);
    }
    return {
      ...marker,
      root: absolute(record.root),
      active: record.active,
      registeredAt: record.registeredAt,
      lastUsedAt: record.lastUsedAt,
    };
  });
  if (new Set(workspaces.map((item) => item.id)).size !== workspaces.length) {
    throw new Fault('REGISTRY', 'Workspace ids must be unique.');
  }
  if (new Set(workspaces.map((item) => item.root)).size !== workspaces.length) {
    throw new Fault('REGISTRY', 'Workspace roots must be unique.');
  }
  const defaultId = typeof data.defaultId === 'string' ? data.defaultId : '';
  return { version: 1, defaultId, workspaces };
}

export async function ensureWorkspace(root: string, name?: string): Promise<WorkspaceMarker> {
  const base = await realpath(absolute(root));
  const agent = absolute(base, '.agent');
  await mkdir(agent, { recursive: true, mode: 0o700 });
  const markerPath = absolute(agent, 'state.json');
  try {
    const info = await lstat(markerPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Fault('WORKSPACE', '.agent/state.json must be a regular file.');
    }
    return parseMarker(JSON.parse(await readFile(markerPath, 'utf8')), '.agent/state.json');
  } catch (error) {
    if (error instanceof Fault || error instanceof SyntaxError) {
      if (error instanceof SyntaxError) {
        throw new Fault('WORKSPACE', `.agent/state.json cannot be loaded: ${error.message}`);
      }
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const marker: WorkspaceMarker = {
    version: 1,
    id: uuid(),
    name: name?.trim() || basename(base),
    createdAt: new Date().toISOString(),
  };
  await atomic(markerPath, marker);
  return marker;
}

export async function findWorkspace(start: string = process.cwd()): Promise<{ root: string; marker: WorkspaceMarker }> {
  let current = await realpath(absolute(start));
  while (true) {
    const markerPath = absolute(current, '.agent', 'state.json');
    try {
      const marker = parseMarker(JSON.parse(await readFile(markerPath, 'utf8')), '.agent/state.json');
      return { root: current, marker };
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Fault('WORKSPACE', `.agent/state.json cannot be loaded: ${error.message}`);
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) throw new Fault('WORKSPACE', 'No initialized Qlyx workspace was found.');
    current = parent;
  }
}

export class WorkspaceRegistry {
  directory: string;
  path: string;
  daemonPath: string;
  logPath: string;

  constructor(directory: string = stateDirectory()) {
    this.directory = absolute(directory);
    this.path = absolute(this.directory, 'workspaces.json');
    this.daemonPath = absolute(this.directory, 'daemon.json');
    this.logPath = absolute(this.directory, 'daemon.log');
  }

  async read(): Promise<RegistryFile> {
    try {
      return parseRegistry(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry();
      if (error instanceof Fault) throw error;
      throw new Fault('REGISTRY', `Workspace registry cannot be loaded: ${(error as Error).message}`);
    }
  }

  async register(root: string, marker: WorkspaceMarker): Promise<WorkspaceRecord> {
    const canonical = await realpath(absolute(root));
    return await withLock(this.directory, async () => {
      const registry = await this.read();
      const now = new Date().toISOString();
      const conflict = registry.workspaces.find((item) => item.id === marker.id && item.root !== canonical);
      if (conflict) throw new Fault('WORKSPACE', `Workspace id ${marker.id} is already registered to another path.`);
      const existing = registry.workspaces.find((item) => item.root === canonical);
      const record: WorkspaceRecord = existing
        ? { ...existing, ...marker, active: true, lastUsedAt: now }
        : { ...marker, root: canonical, active: true, registeredAt: now, lastUsedAt: now };
      registry.workspaces = registry.workspaces.filter((item) => item.id !== record.id && item.root !== canonical);
      registry.workspaces.push(record);
      registry.defaultId = record.id;
      await atomic(this.path, registry);
      return record;
    });
  }

  async use(idOrName: string): Promise<WorkspaceRecord> {
    return await withLock(this.directory, async () => {
      const registry = await this.read();
      const record = registry.workspaces.find((item) => item.id === idOrName || item.name === idOrName);
      if (!record) throw new Fault('WORKSPACE', `Workspace is not registered: ${idOrName}`);
      record.active = true;
      record.lastUsedAt = new Date().toISOString();
      registry.defaultId = record.id;
      await atomic(this.path, registry);
      return record;
    });
  }

  async deactivate(id: string): Promise<WorkspaceRecord> {
    return await withLock(this.directory, async () => {
      const registry = await this.read();
      const record = registry.workspaces.find((item) => item.id === id);
      if (!record) throw new Fault('WORKSPACE', `Workspace is not registered: ${id}`);
      record.active = false;
      if (registry.defaultId === id) {
        registry.defaultId = registry.workspaces.find((item) => item.active && item.id !== id)?.id || '';
      }
      await atomic(this.path, registry);
      return record;
    });
  }

  async remove(id: string): Promise<WorkspaceRecord> {
    return await withLock(this.directory, async () => {
      const registry = await this.read();
      const record = registry.workspaces.find((item) => item.id === id);
      if (!record) throw new Fault('WORKSPACE', `Workspace is not registered: ${id}`);
      registry.workspaces = registry.workspaces.filter((item) => item.id !== id);
      if (registry.defaultId === id) registry.defaultId = registry.workspaces.find((item) => item.active)?.id || '';
      await atomic(this.path, registry);
      return record;
    });
  }

  async daemon(): Promise<DaemonRecord | undefined> {
    try {
      const value = JSON.parse(await readFile(this.daemonPath, 'utf8')) as Partial<DaemonRecord>;
      if (value.version !== 1 || !Number.isInteger(value.pid) || Number(value.pid) < 1
        || typeof value.host !== 'string' || !Number.isInteger(value.port)
        || typeof value.startedAt !== 'string') {
        throw new Fault('DAEMON', 'Daemon runtime metadata is invalid.');
      }
      return value as DaemonRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof Fault) throw error;
      throw new Fault('DAEMON', `Daemon runtime metadata cannot be loaded: ${(error as Error).message}`);
    }
  }

  async writeDaemon(record: DaemonRecord): Promise<void> {
    await atomic(this.daemonPath, record);
  }

  async clearDaemon(pid?: number): Promise<void> {
    if (pid !== undefined) {
      const current = await this.daemon();
      if (current && current.pid !== pid) return;
    }
    await rm(this.daemonPath, { force: true });
  }
}

import { createReadStream as stream, readFileSync as load } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID as uuid } from 'node:crypto';
import {
  lstat as inspect,
  mkdir,
  open,
  readFile as fetch,
  readdir,
  realpath as canonical,
  rename as move,
  stat,
  unlink as erase,
  writeFile as save,
} from 'node:fs/promises';
import { basename, dirname, resolve as absolute } from 'node:path';
import { createInterface as reader } from 'node:readline';
import { pathToFileURL as url } from 'node:url';
import type { Dirent } from 'node:fs';

export type Item = {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'link' | 'other';
  bytes: number | null;
  mtime: string | null;
  volume: boolean;
};

export type List = {
  path: string;
  name: string;
  items: Item[];
  page: {
    offset: number;
    limit: number;
    total: number;
    more: boolean;
    next: number | null;
  };
};

export type Line = {
  line: number;
  text: string;
};

export type Next = {
  start: number;
  end: number;
  cursor: string;
};

export type Content = {
  path: string;
  name: string;
  bytes: number;
  mtime: string;
  lines: Line[];
  range: {
    start: number;
    end: number;
    total: number;
    remain: number;
  };
  next: Next | null;
};

export type Query = {
  path?: string;
  start?: number;
  end?: number;
  size?: number;
  cursor?: string;
};

export type Config = {
  lines: {
    size: number;
    limit: number;
  };
  items: {
    size: number;
    limit: number;
  };
  exec: {
    timeout: number;
    limit: number;
    bytes: number;
    store: number;
    shell: boolean;
  };
  edit: {
    bytes: number;
  };
  create: {
    bytes: number;
  };
  engine: {
    limit: number;
    wait: number;
  };
  server: {
    host: string;
    port: number;
    path: string;
    bytes: number;
    token: string;
  };
  commands: {
    list: string;
    read: string;
    exec: string;
    create: string;
    edit: string;
    delete: string;
    status: string;
    serve: string;
    help: string;
  };
};

export type Exec = {
  words: string[];
  cwd?: string;
  timeout?: number;
  shell?: boolean;
  input?: string;
};

export type Result = {
  state: 'running' | 'done';
  command: string;
  args: string[];
  cwd: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  error: string;
  cut: {
    output: boolean;
    error: boolean;
  };
  page: {
    output: Page;
    error: Page;
  };
  timed: boolean;
  duration: number;
};

export type Page = {
  start: number;
  end: number;
  total: number;
  stored: number;
  remain: number;
  lost: number;
  next: number | null;
};

export type Edit = {
  path: string;
  before: string;
  after: string;
  index?: number;
};

export type Change = {
  path: string;
  index: number;
  start: number;
  end: number;
  bytes: {
    before: number;
    after: number;
  };
  changed: boolean;
};

export type Remove = {
  path: string;
  type: 'file' | 'link';
  bytes: number;
  deleted: boolean;
};

export type Create = {
  path: string;
  type: 'file' | 'directory';
  content?: string;
  parents?: boolean;
};

export type Created = {
  path: string;
  type: 'file' | 'directory';
  bytes: number;
  created: boolean;
};

export type Request = {
  id: string;
  action: string;
  path?: string;
  start?: number;
  end?: number;
  size?: number;
  cursor?: string;
  offset?: number;
  limit?: number;
  words?: string[];
  cwd?: string;
  timeout?: number;
  shell?: boolean;
  input?: string;
  before?: string;
  after?: string;
  index?: number;
  spec?: string;
  wait?: number;
  target?: string;
  out?: number;
  err?: number;
  type?: 'file' | 'directory';
  content?: string;
  parents?: boolean;
};

export type Reply = {
  id: string;
  action: string;
  ok: boolean;
  data?: object;
  error?: {
    code: string;
    message: string;
  };
};

type Token = {
  path: string;
  start: number;
  size: number;
  stamp: number;
  bytes: number;
};

type Args = {
  id?: string;
  action: string;
  path?: string;
  start?: number;
  end?: number;
  size?: number;
  cursor?: string;
  offset?: number;
  limit?: number;
  config?: string;
  words?: string[];
  cwd?: string;
  timeout?: number;
  shell?: boolean;
  input?: string;
  before?: string;
  after?: string;
  index?: number;
  spec?: string;
  wait?: number;
  target?: string;
  out?: number;
  err?: number;
  type?: Create['type'];
  content?: string;
  parents?: boolean;
};

const volumes = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.venv',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'vendor',
]);

export class Fault extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'Fault';
    this.code = code;
  }
}

function integer(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Fault('RANGE', `${name} must be an integer between ${min} and ${max}.`);
  }
  return Number(value);
}

function rule(value: unknown, name: string): { size: number; limit: number } {
  if (!value || typeof value !== 'object') throw new Fault('CONFIG', `${name} must be an object.`);
  const data = value as Record<string, unknown>;
  const limit = integer(data.limit, `${name}.limit`, 0, 1, Number.MAX_SAFE_INTEGER);
  const size = integer(data.size, `${name}.size`, 0, 1, limit);
  return { size, limit };
}

function command(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]*$/i.test(value)) {
    throw new Fault('CONFIG', `${name} must be one command word.`);
  }
  return value;
}

export function setting(input?: string): Config {
  const source = input ? absolute(process.cwd(), input) : new URL('../config.json', import.meta.url);
  let data: unknown;
  try {
    data = JSON.parse(load(source, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Fault('CONFIG', `Configuration cannot be loaded: ${message}`);
  }
  if (!data || typeof data !== 'object') throw new Fault('CONFIG', 'Configuration must be an object.');
  const value = data as Record<string, unknown>;
  if (!value.commands || typeof value.commands !== 'object') {
    throw new Fault('CONFIG', 'commands must be an object.');
  }
  const names = value.commands as Record<string, unknown>;
  const commands = {
    list: command(names.list, 'commands.list'),
    read: command(names.read, 'commands.read'),
    exec: command(names.exec, 'commands.exec'),
    create: command(names.create, 'commands.create'),
    edit: command(names.edit, 'commands.edit'),
    delete: command(names.delete, 'commands.delete'),
    status: command(names.status, 'commands.status'),
    serve: command(names.serve, 'commands.serve'),
    help: command(names.help, 'commands.help'),
  };
  if (new Set(Object.values(commands)).size !== 9) {
    throw new Fault('CONFIG', 'Command names must be unique.');
  }
  if (!value.exec || typeof value.exec !== 'object') throw new Fault('CONFIG', 'exec must be an object.');
  const run = value.exec as Record<string, unknown>;
  const limit = integer(run.limit, 'exec.limit', 0, 1, Number.MAX_SAFE_INTEGER);
  const timeout = integer(run.timeout, 'exec.timeout', 0, 1, limit);
  const store = integer(run.store, 'exec.store', 0, 1, Number.MAX_SAFE_INTEGER);
  const bytes = integer(run.bytes, 'exec.bytes', 0, 1, store);
  if (typeof run.shell !== 'boolean') throw new Fault('CONFIG', 'exec.shell must be a boolean.');
  if (!value.edit || typeof value.edit !== 'object') throw new Fault('CONFIG', 'edit must be an object.');
  const edits = value.edit as Record<string, unknown>;
  const size = integer(edits.bytes, 'edit.bytes', 0, 1, Number.MAX_SAFE_INTEGER);
  if (!value.create || typeof value.create !== 'object') throw new Fault('CONFIG', 'create must be an object.');
  const creates = value.create as Record<string, unknown>;
  const created = integer(creates.bytes, 'create.bytes', 0, 1, Number.MAX_SAFE_INTEGER);
  if (!value.engine || typeof value.engine !== 'object') {
    throw new Fault('CONFIG', 'engine must be an object.');
  }
  const engine = value.engine as Record<string, unknown>;
  const tasks = integer(engine.limit, 'engine.limit', 0, 1, Number.MAX_SAFE_INTEGER);
  const wait = integer(engine.wait, 'engine.wait', 0, 1, Number.MAX_SAFE_INTEGER);
  if (!value.server || typeof value.server !== 'object') {
    throw new Fault('CONFIG', 'server must be an object.');
  }
  const server = value.server as Record<string, unknown>;
  if (typeof server.host !== 'string' || !server.host.trim()) {
    throw new Fault('CONFIG', 'server.host must be a nonempty string.');
  }
  const port = integer(server.port, 'server.port', 0, 0, 65535);
  if (typeof server.path !== 'string' || !/^\/[a-z0-9/_-]*$/i.test(server.path)) {
    throw new Fault('CONFIG', 'server.path must be an absolute URL path.');
  }
  const payload = integer(server.bytes, 'server.bytes', 0, 1, Number.MAX_SAFE_INTEGER);
  if (typeof server.token !== 'string') throw new Fault('CONFIG', 'server.token must be a string.');
  return {
    lines: rule(value.lines, 'lines'),
    items: rule(value.items, 'items'),
    exec: { timeout, limit, bytes, store, shell: run.shell },
    edit: { bytes: size },
    create: { bytes: created },
    engine: { limit: tasks, wait },
    server: {
      host: server.host,
      port,
      path: server.path,
      bytes: payload,
      token: server.token,
    },
    commands,
  };
}

export function spec(input: string): Edit {
  const source = absolute(process.cwd(), input);
  let data: unknown;
  try {
    data = JSON.parse(load(source, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Fault('SPEC', `Edit specification cannot be loaded: ${message}`);
  }
  if (!data || typeof data !== 'object') throw new Fault('SPEC', 'Edit specification must be an object.');
  const value = data as Record<string, unknown>;
  if (typeof value.path !== 'string') throw new Fault('SPEC', 'path must be a string.');
  if (typeof value.before !== 'string') throw new Fault('SPEC', 'before must be a string.');
  if (typeof value.after !== 'string') throw new Fault('SPEC', 'after must be a string.');
  if (value.index !== undefined && (!Number.isInteger(value.index) || Number(value.index) < 1)) {
    throw new Fault('SPEC', 'index must be a positive integer.');
  }
  return {
    path: value.path,
    before: value.before,
    after: value.after,
    index: value.index === undefined ? undefined : Number(value.index),
  };
}

function kind(entry: Dirent): Item['type'] {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) return 'link';
  return 'other';
}

function order(left: Dirent, right: Dirent): number {
  const ranks = { directory: 0, file: 1, link: 2, other: 3 };
  const rank = ranks[kind(left)] - ranks[kind(right)];
  return rank || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
}

function binary(data: Buffer): boolean {
  if (data.includes(0)) return true;
  if (data.length === 0) return false;

  let count = 0;
  for (const byte of data) {
    const allowed = byte === 8 || byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if (byte < 32 && !allowed) count += 1;
  }
  return count / data.length > 0.1;
}

function encode(token: Token): string {
  return Buffer.from(JSON.stringify(token)).toString('base64url');
}

function decode(cursor: string): Token {
  try {
    const token = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Token>;
    const valid = typeof token.path === 'string'
      && Number.isInteger(token.start)
      && Number.isInteger(token.size)
      && Number.isFinite(token.stamp)
      && Number.isInteger(token.bytes);
    if (!valid) throw new Error('invalid');
    return token as Token;
  } catch {
    throw new Fault('CURSOR', 'Cursor is invalid.');
  }
}

export class Tool {
  base: string;
  config: Config;

  constructor(base: string = process.cwd(), config: Config = setting()) {
    this.base = absolute(base);
    this.config = config;
  }

  async resolve(input: string = '.'): Promise<string> {
    if (typeof input !== 'string' || input.includes('\0')) {
      throw new Fault('PATH', 'Path must be a valid string.');
    }

    try {
      return await canonical(absolute(this.base, input));
    } catch (error) {
      const value = error as NodeJS.ErrnoException;
      if (value.code === 'ENOENT' || value.code === 'ENOTDIR') {
        throw new Fault('MISSING', `Path does not exist: ${input}`);
      }
      if (value.code === 'EACCES') {
        throw new Fault('ACCESS', `Path cannot be accessed: ${input}`);
      }
      throw error;
    }
  }

  async list(input: string = '.', offset: number = 0, limit?: number): Promise<List> {
    const skip = integer(offset, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
    const take = integer(limit, 'limit', this.config.items.size, 1, this.config.items.limit);
    const target = await this.resolve(input);
    const info = await stat(target);
    if (!info.isDirectory()) throw new Fault('DIRECTORY', `Path is not a directory: ${input}`);

    let found: Dirent[];
    try {
      found = await readdir(target, { withFileTypes: true });
    } catch (error) {
      const value = error as NodeJS.ErrnoException;
      if (value.code === 'EACCES') throw new Fault('ACCESS', `Directory cannot be read: ${input}`);
      throw error;
    }
    found.sort(order);
    const slice = found.slice(skip, skip + take);
    const items = await Promise.all(slice.map(async (entry): Promise<Item> => {
      const path = absolute(target, entry.name);
      let info: Awaited<ReturnType<typeof stat>> | null = null;
      try {
        info = await stat(path);
      } catch {
        // The entry may disappear or become inaccessible after the directory read.
      }
      const type = kind(entry);
      return {
        name: entry.name,
        path,
        type,
        bytes: type === 'file' && info ? info.size : null,
        mtime: info ? info.mtime.toISOString() : null,
        volume: type === 'directory' && volumes.has(entry.name.toLowerCase()),
      };
    }));
    const next = skip + items.length < found.length ? skip + items.length : null;

    return {
      path: target,
      name: basename(target),
      items,
      page: {
        offset: skip,
        limit: take,
        total: found.length,
        more: next !== null,
        next,
      },
    };
  }

  async read(query: Query): Promise<Content> {
    const token = query.cursor ? decode(query.cursor) : null;
    const input = token?.path || query.path;
    if (!input) throw new Fault('PATH', 'A path or cursor is required.');
    if (token && (query.path || query.start || query.end || query.size)) {
      throw new Fault('CURSOR', 'Cursor cannot be combined with path or range options.');
    }

    const target = await this.resolve(input);
    const info = await stat(target);
    if (!info.isFile()) throw new Fault('FILE', `Path is not a file: ${input}`);
    if (token && (token.stamp !== info.mtimeMs || token.bytes !== info.size)) {
      throw new Fault('STALE', 'File changed after the cursor was created. Start a new read.');
    }

    const start = integer(token?.start ?? query.start, 'start', 1, 1, Number.MAX_SAFE_INTEGER);
    let size = integer(
      token?.size ?? query.size,
      'size',
      this.config.lines.size,
      1,
      this.config.lines.limit,
    );
    let end = start + size - 1;
    if (!token && query.end !== undefined) {
      end = integer(query.end, 'end', end, start, Number.MAX_SAFE_INTEGER);
      size = end - start + 1;
      if (size > this.config.lines.limit) {
        throw new Fault('RANGE', `A read can return at most ${this.config.lines.limit} lines.`);
      }
    }

    const file = await open(target, 'r');
    try {
      const sample = Buffer.alloc(Math.min(8192, info.size));
      await file.read(sample, 0, sample.length, 0);
      if (binary(sample)) throw new Fault('BINARY', `Path is not a text file: ${input}`);
    } finally {
      await file.close();
    }

    const lines: Line[] = [];
    let total = 0;
    const source = stream(target, { encoding: 'utf8' });
    const scan = reader({ input: source, crlfDelay: Infinity });
    try {
      for await (const text of scan) {
        total += 1;
        if (total >= start && total <= end) lines.push({ line: total, text });
      }
    } catch {
      throw new Fault('READ', `File cannot be read: ${input}`);
    }

    const last = lines.at(-1)?.line ?? Math.min(end, total);
    const remain = Math.max(0, total - last);
    const next = remain > 0
      ? {
          start: last + 1,
          end: Math.min(last + size, total),
          cursor: encode({ path: target, start: last + 1, size, stamp: info.mtimeMs, bytes: info.size }),
        }
      : null;

    return {
      path: target,
      name: basename(target),
      bytes: info.size,
      mtime: info.mtime.toISOString(),
      lines,
      range: {
        start,
        end: last,
        total,
        remain,
      },
      next,
    };
  }

  async start(query: Exec): Promise<Job> {
    if (!Array.isArray(query.words) || query.words.length === 0 || query.words.some((word) => typeof word !== 'string')) {
      throw new Fault('COMMAND', 'A command is required after --.');
    }
    const shell = query.shell ?? this.config.exec.shell;
    if (shell && query.words.length !== 1) {
      throw new Fault('COMMAND', 'Shell mode requires one quoted command after --.');
    }
    if (query.shell !== undefined && typeof query.shell !== 'boolean') {
      throw new Fault('COMMAND', 'shell must be a boolean.');
    }
    if (query.input !== undefined && typeof query.input !== 'string') {
      throw new Fault('COMMAND', 'input must be a string.');
    }
    if (query.cwd !== undefined && typeof query.cwd !== 'string') {
      throw new Fault('COMMAND', 'cwd must be a string.');
    }
    const timeout = integer(
      query.timeout,
      'timeout',
      this.config.exec.timeout,
      1,
      this.config.exec.limit,
    );
    const cwd = await this.resolve(query.cwd || '.');
    const info = await stat(cwd);
    if (!info.isDirectory()) throw new Fault('DIRECTORY', `Working path is not a directory: ${query.cwd}`);
    const command = query.words[0];
    const args = shell ? [] : query.words.slice(1);
    return new Job(
      command,
      args,
      cwd,
      shell,
      timeout,
      this.config.exec.bytes,
      this.config.exec.store,
      query.input,
    );
  }

  async exec(query: Exec): Promise<Result> {
    const job = await this.start(query);
    return await job.done;
  }

  async create(query: Create): Promise<Created> {
    if (!query.path || query.path.includes('\0')) throw new Fault('PATH', 'A valid path is required.');
    if (query.type !== 'file' && query.type !== 'directory') {
      throw new Fault('TYPE', 'type must be file or directory.');
    }
    if (query.parents !== undefined && typeof query.parents !== 'boolean') {
      throw new Fault('TYPE', 'parents must be a boolean.');
    }
    if (query.content !== undefined && typeof query.content !== 'string') {
      throw new Fault('TYPE', 'content must be a string.');
    }
    if (query.type === 'directory' && query.content !== undefined) {
      throw new Fault('TYPE', 'Directories cannot have content.');
    }
    const content = query.content || '';
    const bytes = Buffer.byteLength(content);
    if (bytes > this.config.create.bytes) {
      throw new Fault('SIZE', `Content exceeds the configured create limit of ${this.config.create.bytes} bytes.`);
    }
    const target = absolute(this.base, query.path);
    try {
      await inspect(target);
      throw new Fault('EXISTS', `Path already exists: ${query.path}`);
    } catch (error) {
      if (error instanceof Fault) throw error;
      const value = error as NodeJS.ErrnoException;
      if (value.code !== 'ENOENT' && value.code !== 'ENOTDIR') throw error;
    }

    try {
      if (query.type === 'directory') {
        await mkdir(target, { recursive: query.parents || false });
      } else {
        if (query.parents) await mkdir(dirname(target), { recursive: true });
        await save(target, content, { encoding: 'utf8', flag: 'wx' });
      }
    } catch (error) {
      const value = error as NodeJS.ErrnoException;
      if (value.code === 'EEXIST') throw new Fault('EXISTS', `Path already exists: ${query.path}`);
      if (value.code === 'ENOENT') throw new Fault('MISSING', 'Parent directory does not exist.');
      if (value.code === 'EACCES' || value.code === 'EPERM') {
        throw new Fault('ACCESS', `Path cannot be created: ${query.path}`);
      }
      throw error;
    }
    return { path: target, type: query.type, bytes: query.type === 'file' ? bytes : 0, created: true };
  }

  async edit(query: Edit): Promise<Change> {
    if (!query.path) throw new Fault('PATH', 'A file path is required.');
    if (typeof query.before !== 'string' || query.before.length === 0) {
      throw new Fault('MATCH', 'before must contain the exact text to replace.');
    }
    if (typeof query.after !== 'string') throw new Fault('MATCH', 'after must be a string.');
    const index = query.index === undefined
      ? undefined
      : integer(query.index, 'index', 1, 1, Number.MAX_SAFE_INTEGER);
    const target = await this.resolve(query.path);
    const info = await stat(target);
    if (!info.isFile()) throw new Fault('FILE', `Path is not a file: ${query.path}`);
    if (info.size > this.config.edit.bytes) {
      throw new Fault('SIZE', `File exceeds the configured edit limit of ${this.config.edit.bytes} bytes.`);
    }

    const source = await fetch(target);
    if (binary(source.subarray(0, Math.min(8192, source.length)))) {
      throw new Fault('BINARY', `Path is not a text file: ${query.path}`);
    }
    const text = source.toString('utf8');
    const matches: number[] = [];
    let offset = 0;
    while (offset <= text.length) {
      const found = text.indexOf(query.before, offset);
      if (found === -1) break;
      matches.push(found);
      offset = found + query.before.length;
    }
    if (matches.length === 0) throw new Fault('MATCH', 'Exact before text was not found.');
    if (index === undefined && matches.length > 1) {
      throw new Fault('MATCH', `Exact before text matched ${matches.length} regions; supply index to choose one.`);
    }
    const selected = index ?? 1;
    const start = matches[selected - 1];
    if (start === undefined) {
      throw new Fault('MATCH', `index ${selected} exceeds the ${matches.length} matching regions.`);
    }
    const end = start + query.before.length;
    if (query.before === query.after) {
      return {
        path: target,
        index: selected,
        start,
        end,
        bytes: {
          before: Buffer.byteLength(query.before),
          after: Buffer.byteLength(query.after),
        },
        changed: false,
      };
    }

    const content = `${text.slice(0, start)}${query.after}${text.slice(end)}`;
    const temp = absolute(target, '..', `.reader-${process.pid}-${Date.now()}`);
    try {
      await save(temp, content, { encoding: 'utf8', mode: info.mode });
      const check = await stat(target);
      if (check.size !== info.size || check.mtimeMs !== info.mtimeMs) {
        throw new Fault('STALE', 'File changed during the edit. Submit the edit again.');
      }
      await move(temp, target);
    } catch (error) {
      await erase(temp).catch(() => {});
      throw error;
    }

    return {
      path: target,
      index: selected,
      start,
      end,
      bytes: {
        before: Buffer.byteLength(query.before),
        after: Buffer.byteLength(query.after),
      },
      changed: true,
    };
  }

  async remove(input: string): Promise<Remove> {
    if (!input || input.includes('\0')) throw new Fault('PATH', 'A valid file path is required.');
    const target = absolute(this.base, input);
    let info: Awaited<ReturnType<typeof inspect>>;
    try {
      info = await inspect(target);
    } catch (error) {
      const value = error as NodeJS.ErrnoException;
      if (value.code === 'ENOENT' || value.code === 'ENOTDIR') {
        throw new Fault('MISSING', `Path does not exist: ${input}`);
      }
      if (value.code === 'EACCES') throw new Fault('ACCESS', `Path cannot be accessed: ${input}`);
      throw error;
    }
    const type = info.isSymbolicLink() ? 'link' : info.isFile() ? 'file' : null;
    if (!type) throw new Fault('FILE', 'Only files and symbolic links can be deleted.');
    try {
      await erase(target);
    } catch (error) {
      const value = error as NodeJS.ErrnoException;
      if (value.code === 'EACCES' || value.code === 'EPERM') {
        throw new Fault('ACCESS', `Path cannot be deleted: ${input}`);
      }
      throw error;
    }
    return { path: target, type, bytes: info.size, deleted: true };
  }
}

export class Job {
  command: string;
  args: string[];
  cwd: string;
  started = Date.now();
  output: Buffer[] = [];
  error: Buffer[] = [];
  outs = 0;
  errs = 0;
  outseen = 0;
  errseen = 0;
  outcut = false;
  errcut = false;
  timed = false;
  settled = false;
  result?: Result;
  done: Promise<Result>;
  child: ReturnType<typeof spawn>;
  timer: NodeJS.Timeout;
  force?: NodeJS.Timeout;
  bytes: number;
  store: number;
  code: number | null = null;
  signal: NodeJS.Signals | null = null;

  constructor(
    command: string,
    args: string[],
    cwd: string,
    shell: boolean,
    timeout: number,
    bytes: number,
    store: number,
    input?: string,
  ) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.bytes = bytes;
    this.store = store;
    this.child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      env: process.env,
      shell,
      windowsHide: true,
    });
    this.done = new Promise<Result>((done, fail) => {
      this.child.stdout?.on('data', (chunk: Buffer) => {
        this.outseen += chunk.length;
        const before = this.outs;
        this.outs = this.collect(chunk, this.output, this.outs);
        if (this.outs - before < chunk.length) this.outcut = true;
      });
      this.child.stderr?.on('data', (chunk: Buffer) => {
        this.errseen += chunk.length;
        const before = this.errs;
        this.errs = this.collect(chunk, this.error, this.errs);
        if (this.errs - before < chunk.length) this.errcut = true;
      });
      this.child.stdin?.on('error', () => {});
      if (input !== undefined) this.child.stdin?.end(input);
      else this.child.stdin?.end();

      this.child.once('error', (error) => {
        if (this.settled) return;
        this.settled = true;
        this.clear();
        fail(new Fault('COMMAND', `Command could not start: ${error.message}`));
      });
      this.child.once('close', (code, signal) => {
        if (this.settled) return;
        this.settled = true;
        this.code = code;
        this.signal = signal;
        this.clear();
        this.result = this.snap();
        done(this.result);
      });
    });
    this.timer = setTimeout(() => {
      this.timed = true;
      this.stop();
    }, timeout);
  }

  collect(chunk: Buffer, parts: Buffer[], size: number): number {
    const left = this.store - size;
    if (left <= 0) return size;
    const part = chunk.length > left ? chunk.subarray(0, left) : chunk;
    parts.push(part);
    return size + part.length;
  }

  clear(): void {
    clearTimeout(this.timer);
    if (this.force) clearTimeout(this.force);
  }

  stop(): void {
    if (!this.child.pid) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(this.child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => this.child.kill());
      return;
    }
    try {
      process.kill(-this.child.pid, 'SIGTERM');
    } catch {
      this.child.kill();
    }
    this.force = setTimeout(() => {
      if (this.settled || !this.child.pid) return;
      try {
        process.kill(-this.child.pid, 'SIGKILL');
      } catch {
        this.child.kill('SIGKILL');
      }
    }, 1000);
  }

  page(parts: Buffer[], offset: number, total: number): { text: string; page: Page } {
    const data = Buffer.concat(parts);
    const start = Math.min(offset, data.length);
    const end = Math.min(start + this.bytes, data.length);
    const remain = data.length - end;
    return {
      text: data.subarray(start, end).toString('utf8'),
      page: {
        start,
        end,
        total,
        stored: data.length,
        remain,
        lost: Math.max(0, total - data.length),
        next: remain > 0 || (!this.settled && data.length < this.store) ? end : null,
      },
    };
  }

  snap(out: number = 0, err: number = 0): Result {
    const output = this.page(this.output, out, this.outseen);
    const error = this.page(this.error, err, this.errseen);
    return {
      state: this.settled ? 'done' : 'running',
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      code: this.code,
      signal: this.signal,
      output: output.text,
      error: error.text,
      cut: { output: this.outcut, error: this.errcut },
      page: { output: output.page, error: error.page },
      timed: this.timed,
      duration: Date.now() - this.started,
    };
  }

  async wait(delay: number, out: number = 0, err: number = 0): Promise<Result> {
    if (this.result) return this.snap(out, err);
    return await new Promise<Result>((done, fail) => {
      const timer = setTimeout(() => done(this.snap(out, err)), delay);
      this.done.then(() => {
        clearTimeout(timer);
        done(this.snap(out, err));
      }, (error) => {
        clearTimeout(timer);
        fail(error);
      });
    });
  }
}

function failure(id: string, action: string, error: unknown): Reply {
  const fault = error instanceof Fault ? error : new Fault('UNKNOWN', (error as Error).message);
  return {
    id,
    action,
    ok: false,
    error: { code: fault.code, message: fault.message },
  };
}

export class Engine {
  tool: Tool;
  config: Config;
  active = 0;
  queue: Array<() => void> = [];
  ids = new Set<string>();
  jobs = new Map<string, Job>();

  constructor(tool: Tool, config: Config = tool.config) {
    this.tool = tool;
    this.config = config;
  }

  async gate(): Promise<void> {
    if (this.active >= this.config.engine.limit) {
      await new Promise<void>((resume) => this.queue.push(resume));
    }
    this.active += 1;
  }

  leave(): void {
    this.active -= 1;
    this.queue.shift()?.();
  }

  async close(): Promise<void> {
    const jobs = [...this.jobs.values()];
    for (const job of jobs) {
      if (!job.settled) job.stop();
    }
    await Promise.allSettled(jobs.map((job) => job.done));
  }

  async run(request: Request): Promise<Reply> {
    const id = typeof request.id === 'string' ? request.id.trim() : '';
    const action = typeof request.action === 'string' ? request.action : '';
    if (!id) return failure(uuid(), action, new Fault('ID', 'Every operation requires a nonempty id.'));
    if (id.length > 200) return failure(id, action, new Fault('ID', 'Operation id cannot exceed 200 characters.'));
    if (this.ids.has(id)) return failure(id, action, new Fault('ID', `Operation id is already used: ${id}`));
    this.ids.add(id);
    if (action === this.config.commands.status) {
      try {
        const target = typeof request.target === 'string'
          ? request.target
          : typeof request.path === 'string' ? request.path : '';
        if (!target) throw new Fault('JOB', 'status requires a target execution id.');
        const job = this.jobs.get(target);
        if (!job) throw new Fault('JOB', `Execution is not known: ${target}`);
        const wait = integer(request.wait, 'wait', 0, 0, this.config.engine.wait);
        const out = integer(request.out, 'out', 0, 0, Number.MAX_SAFE_INTEGER);
        const err = integer(request.err, 'err', 0, 0, Number.MAX_SAFE_INTEGER);
        const result = wait > 0 ? await job.wait(wait, out, err) : job.snap(out, err);
        return { id, action, ok: true, data: { target, ...result } };
      } catch (error) {
        return failure(id, action, error);
      }
    }
    await this.gate();
    let release = true;
    try {
      if (action === this.config.commands.exec) {
        const wait = request.wait === undefined
          ? undefined
          : integer(request.wait, 'wait', 0, 0, this.config.engine.wait);
        const job = await this.tool.start({
          words: request.words || [],
          cwd: request.cwd,
          timeout: request.timeout,
          shell: request.shell,
          input: request.input,
        });
        this.jobs.set(id, job);
        if (wait !== undefined) {
          release = false;
          void job.done.then(() => this.leave(), () => this.leave());
          const data = await job.wait(wait);
          return { id, action, ok: true, data };
        }
        const data = await job.done;
        return { id, action, ok: true, data };
      }
      const data = await perform(this.tool, this.config, { ...request, id, action });
      return { id, action, ok: true, data };
    } catch (error) {
      return failure(id, action, error);
    } finally {
      if (release) this.leave();
    }
  }
}

function number(value: string | undefined, name: string): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) throw new Fault('OPTION', `${name} requires an integer.`);
  return Number(value);
}

function parse(args: string[]): Args {
  const action = args[0] || '';
  const data: Args = { action };
  let index = 1;
  if (args[index] && !args[index].startsWith('--')) {
    data.path = args[index];
    index += 1;
  }

  while (index < args.length) {
    const flag = args[index];
    if (flag === '--') {
      data.words = args.slice(index + 1);
      break;
    }
    if (flag === '--shell') {
      data.shell = true;
      index += 1;
      continue;
    }
    if (flag === '--parents') {
      data.parents = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (flag === '--path') data.path = value;
    else if (flag === '--cursor') data.cursor = value;
    else if (flag === '--start') data.start = number(value, flag);
    else if (flag === '--end') data.end = number(value, flag);
    else if (flag === '--size') data.size = number(value, flag);
    else if (flag === '--offset') data.offset = number(value, flag);
    else if (flag === '--limit') data.limit = number(value, flag);
    else if (flag === '--config') data.config = value;
    else if (flag === '--cwd') data.cwd = value;
    else if (flag === '--timeout') data.timeout = number(value, flag);
    else if (flag === '--input') data.input = value;
    else if (flag === '--before') data.before = value;
    else if (flag === '--after') data.after = value;
    else if (flag === '--index') data.index = number(value, flag);
    else if (flag === '--spec') data.spec = value;
    else if (flag === '--id') data.id = value;
    else if (flag === '--wait') data.wait = number(value, flag);
    else if (flag === '--target') data.target = value;
    else if (flag === '--out') data.out = number(value, flag);
    else if (flag === '--err') data.err = number(value, flag);
    else if (flag === '--type') data.type = value as Create['type'];
    else if (flag === '--content') data.content = value;
    else throw new Fault('OPTION', `Unknown option: ${flag}`);
    if (value === undefined) throw new Fault('OPTION', `${flag} requires a value.`);
    index += 2;
  }
  return data;
}

function usage(config: Config): object {
  return {
    name: 'reader',
    commands: {
      list: `${config.commands.list} [path] [--offset number] [--limit number]`,
      read: `${config.commands.read} [path] [--start number] [--end number] [--size number]`,
      next: `${config.commands.read} --cursor token`,
      exec: `${config.commands.exec} [--cwd path] [--timeout number] [--shell] -- command [args]`,
      progress: `${config.commands.exec} --wait number -- command [args]`,
      status: `${config.commands.status} --target id [--wait number] [--out offset] [--err offset]`,
      create: `${config.commands.create} path --type file|directory [--content text] [--parents]`,
      edit: `${config.commands.edit} [path] --before text --after text [--index number]`,
      spec: `${config.commands.edit} --spec file`,
      delete: `${config.commands.delete} path`,
      serve: `${config.commands.serve} [--config file]`,
      help: config.commands.help,
    },
    defaults: {
      path: process.cwd(),
      size: config.lines.size,
      limit: config.items.size,
    },
    caps: {
      lines: config.lines.limit,
      items: config.items.limit,
      timeout: config.exec.limit,
      output: config.exec.bytes,
      store: config.exec.store,
      edit: config.edit.bytes,
      create: config.create.bytes,
      tasks: config.engine.limit,
      wait: config.engine.wait,
    },
    schema: {
      request: '{"id":"job-1","action":"read","path":"/path/to/file"}',
      reply: '{"id":"job-1","action":"read","ok":true,"data":{}}',
    },
  };
}

async function perform(tool: Tool, config: Config, request: Request): Promise<object> {
  const action = request.action;
  if (action === config.commands.list) {
    return await tool.list(request.path, request.offset, request.limit);
  }
  if (action === config.commands.read) return await tool.read(request);
  if (action === config.commands.exec) {
    return await tool.exec({
      words: request.words || [],
      cwd: request.cwd,
      timeout: request.timeout,
      shell: request.shell,
      input: request.input,
    });
  }
  if (action === config.commands.edit) {
    if (request.spec && (
      request.path
      || request.before !== undefined
      || request.after !== undefined
      || request.index !== undefined
    )) {
      throw new Fault('SPEC', 'spec cannot be combined with inline edit options.');
    }
    const edit = request.spec
      ? spec(request.spec)
      : {
          path: request.path || '',
          before: request.before as string,
          after: request.after as string,
          index: request.index,
        };
    return await tool.edit(edit);
  }
  if (action === config.commands.create) {
    return await tool.create({
      path: request.path || '',
      type: request.type as Create['type'],
      content: request.content,
      parents: request.parents,
    });
  }
  if (action === config.commands.delete) return await tool.remove(request.path || '');
  if (action === config.commands.help) return usage(config);
  throw new Fault('ACTION', `Unknown command: ${action}`);
}

export function request(value: unknown): Request {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Fault('REQUEST', 'Each input line must be a JSON object.');
  }
  const data = value as Record<string, unknown>;
  return {
    ...data,
    id: typeof data.id === 'string' && data.id.trim() ? data.id : uuid(),
    action: typeof data.action === 'string' ? data.action : '',
  } as Request;
}

async function serve(engine: Engine): Promise<void> {
  const scan = reader({ input: process.stdin, crlfDelay: Infinity });
  const tasks = new Set<Promise<void>>();
  for await (const line of scan) {
    if (!line.trim()) continue;
    let work: Request;
    try {
      work = request(JSON.parse(line));
    } catch (error) {
      const reply = failure(uuid(), '', error instanceof SyntaxError ? new Fault('JSON', error.message) : error);
      process.stdout.write(`${JSON.stringify(reply)}\n`);
      continue;
    }
    const task = engine.run(work).then((reply) => {
      process.stdout.write(`${JSON.stringify(reply)}\n`);
    });
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  }
  await Promise.all([...tasks]);
}

async function run(): Promise<void> {
  let id: string = uuid();
  let action = '';
  try {
    const args = parse(process.argv.slice(2));
    id = args.id || id;
    const config = setting(args.config);
    action = args.action || config.commands.help;
    const tool = new Tool(process.cwd(), config);
    const engine = new Engine(tool, config);
    if (action === config.commands.serve) {
      await serve(engine);
      return;
    }
    if (args.wait !== undefined || action === config.commands.status) {
      throw new Fault('MODE', 'Progress waits and status requests require serve mode or the imported Engine.');
    }
    const reply = await engine.run({ ...args, id, action });
    const output = `${JSON.stringify(reply, null, 2)}\n`;
    if (reply.ok) process.stdout.write(output);
    else {
      process.stderr.write(output);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify(failure(id, action, error), null, 2)}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1] ? url(process.argv[1]).href : '';
if (import.meta.url === entry) await run();

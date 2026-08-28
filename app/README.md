# Reader

`Reader` is a concurrent TypeScript engine for filesystem and process automation.
Every direct command writes a correlated JSON response. Errors are JSON on standard
error with a nonzero exit code.

It uses the host platform's native path implementation. Absolute and relative
paths therefore work with Linux, macOS, Windows Command Prompt, and PowerShell.
Quote paths that contain spaces according to the shell being used.

## Configuration

Defaults, response limits, and command names are stored in `config.json`:

```json
{
  "lines": {
    "size": 200,
    "limit": 500
  },
  "items": {
    "size": 200,
    "limit": 500
  },
  "exec": {
    "timeout": 30000,
    "limit": 120000,
    "bytes": 1048576,
    "store": 16777216,
    "shell": false
  },
  "edit": {
    "bytes": 10485760
  },
  "create": {
    "bytes": 10485760
  },
  "engine": {
    "limit": 8,
    "wait": 30000
  },
  "server": {
    "host": "127.0.0.1",
    "port": 14783,
    "path": "/socket",
    "bytes": 1048576,
    "token": ""
  },
  "commands": {
    "list": "list",
    "read": "read",
    "exec": "exec",
    "create": "create",
    "edit": "edit",
    "delete": "delete",
    "status": "status",
    "serve": "serve",
    "help": "help"
  }
}
```

`size` is the default page size and `limit` is the largest value accepted from a
command. `exec.timeout` is the normal command timeout, `exec.limit` is the largest
timeout accepted from the CLI. `exec.bytes` is the amount of stdout and stderr
returned per snapshot, while `exec.store` is the amount retained per stream for
later pages. `edit.bytes` is the largest file accepted for region replacement.
`create.bytes` is the largest initial file content accepted by creation.
`engine.limit` is the number of operations that can run concurrently, and
`engine.wait` is the largest non-terminating progress wait. Command values can be
changed without editing the TypeScript source. For example, changing
`commands.read` to `view` makes `view` the file command.

Use a different configuration file for one invocation:

```bash
node src/tool.ts view "/path/to/file" --config "/path/to/config.json"
```

## Requirements

- Node.js 22.18 or newer

Node runs the TypeScript source directly with type stripping, so a build step is
not required. Run `npm install` once to install Fastify and its WebSocket plugin.

## Operations

Every operation has an `id` and `action`. A direct CLI invocation generates an ID
unless `--id` supplies one:

```bash
node src/tool.ts read "/path/to/file" --id source-1
```

Success and failure use the same correlation envelope:

```json
{
  "id": "source-1",
  "action": "read",
  "ok": true,
  "data": {}
}
```

```json
{
  "id": "source-1",
  "action": "read",
  "ok": false,
  "error": {
    "code": "MISSING",
    "message": "Path does not exist"
  }
}
```

Operation-specific results described below are contained in `data`.

### Concurrent mode

Start the persistent engine:

```bash
node src/tool.ts serve
```

Write one JSON request per line to standard input. The engine emits one compact
JSON response per line as soon as each operation responds:

```json
{"id":"tree","action":"list","path":"/path/to/project"}
{"id":"tests","action":"exec","words":["npm","test"],"cwd":"/path/to/project"}
{"id":"source","action":"read","path":"/path/to/file","size":100}
```

Responses may arrive in a different order because operations run concurrently.
Use `id`, not line order, to correlate them. IDs must be unique for the lifetime of
the engine session. Once `engine.limit` operations are active, additional work is
queued. Errors are emitted on standard output in this mode so the NDJSON response
stream remains complete.

### WebSocket mode

Start the Fastify server:

```bash
npm run server
```

`READER_HOST` and `READER_PORT` override the configured address for one run:

```bash
READER_PORT=14784 npm run server
```

The defaults expose:

```text
WebSocket: ws://127.0.0.1:14783/socket
Health:    http://127.0.0.1:14783/health
```

Each WebSocket message contains one JSON request. Each response contains the same
operation envelope used by direct and NDJSON modes:

```typescript
import WebSocket from 'ws';

const socket = new WebSocket('ws://127.0.0.1:14783/socket');

socket.on('open', () => {
  socket.send(JSON.stringify({
    id: 'source-1',
    action: 'read',
    path: '/path/to/file',
    size: 100,
  }));
});

socket.on('message', (data) => {
  const reply = JSON.parse(data.toString());
  console.log(reply.id, reply.ok, reply.data);
});
```

WebSocket clients can keep a connection active without consuming an operation ID:

```json
{"kind":"ping"}
```

The server answers `{"kind":"pong"}`. This control frame does not enter the
engine queue or job registry.

Operations on one connection run concurrently and may respond out of order. Every
connection has an independent engine, ID namespace, job registry, and queue. When
a socket disconnects, its still-running command trees are terminated.

`server.bytes` limits each incoming WebSocket message. The server binds only to
loopback by default. A non-loopback `server.host` is rejected unless a token is set
in `server.token` or `READER_TOKEN`. Authenticated clients provide it during the
upgrade request:

```typescript
const socket = new WebSocket('ws://host:14783/socket', {
  headers: { authorization: `Bearer ${process.env.READER_TOKEN}` },
});
```

## Directories

List the current directory:

```bash
node src/tool.ts list
```

Start directly at an absolute directory:

```bash
node src/tool.ts list "/home/user/project/src"
```

```powershell
node src/tool.ts list "C:\Users\user\project\src"
```

Only one level is returned. Each item includes a canonical absolute `path`; pass
that value to another `list` call to expand a directory. Directory results use
`page.next` for directories containing more than the requested limit:

```bash
node src/tool.ts list "/path/to/project/node_modules" --limit 200 --offset 200
```

High-volume directories such as `node_modules`, `.git`, `dist`, and `vendor` are
marked with `volume: true`, but they are not hidden, skipped, or made inaccessible.
They use the same one-level listing and pagination contract as every other
directory, so dependencies can be inspected without returning the entire tree.

## Files

Read the configured default number of lines:

```bash
node src/tool.ts read "/path/to/project/src/tool.ts"
```

Read a specific inclusive range:

```bash
node src/tool.ts read "/path/to/project/src/tool.ts" --start 120 --end 219
```

Every result includes the total and remaining line counts:

```json
{
  "range": {
    "start": 120,
    "end": 219,
    "total": 900,
    "remain": 681
  },
  "next": {
    "start": 220,
    "end": 319,
    "cursor": "continuation token"
  }
}
```

Continue without resending the path or calculating a new range:

```bash
node src/tool.ts read --cursor "continuation token"
```

Repeat with each returned `next.cursor` until `next` is `null`. This supports a
whole-file workflow while keeping every tool response bounded. A cursor is
rejected if the file changes before the next read.

Use `--size` to choose an automatic page size up to `lines.limit`. An explicit
`--start` and `--end` range is constrained by the same configured limit.

## Execution

Run an executable directly with its arguments after `--`:

```bash
node src/tool.ts exec -- git status --short
node src/tool.ts exec --cwd "/path/to/project" -- npm test
```

The executable is resolved through the operating system's `PATH`. An absolute
executable path also works. The result is JSON containing `code`, `signal`,
`output`, `error`, `timed`, `duration`, `state`, and output truncation state in
`cut`.

Use the platform shell for built-ins, pipes, expansion, or redirection. The entire
shell expression must be passed as one quoted argument:

```bash
node src/tool.ts exec --shell -- "printf 'hello' | tr a-z A-Z"
```

```powershell
node src/tool.ts exec --shell -- "dir /b | findstr .ts"
```

Optional controls are placed before `--`:

```bash
node src/tool.ts exec --timeout 60000 --input "answer" -- command argument
```

Execution is intentionally unrestricted. Commands inherit the Reader process's
environment and operating-system permissions, can use working directories outside
the current workspace, and are not run in a sandbox.

### Hard timeout

`timeout` is the terminating limit. If the command is still running when it
expires, its process tree is stopped and a final response returns `state: "done"`
with `timed: true`:

```json
{"id":"build","action":"exec","words":["npm","run","build"],"timeout":60000}
```

### Progress wait

`wait` is non-terminating and is available through `serve` or the imported
`Engine`. If the command has not completed when `wait` expires, the response
contains its output so far with `state: "running"`:

```json
{"id":"build","action":"exec","words":["npm","run","build"],"timeout":120000,"wait":1000}
```

Poll that execution using a new operation ID and the execution ID as `target`:

```json
{"id":"build-check-1","action":"status","target":"build"}
{"id":"build-check-2","action":"status","target":"build","wait":1000}
```

A status request without `wait` returns immediately. With `wait`, it returns when
the command completes or the progress interval expires. Continue until `state` is
`done`. The hard execution `timeout` remains active during every progress wait.
Progress mode is rejected by the one-shot CLI because that process cannot retain a
job for later polling.

### Snapshot pages

Stdout and stderr are paginated independently. Every execution or status response
contains one page from each stream:

```json
{
  "output": "current stdout page",
  "error": "current stderr page",
  "page": {
    "output": {
      "start": 0,
      "end": 1048576,
      "total": 2400000,
      "stored": 2400000,
      "remain": 1351424,
      "lost": 0,
      "next": 1048576
    },
    "error": {
      "start": 0,
      "end": 0,
      "total": 0,
      "stored": 0,
      "remain": 0,
      "lost": 0,
      "next": null
    }
  }
}
```

Use the returned `next` offsets in a new status operation:

```json
{"id":"build-page-2","action":"status","target":"build","out":1048576,"err":0}
```

`end` is exclusive. `remain` is the retrievable content after the current page,
and `lost` reports bytes discarded after `exec.store` was exhausted. While an
execution is running, `next` can equal `end` even when `remain` is zero; polling
that offset later retrieves newly produced output. Once a completed stream is
fully consumed, `next` is `null`.

## Editing

Replace one exact text region without supplying line numbers or the full file:

```bash
node src/tool.ts edit "/path/to/file.ts" \
  --before "const mode = 'old';" \
  --after "const mode = 'new';"
```

Matching is literal, including whitespace and line endings. No regular expression
syntax or replacement expansion is applied. If `before` is absent, the file is not
changed. If it occurs more than once, the edit is rejected as ambiguous. Select a
specific one-based occurrence when duplication is intentional:

```bash
node src/tool.ts edit "/path/to/file.ts" \
  --before "return null;" \
  --after "return value;" \
  --index 2
```

For functions or other multiline regions, use a JSON specification. The `path` is
absolute or relative to the command's working directory:

```json
{
  "path": "/path/to/file.ts",
  "before": "function old() {\n  return false;\n}",
  "after": "function current() {\n  return true;\n}",
  "index": 1
}
```

```bash
node src/tool.ts edit --spec "/path/to/change.json"
```

The tool writes the replacement atomically and preserves all content outside the
selected region. It rejects binary files, oversized files, and edits where the file
changes while the replacement is being prepared.

## Creating

Create a directory, optionally including missing parents:

```bash
node src/tool.ts create "/path/to/new/folder" --type directory --parents
```

Create a file with initial content:

```bash
node src/tool.ts create "/path/to/new/file.txt" --type file --content "hello"
```

WebSocket and `serve` requests use the same fields:

```json
{"id":"folder","action":"create","path":"work/nested","type":"directory","parents":true}
{"id":"file","action":"create","path":"work/nested/file.txt","type":"file","content":"hello"}
```

Creation never overwrites an existing path. Use exact-region editing for existing
files. Initial content is limited by `create.bytes`.

## Deleting

Delete a file or symbolic link:

```bash
node src/tool.ts delete "/path/to/file.ts"
```

Directories are rejected. Deleting a symbolic link removes only the link. Deletion
is permanent and does not move the file to an operating-system trash directory.

## Library

```typescript
import { Engine, setting, Tool } from './src/tool.ts';

const config = setting('/path/to/config.json');
const tool = new Tool(process.cwd(), config);
const tree = await tool.list('/path/to/project');
const page = await tool.read({ path: '/path/to/file', size: 200 });
const next = page.next
  ? await tool.read({ cursor: page.next.cursor })
  : null;
const result = await tool.exec({ words: ['git', 'status', '--short'] });
const created = await tool.create({
  path: '/path/to/file',
  type: 'file',
  content: 'hello',
});
const change = await tool.edit({
  path: '/path/to/file',
  before: 'old text',
  after: 'new text',
});
const removed = await tool.remove('/path/to/file');

const engine = new Engine(tool, config);
const running = await engine.run({
  id: 'build',
  action: config.commands.exec,
  words: ['npm', 'run', 'build'],
  timeout: 120000,
  wait: 1000,
});
const progress = await engine.run({
  id: 'build-check-1',
  action: config.commands.status,
  target: 'build',
});
```

## Commands

```bash
node src/tool.ts help
npm test
npm run check
```

# Qlyx

Qlyx is a workspace-aware local development bridge for AI chat agents. One
user-level daemon serves every registered project, while each project keeps a
compact provider-neutral state under `.agent/`. Every direct command writes a
correlated JSON response. Errors are JSON on standard error with a nonzero exit
code.

It uses the host platform's native path implementation. Absolute and relative
paths therefore work with Linux, macOS, Windows Command Prompt, and PowerShell.
Quote paths that contain spaces according to the shell being used.

## Workspace daemon

After the package is published, initialize a project from its root:

```bash
npx @radiiplus/qlyx init
```

`init` creates `.agent/state.json`, initializes the project-owned agent files and
`qlyx.prompts.json`, registers the canonical root in the user-level Qlyx registry,
and starts the background daemon when it is offline. If the daemon is already
running, the new workspace is attached to that process. A second daemon is not
started.

```bash
qlyx init [path] [--name name] [--no-start]
qlyx list [--json]
qlyx guide [path] [--json]
qlyx status [--json]
qlyx use <id|name>
qlyx start [path]
qlyx stop [path]
qlyx remove [path]
qlyx logs
qlyx doctor
qlyx daemon start|stop
```

`qlyx stop` deactivates only the selected workspace and terminates its active
jobs; the shared daemon and other workspaces remain available. `qlyx remove`
unregisters the workspace without deleting project files. Use `qlyx daemon stop`
to stop the process itself.

The registry, daemon metadata, and daemon log live under the platform's per-user
state directory (`$XDG_STATE_HOME/qlyx` or `~/.local/state/qlyx` on Linux). Set
`QLYX_STATE_DIR` to relocate the parent state directory. The daemon listens on the
configured fixed endpoint, so the extension discovers all active workspaces with
one connection.

The npm artifact is built by `npm run build`; `npm pack --dry-run` verifies the
published `qlyx` executable and included files. Publishing remains an explicit
release action:

```bash
npm login
npm publish
```

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
    "wait": 30000,
    "batch": 20
  },
  "server": {
    "host": "127.0.0.1",
    "port": 14783,
    "path": "/socket",
    "bytes": 1048576,
    "token": ""
  },
  "commands": {
    "batch": "batch",
    "autonomyState": "autonomy_state",
    "autonomyUpdate": "autonomy_update",
    "autonomyEvent": "autonomy_event",
    "list": "list",
    "read": "read",
    "exec": "exec",
    "create": "create",
    "edit": "edit",
    "delete": "delete",
    "status": "status",
    "session": "session",
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
`engine.limit` is the number of operations that can run concurrently,
`engine.wait` is the largest non-terminating progress wait, and `engine.batch`
is the largest accepted operation group. The edit limit applies
to both the current file and the fully patched result. Command values can be
changed without editing the TypeScript source. For example, changing
`commands.read` to `view` makes `view` the file command.

Use a different configuration file for one invocation:

```bash
npx tsx src/tool.ts view "/path/to/file" --config "/path/to/config.json"
```

## Requirements

- Node.js 22.18 or newer

The included `tsx` runner executes the TypeScript source without a build step.
Run `npm install` once before using the commands.

## Operations

Every operation has an `id` and `action`. A direct CLI invocation generates an ID
unless `--id` supplies one:

```bash
npx tsx src/tool.ts read "/path/to/file" --id source-1
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
npx tsx src/tool.ts serve
```

Write one JSON request per line to standard input. The engine emits one compact
JSON response per line as soon as each operation responds:

```json
{"id":"tree","action":"list","path":"/path/to/project"}
{"id":"tests","action":"exec","words":["npm","test"],"cwd":"/path/to/project"}
{"id":"source","action":"read","path":"/path/to/file","size":100}
```

Responses may arrive in a different order because operations run concurrently.
Use `id`, not line order, to correlate them. IDs identify one immutable request for
the lifetime of the engine session. Repeating the same ID and payload returns the
recorded reply without executing again; reusing an ID for a different payload is
rejected. Once `engine.limit` operations are active, additional work is registered
as `queued` before it waits for a slot. Errors are emitted on standard output in
this mode so the NDJSON response stream remains complete.

### Batched operations

Streaming transports accept one batch envelope containing up to `engine.batch`
child operations:

```json
{"id":"inspect","action":"batch","operations":[{"id":"tree","action":"list","path":"src"},{"id":"tests","action":"exec","words":["npm","test"],"cwd":"."}]}
```

Each child has its own unique ID and normal action fields. Qlyx routes each child
from its own action, so one batch may mix independent `autonomy_state`,
`autonomy_update`, `autonomy_event`, filesystem, and exec work without switching
top-level actions. Durable-state and filesystem children run in listed order so
mutations cannot race each other. Exec children use the normal bounded-concurrency
scheduler. Nested batches, session requests, status polls, and cancellation
requests are rejected.

The transport can emit more than one reply with the batch ID. Every reply groups
the children that have finished at that moment:

```json
{"id":"inspect","action":"batch","ok":true,"data":{"total":2,"completed":1,"pending":1,"failed":0,"complete":false,"results":[{"id":"tree","action":"list","ok":true,"data":{}}]}}
```

The final update has `complete=true`. Every update also includes `succeeded` and a
cumulative `errors` array containing the failed child IDs, actions, codes, and
messages. A successful batch envelope means the batch was accepted; clients must
still inspect each result's `ok` field. Repeating an identical batch ID returns one
cumulative snapshot and never runs its children twice.

### Autonomous lifecycle

Autonomous work uses a durable, provider-neutral checkpoint rather than relying
on one chat transcript. Start or replace a run with `reset=true`:

```json
{"id":"run-start","action":"autonomy_update","reset":true,"status":"running","phase":"observe","objective":"Repair authentication expiry handling","iteration":1,"plan":[{"id":"inspect","text":"Inspect the authentication path","status":"active"}],"hypotheses":[],"evidence":[],"decisions":[],"next":"Read the middleware and focused tests."}
```

The supported phases are `observe`, `reason`, `act`, `verify`, `persist`, and
`continue`. Arrays on `autonomy_update` replace their compact current snapshots;
IDs must be unique. Record material lifecycle facts independently:

```json
{"id":"verification-event","action":"autonomy_event","event":"verification.passed","summary":"Focused authentication tests passed.","detail":"3 tests passed with no failures.","refs":["auth-test"]}
```

Read the current checkpoint and up to 100 paged event records with
`autonomy_state`. State mutations are serialized, schema-validated, atomically
written, and limited to 512 KiB. The append-only event history remains separate
from the general operation history.

### WebSocket mode

The workspace CLI normally owns the Fastify daemon lifecycle:

```bash
qlyx daemon start
```

`QLYX_HOST` and `QLYX_PORT` override the configured address for one run:

```bash
QLYX_PORT=14784 qlyx daemon start
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
    workspace: 'workspace-id',
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

The server answers with `kind: "pong"`, the default workspace ID, and the current
workspace catalog. This control frame does not enter an engine queue or job
registry. `workspace.list`, `workspace.use`, `workspace.stop`,
`workspace.remove`, and `daemon.stop` are correlated control messages.

Operations on one connection run concurrently and may respond out of order. Every
connection has an independent engine, ID namespace, job registry, and queue for
each workspace it uses. When a socket disconnects, its still-running command trees
are terminated. Connections share each workspace's durable `.agent` store without
sharing state across workspace roots.

`server.bytes` limits each incoming WebSocket message. The server binds only to
loopback by default. A non-loopback `server.host` is rejected unless a token is set
in `server.token` or `QLYX_TOKEN`. Authenticated clients provide it during the
upgrade request:

```typescript
const socket = new WebSocket('ws://host:14783/socket', {
  headers: { authorization: `Bearer ${process.env.QLYX_TOKEN}` },
});
```

## Session Persistence

Running `qlyx init`, the CLI, or the WebSocket server initializes the core files
in this structure; `evidence/last-patch.json` appears after the first successful
edit:

```text
qlyx.prompts.json
.agent/
  context.md
  state.json
  objectives.md
  hypotheses.md
  decisions.md
  guide.md
  events.log
  evidence/
    index.md
    last-patch.json
```

`context.md` is the AI-maintained working summary. The desktop app creates a
structured initial document but does not summarize conversations or rewrite its
contents. It represents what is true now, not a conversation history or changelog.
Agents update persistent state only after significant discoveries, decisions,
modifications, failures, or changes in direction; routine reads, searches, polls,
and ordinary turns do not create durable records.

`state.json` is daemon-owned and atomically stores the workspace identity, durable
chat session metadata, and the compact machine-readable checkpoint for one active
run. The focused Markdown files project the active objectives, hypotheses, and
decisions for recovery without requiring a model to parse the full event history.
`events.log` is append-only and records only significant lifecycle events. Routine
operations do not rewrite `state.json` or append action/result audit noise.
`guide.md` is a stable recovery reference for an agent that loses track of the
task, protocol, or next step. Run `qlyx guide` from the workspace to print it.

Every successful `edit` atomically replaces `evidence/last-patch.json` with the
latest patch description and an embedded base64 snapshot of the file immediately
before that edit. This rolling record and the sibling `<file>.bak` are bounded, so
edits do not accumulate snapshots. Qlyx stages the record before changing the
target and rolls the edit back if the record cannot be committed. File operations
may update the current-state Markdown files and evidence contents, but cannot
mutate daemon-owned state or event history.

`qlyx.prompts.json` is the validated, workspace-editable prompt bundle. Qlyx
creates it from the built-in defaults when missing and migrates the former
`.agent/prompts.json` location on first open. It contains `base`, `protocol`, the
optional `autonomy` and `browser` modules, and the available prompt `scenarios`.
Edit it outside the Qlyx agent bridge, then restart the daemon to load changes.
The bundle must include at least one uniquely identified scenario. Invalid JSON,
duplicate IDs, empty scenario lists, and missing required text return a `PROMPTS`
failure.

Request the entry prompt alone through the CLI:

```bash
npx tsx src/tool.ts session --mode setup --model ChatGPT
```

Request the saved-context continuation prompt through the CLI:

```bash
npx tsx src/tool.ts session --mode continue --model ChatGPT
```

The same modes are available through WebSocket:

```json
{"id":"setup-1","action":"session","mode":"setup","model":"ChatGPT"}
{"id":"continue-1","action":"session","mode":"continue","model":"ChatGPT","personal":"Keep public APIs stable."}
```

Setup mode composes `base + protocol + optional autonomy + current autonomous
state and recent events + optional browser + all working modes + optional personal
context`. Continue mode prepends the exact current `context.md` to that
composition. Every response also includes the scenario menu as
`{id,name,description}` records for clients. The built-in scenarios are
`planning`, `exploratory`, `autonomous`, and `coding`. The prompt teaches the agent
to choose, combine, and switch these modes as work changes; there is no manual mode
selection. The legacy `scenario` request field is accepted but ignored. Personal
context is trimmed and appended under `## Task Context`.

The protocol permits at most one single or batched raw Qlyx command block per
response and documents the daemon's filesystem, process, and autonomy commands
plus the extension's `browser_*` and `agent_*` actions. Browser tabs are exposed
only through conversation-scoped logical `page` handles; raw browser tab IDs stay
inside the extension. The control surface covers open/close/list/focus,
navigate/back/forward, bounded inspect/expand, click/type/scroll, and exact
content or attribute extraction. `browser_start` launches a named asynchronous job
whose operation IDs complete independently; same-page work is ordered while
different logical pages navigate and extract concurrently. `browser_status`
returns bounded metadata and event history, and `browser_cancel` cancels a whole
job or one operation.

Browser page maps stay extension-side and expose only bounded semantic branches.
Their primary locator is a structural semantic path such as
`Main/Contract/Source Code`; missing and uncertain paths return `NOT_FOUND` or
`AMBIGUOUS_PATH` instead of selecting an approximate element. Inspection,
interaction, and extraction observations are ephemeral and omitted from the
extension's durable activity data. Asynchronous job state likewise retains only
requests, status, timestamps, bounded errors, and lifecycle events; completion
payloads are transient `browser_event` replies. A document-wide HTML read
automatically becomes a bounded collapsed page map. The agent expands one branch
at a time and reads HTML only from an identified subtree.
Only an explicit `browser_evidence` request, or the legacy `browser_dump` archive
request, moves an exact selection directly to the bound workspace through the
existing correlated `create` operation.
The protocol requires parsing, validation, execution, and delivery failures to be
reported in the next assistant response.
Search, git inspection, builds, and tests use `exec`; queued and running work uses
`status` and `cancel`. Reopening the app
or switching providers retains the same session ID and context. No conversation
transcript, automatic summary, or provider-specific state is transferred.

The AI never receives a filesystem handle, terminal, process object, registry,
or daemon credential. It can only request configured Qlyx actions and consume
their bounded correlated results. Provider-to-provider messages are likewise
untrusted claims until independently verified through those explicit actions.

## Directories

List the current directory:

```bash
npx tsx src/tool.ts list
```

Start directly at an absolute directory:

```bash
npx tsx src/tool.ts list "/home/user/project/src"
```

```powershell
npx tsx src/tool.ts list "C:\Users\user\project\src"
```

Only one level is returned. Each item includes a canonical absolute `path`; pass
that value to another `list` call to expand a directory. Directory results use
`page.next` for directories containing more than the requested limit:

```bash
npx tsx src/tool.ts list "/path/to/project/node_modules" --limit 200 --offset 200
```

High-volume directories such as `node_modules`, `.git`, `dist`, and `vendor` are
marked with `volume: true`, but they are not hidden, skipped, or made inaccessible.
They use the same one-level listing and pagination contract as every other
directory, so dependencies can be inspected without returning the entire tree.

## Files

Read the configured default number of lines:

```bash
npx tsx src/tool.ts read "/path/to/project/src/tool.ts"
```

Read a specific inclusive range:

```bash
npx tsx src/tool.ts read "/path/to/project/src/tool.ts" --start 120 --end 219
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
npx tsx src/tool.ts read --cursor "continuation token"
```

Repeat with each returned `next.cursor` until `next` is `null`. This supports a
whole-file workflow while keeping every tool response bounded. A cursor is
rejected if the file changes before the next read.

Use `--size` to choose an automatic page size up to `lines.limit`. An explicit
`--start` and `--end` range is constrained by the same configured limit.

## Execution

Run an executable directly with its arguments after `--`:

```bash
npx tsx src/tool.ts exec -- git status --short
npx tsx src/tool.ts exec --cwd "/path/to/project" -- npm test
```

The executable is resolved through the operating system's `PATH`. An absolute
executable path also works. The result is JSON containing `code`, `signal`,
`output`, `error`, `timed`, `duration`, `state`, and output truncation state in
`cut`.

Use the platform shell for built-ins, pipes, expansion, or redirection. The entire
shell expression must be passed as one quoted argument:

```bash
npx tsx src/tool.ts exec --shell -- "printf 'hello' | tr a-z A-Z"
```

```powershell
npx tsx src/tool.ts exec --shell -- "dir /b | findstr .ts"
```

Optional controls are placed before `--`:

```bash
npx tsx src/tool.ts exec --timeout 60000 --input "answer" -- command argument
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

An execution waiting for `engine.limit` capacity reports `state: "queued"` rather
than an unknown-job error. Status also accepts a batch ID. Batch status returns a
cumulative snapshot with `total`, `completed`, `succeeded`, `pending`, `failed`,
`complete`, `results`, and `errors`; continue until its state is `done`.

Cancel a queued or running execution, or all unfinished work in a batch:

```json
{"id":"cancel-build","action":"cancel","target":"build"}
```

Queued exec requests are prevented from starting. Running exec requests terminate
their process group with the same graceful-then-forced shutdown used by timeouts.
Batch cancellation stops active exec children and reports unstarted children as
cancelled. It does not roll back filesystem work that already completed.

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
npx tsx src/tool.ts edit "/path/to/file.ts" \
  --before "const mode = 'old';" \
  --after "const mode = 'new';"
```

Matching is literal, including whitespace and line endings. No regular expression
syntax or replacement expansion is applied. If `before` is absent, the file is not
changed. If it occurs more than once, the edit is rejected as ambiguous. Select a
specific one-based occurrence when duplication is intentional:

```bash
npx tsx src/tool.ts edit "/path/to/file.ts" \
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
npx tsx src/tool.ts edit --spec "/path/to/change.json"
```

Before committing, the tool stages and byte-validates both the patched file and a
full rollback snapshot. It then atomically replaces `<file>.bak` with the current
file and atomically replaces the target with the validated patch. The single
`.bak` is bounded: each successful edit overwrites it with the immediately
preceding file state instead of appending history. A rejected patch does not alter
the target or its prior backup. The result includes `backup.path` and
`backup.bytes`; a no-op edit returns `backup: null`.

When session persistence is active, the same validated source and applied
replacement are stored together in the rolling
`.agent/evidence/last-patch.json` record.

The tool preserves all content outside the selected region. It rejects binary
files, oversized current or patched files, ambiguous matches, and edits where the
file changes while the replacement is being prepared.

## Creating

Create a directory, optionally including missing parents:

```bash
npx tsx src/tool.ts create "/path/to/new/folder" --type directory --parents
```

Create a file with initial content:

```bash
npx tsx src/tool.ts create "/path/to/new/file.txt" --type file --content "hello"
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
npx tsx src/tool.ts delete "/path/to/file.ts"
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
npx tsx src/tool.ts help
npm test
npm run check
```

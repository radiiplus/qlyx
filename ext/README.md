# Qlyx Extension

This Manifest V3 extension watches assistant responses on a selected chat tab and
routes complete Qlyx blocks to the app WebSocket. Monitoring is disabled by
default. Right-click a supported chat page and select
`Enable or disable Qlyx for this tab`, or press `Alt+Shift+Q`. The toolbar action
is a status badge and has no click handler.

Supported hosts are ChatGPT, Claude, Gemini, DeepSeek, Qwen, and Kimi, including
`kimi.ai`. The extension detects the AI from the enabled tab's host. Host names,
assistant responses, input fields, send controls, stop controls, and busy signals
are data in `config.json`; they are not embedded in the TypeScript parser.

## Build

```bash
npm install
npm run check
npm test
npm run build
```

Load `ext` as an unpacked extension from `chrome://extensions` after enabling
developer mode. The manifest loads the generated scripts from `dist`.

Start the app server before enabling a chat tab:

```bash
cd ../app
npm run server
```

The toolbar badge reports `ON`, in-progress work, successful work, and failures.
Replies are written to the tab's developer console and emitted as a `qlyx` window
event whose `detail` is a JSON string.

An enabled tab stays enabled when it becomes a background tab and after a page
reload. It is marked non-discardable while enabled so Chrome does not unload it
automatically under resource pressure. Disabling restores its prior discard state.

## Configuration

`config.json` controls:

- `socket.url`: app WebSocket address.
- `socket.pulse`: keepalive interval in milliseconds.
- `socket.limit`: maximum requests awaiting replies.
- `watch.delay`: delay used to combine streaming DOM mutations.
- `watch.bytes`: maximum payload size accepted from one block.
- `agent.enabled`: whether operation replies are sent back into the AI chat.
- `agent.delay`: control-settle and progress-poll interval.
- `agent.idle`: time assistant text must remain unchanged before it is idle.
- `agent.limit`: maximum operation replies waiting to be sent into the chat.
- `agent.prompt`, `agent.start`, and `agent.end`: result-message encapsulation.
- `marks`: the action and exact start/end marker for every operation.
- `sites`: supported hosts and selector lists named `reply`, `input`, `send`,
  `stop`, and `busy`.

After changing the configuration or TypeScript, run `npm run build` and reload the
unpacked extension. Site markup can change independently; update only the relevant
selector list when a service changes its assistant message structure.

## Protocol

Each block has an action-specific start marker, one JSON object, and its matching
end marker. A block is sent only after the end marker appears, which makes the
parser safe to use while a response is still streaming. The operation executes as
soon as that complete block is found; it does not wait for the rest of the AI
response to finish. Include a meaningful `id` when later operations need to refer
to the request.

### List a directory

```text
@@qlyx:list
{"id":"tree-1","path":"/path/to/project","offset":0,"limit":100}
@@qlyx:end:list
```

If `data.page.next` is a number, request the next directory page with that value as
`offset`. Directory traversal remains one level at a time.

### Read a file

```text
@@qlyx:read
{"id":"source-1","path":"/path/to/file.ts","start":1,"end":200}
@@qlyx:end:read
```

Continue automatic file pagination by placing the returned `data.next.cursor` in a
new block:

```text
@@qlyx:read
{"id":"source-2","cursor":"continuation token"}
@@qlyx:end:read
```

### Create a directory or file

```text
@@qlyx:create
{"id":"folder-1","path":"/path/to/work/nested","type":"directory","parents":true}
@@qlyx:end:create
```

```text
@@qlyx:create
{"id":"file-1","path":"/path/to/work/code.ts","type":"file","content":"export const ready = true;\n","parents":true}
@@qlyx:end:create
```

Creation does not overwrite an existing path.

### Edit an exact region

The `before` and `after` JSON strings encapsulate the old and new snippets. JSON
newline escapes preserve multiline code without requiring line numbers or a whole
file rewrite.

```text
@@qlyx:edit
{"id":"edit-1","path":"/path/to/work/code.ts","before":"function old() {\n  return false;\n}","after":"function next() {\n  return true;\n}"}
@@qlyx:end:edit
```

Add `index` when the old region intentionally occurs more than once.

### Delete a file or link

```text
@@qlyx:delete
{"id":"delete-1","path":"/path/to/work/code.ts"}
@@qlyx:end:delete
```

The app rejects directory deletion. This matches the app's current permanent-delete
contract.

### Execute a command

`timeout` is the hard terminating timeout. `wait` returns a progress snapshot
without stopping the command.

```text
@@qlyx:exec
{"id":"build","words":["npm","run","build"],"cwd":"/path/to/project","timeout":120000,"wait":1000}
@@qlyx:end:exec
```

Use `shell: true` only when `words` contains one platform-shell expression.

### Monitor a command

The `target` is the logical ID from the earlier execution. The extension translates
both IDs into the tab-scoped IDs used by the socket engine.

```text
@@qlyx:status
{"id":"build-check-1","target":"build","wait":1000}
@@qlyx:end:status
```

Continue until `data.state` is `done`. To page retained stdout and stderr, put the
returned `data.page.output.next` and `data.page.error.next` values into `out` and
`err` on another status block.

## Behavior

When monitoring starts, already completed blocks are recorded but not executed.
An incomplete block already being streamed will execute once its end marker
arrives. A completed block is executed once per page session; changing its `id`
creates a distinct operation.

Operations from different assistant responses or tabs can run concurrently. The
extension keeps a correlation entry for each server ID and sends each reply back to
the originating tab.

For chat progress, the extension combines several signals rather than relying on
one element: visible stop controls, configured busy or streaming elements, and the
time since the latest assistant-response mutation. Socket operations are not held
up by that state. Instead, completed operation replies wait in a per-tab queue until
the AI becomes idle, its input is empty, and an enabled send control is available.
The extension then inserts a configured `@@qlyx:result` block and submits it so the
AI can continue the task autonomously. It never overwrites an existing user draft.

## Safety

Enabling a tab authorizes assistant output in that tab to run commands and modify
files with the app server's operating-system permissions. Prompt injection in page
content can therefore have filesystem or command-execution impact. Enable only a
session you trust and inspect requested operations when appropriate. Use the page
context menu or `Alt+Shift+Q` again to disable monitoring. Set `agent.enabled` to
`false` when results should be observed but not submitted back into the AI chat.

# Qlyx Extension

This Manifest V3 extension watches assistant responses on a selected chat tab and
routes complete Qlyx blocks to the app WebSocket. Monitoring is disabled by
default. Open the toolbar popup to view the local server connection, inspect tab
activity, and enable or disable monitoring. The same toggle remains available by
right-clicking a supported chat page or pressing `Alt+Shift+Q`.
Use the popup's `Prepare this chat` action to send the composed protocol prompt in
the detected existing chat. The Session view selects a registered workspace,
and optional task context; working mode is adaptive and selected by the agent from
the complete mode catalog in its prompt. Press `Alt+Shift+C` to submit that
workspace's saved `context.md` followed by the adaptive prompt without
toggling monitoring.

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

Initialize the project before enabling a chat tab. The command starts the shared
daemon or attaches the project when that daemon is already running:

```bash
cd ../app
node dist/cli.js init
```

After npm publication, use `npx @radiiplus/qlyx init` from any project root.

The toolbar popup is a compact quick launcher with connection readiness,
conversation authorization, monitoring state, the next contextual action, and a
small operation summary. It also exposes independent Pause/Resume controls for
local execution and result delivery. `Open Control Center` launches the persistent Chrome side
panel so Qlyx remains visible beside the current chat. The page context menu also
provides `Open Qlyx sidebar`.

The Control Center is a separate operational surface with six icon-only views:
Control, Activity, Browser, Diagnostics, Session, and Settings. Control exposes current
readiness and the monitoring action; Activity contains expandable human-readable
operations; Browser shows logical tab lifecycle, asynchronous jobs, operation
state, and recent completion or error events without exposing raw tab IDs,
requests, result payloads, or DOM content; Diagnostics isolates WebSocket, DOM, protocol, and log telemetry;
Session provides workspace selection, workspace stop control, adaptive mode status,
personal task context, and the exact-conversation authorization lock; Settings
keeps bridge, monitoring, appearance, and advanced
protocol preferences separate. Qlyx remembers
the last view and can automatically follow a newly running operation into Activity.
Control shows queued executions and lists completed responses that are waiting to
be delivered back to the chat.

`Prepare this chat` asks the desktop app to compose the workspace prompt bundle and
submits it in the detected existing conversation. The Session view loads its
workspace catalog from the daemon and its mode catalog from the selected
workspace's `qlyx.prompts.json`. Every mode is included and the agent switches
between them as the work changes. Optional task context is appended last. The
`Continue session` button and the `Alt+Shift+C` shortcut ask for `.agent/context.md`
followed by that composition, then submit it in the existing conversation. Neither action creates a
chat or changes the conversation URL. Both refuse to overwrite an unrelated draft
or interrupt an active response. Contextual actions remain visible but are enabled
only when their server and conversation prerequisites are met. The toolbar badge
reports monitoring and operation status. Replies are written to the tab's developer
console and emitted as a `qlyx` window event whose `detail` is a JSON string.

The selected workspace is bound to the exact conversation identity. Every
operation and session request carries that workspace ID, so switching the global
selection cannot redirect an already monitored conversation. Stop monitoring
before rebinding a conversation. Stopping a workspace disconnects its bound tabs
and leaves the shared daemon and other active workspaces running.

If the unpacked extension was reloaded while chat tabs were already open, the
popup reinjects and initializes its monitor before inspecting those tabs. A
separate page refresh is not required. Reinjection is idempotent, so concurrent
popup and sidebar checks cannot register duplicate page listeners. Repeating
`Prepare this chat` reuses its exact existing prompt, and `Continue session` may
replace that known Qlyx prompt before submitting the saved context. Any other
composer draft remains protected and is never overwritten.

Prompt delivery uses one native editor transaction for contenteditable providers
and one value update for native inputs, including for large adaptive prompts and
saved context. Qlyx pauses its page observer around that update and caches
discovered open shadow roots, so ChatGPT does not trigger a full-page traversal
for each editor mutation. Before clicking Send, Qlyx verifies that the provider
retained the prompt. Diagnostics records `composer.written` with method, payload
bytes, and elapsed time. Discarded content and composer exceptions are returned as
explicit delivery failures.

An enabled tab stays enabled when it becomes a background tab and after a page
reload. It is marked non-discardable while enabled so Chrome does not unload it
automatically under resource pressure. Disabling restores its prior discard state.
Monitoring locks to the exact conversation URL that was active when it was
enabled. If the tab navigates to a new chat or another conversation, Qlyx stops
sending and requires monitoring to be disabled and re-enabled on an existing
conversation.

Enabling monitoring only starts response observation; it does not submit a prompt.
The explicit setup action submits the composed prompt; continuation requires its
explicit keyboard action and submits the saved context and composed prompt.

The extension reports the configured provider name so the desktop can maintain
the compact `.agent/state.json` session metadata. Current state moves between
providers through `.agent/context.md` and the focused state files; Qlyx does not
copy conversation transcripts or translate provider-specific chat state.

Autonomous runs use the same provider-neutral path: the daemon owns structured
run state and event history, the extension injects correlated results, and the AI
decides the next explicit command. No provider receives direct local access.

## Configuration

`config.json` controls:

- `socket.url`: app WebSocket address.
- `socket.pulse`: keepalive interval in milliseconds.
- `socket.limit`: maximum requests awaiting replies.
- `watch.delay`: delay used to combine streaming DOM mutations.
- `watch.bytes`: maximum payload size accepted from one block.
- `browser.timeout`: page navigation timeout in milliseconds.
- `browser.nodes`: maximum nodes returned by one page-map response.
- `browser.depth`: default page-map snapshot depth; expansion defaults to one.
- `browser.read`: default character page size for an exact DOM read.
- `browser.archive`: maximum bytes stored by one DOM dump.
- `browser.batch`: maximum independent operations in one browser batch.
- `browser.jobs`: maximum retained asynchronous browser jobs.
- `browser.events`: maximum retained lifecycle events per browser job.
- `agent.enabled`: whether operation replies are sent back into the AI chat.
- `agent.delay`: control-settle and progress-poll interval.
- `agent.idle`: time assistant text must remain unchanged before it is idle.
- `agent.limit`: maximum operation replies waiting to be sent into the chat.
- `agent.message`: maximum UTF-8 bytes accepted in one agent-to-agent message.
- `agent.batch`: maximum independent messages in one agent batch.
- `agent.prompt`, `agent.start`, and `agent.end`: raw result encapsulation.
- `marks`: enabled action names and their raw command delimiters.
- `sites`: supported hosts and selector lists named `reply`, `input`, `send`,
  `stop`, and `busy`.

The `batch` mark accepts an `operations` array. The worker sends one request to
the desktop, tracks each child as an active command, and forwards grouped partial
results back to the chat until the desktop marks the batch complete. The processed
counter is retained in `chrome.storage.session` across extension worker restarts.

Configured input selectors take priority. When a site changes its composer markup,
the content script falls back to visible editable controls, ranks prompt and chat
semantics, rejects search and authentication fields, and checks open shadow roots.
Assistant-response discovery also includes conservative assistant and model message
fallbacks so user-message containers are not interpreted as executable responses.

After changing the configuration or TypeScript, run `npm run build` and reload the
unpacked extension. Site markup can change independently; update only the relevant
selector list when a service changes its assistant message structure.

## Protocol

Each operation is a three-line raw command block: an `@@qlyx:<action>` opening
marker, one JSON request object, and the matching `@@qlyx:end:<action>` marker.
Every request object contains its own unique `id`. A command is sent only after its
matching end marker appears, which makes the parser safe while a response is
streaming. The configured raw delimiters are the only executable protocol.

### Autonomous state

The daemon exposes `autonomy_state`, `autonomy_update`, and `autonomy_event` as
normal correlated actions. Together they persist the explicit lifecycle:

```text
Observe -> Reason -> Act -> Verify -> Persist -> Continue
```

The current compact checkpoint and recent events are included in prepared and
continued prompts. `.agent/context.md` remains the concise human-readable recovery
summary. The structured checkpoint records phase, status, objective, plan,
hypotheses, evidence, decisions, and the exact next action.

### Agent collaboration

`agent_list` returns only monitored AI chats bound to the sender's workspace. It
exposes opaque agent handles, provider, title, current state, and whether the chat
is the sender. Conversation identities and local workspace paths are not exposed.

```text
@@qlyx:agent_list
{"id":"available-agents"}
@@qlyx:end:agent_list
```

Queue a bounded message for another listed chat:

```text
@@qlyx:agent_send
{"id":"auth-review","to":"agent-42-a1b2c3d4","message":"Review the authentication tests and report evidence only."}
@@qlyx:end:agent_send
```

The target content script adds the message to its existing idle-aware queue and
does not overwrite a user draft or interrupt a response. A successful receipt
means the message was queued and contains `verified:false`; it does not validate
the recipient model's conclusions. Messages are labeled as untrusted and include
the sender handle for a routed reply. `agent_batch` accepts up to 10 independent
`{id,to,message}` records and reports every child failure. Inactive,
same-chat, missing, and cross-workspace targets are rejected.

### Browser control and page maps

Browser tabs are represented to the AI only by conversation-scoped logical
`page` handles. Raw Chrome tab IDs remain private extension state. Opening a page
returns a bounded semantic map; the complete DOM stays inside its tab. Map nodes
carry a human semantic `path`, `nodeId`, compatibility `domPath`, accessible
role/name, compact labels or text, control state, `childCount`, and `expandable`.

```text
@@qlyx:browser_open
{"id":"docs-open","page":"docs","url":"https://example.com/docs","active":false}
@@qlyx:end:browser_open
```

The semantic `path` is the primary locator. It follows named structure, such as
`Main/Contract/Source Code`, and uses accessible names, roles, visible text,
stable attributes, and nearby labels. `depth` defaults to one and is bounded to
six; `nodes` caps the whole response at 200.

```text
@@qlyx:browser_expand
{"id":"docs-contract","page":"docs","path":"Main/Contract","depth":1,"nodes":80}
@@qlyx:end:browser_expand
```

Find an element by role, accessible name, associated label, text, or tag. Lookup
requires a unique result by default. Multiple matches return an `AMBIGUOUS` error
with a bounded candidate list; `all:true` returns a bounded list for exploration.

```text
@@qlyx:browser_find
{"id":"find-search","page":"docs","role":"textbox","name":"Search","exact":true}
@@qlyx:end:browser_find
```

Inspect and extract one exact node as `text` or subtree `html`. Extracted content
is paged; pass the returned `page.next` as `offset` in a new request.

```text
@@qlyx:browser_extract
{"id":"docs-article","page":"docs","path":"Main/Documentation/Overview","format":"text","limit":65536}
@@qlyx:end:browser_extract
```

Attributes use a separate structured extraction command. If an HTML extraction
resolves to the complete document, Qlyx automatically returns a bounded collapsed
page map instead of the HTML. Expand one returned path or node at a time, then
extract HTML only from the identified subtree. Complete HTML remains local and can
be persisted only through an explicit evidence or dump request.

```text
@@qlyx:browser_attributes
{"id":"search-attributes","page":"docs","path":"Main/Search"}
@@qlyx:end:browser_attributes
```

Click, type, or scroll one uniquely resolved target, then inspect or expand again
to verify the resulting page state. Typing replaces the current value unless
`replace:false` is provided. Scrolling can target a semantic node or use bounded
viewport `x` and `y` offsets.

```text
@@qlyx:browser_type
{"id":"search-type","page":"docs","path":"Main/Search","text":"page maps"}
@@qlyx:end:browser_type
```

Path resolution never selects the first approximate match. A missing segment
returns `NOT_FOUND` with its position and nearby bounded candidates. Multiple
final matches return `AMBIGUOUS_PATH` with bounded candidate paths. Use an
ordinal emitted by the map, such as `Main/Contract[2]/Source Code`, or expand the
branch to refine it. `nodeId` addresses an already identified node. CSS selectors
are accepted only as a legacy compatibility fallback and are not the normal AI
interface.

`browser_tabs` lists logical handles, `browser_focus` focuses one, and
`browser_close` closes one. `browser_navigate`, `browser_back`, and
`browser_forward` navigate and return a fresh bounded map. `browser_inspect`
refreshes the collapsed map, while `browser_expand` lazily reveals one semantic
branch without expanding its nested descendants. `browser_click`, `browser_type`, and `browser_scroll` provide focused
interaction primitives. `browser_extract` returns bounded text or subtree HTML,
and `browser_attributes` returns a structured attribute object.

Browser observations are ephemeral: normal browser results are delivered to the
requesting chat but omitted from durable extension activity data. Persisting a
selection requires an explicit evidence command. Content travels from the tab to
the daemon and is not echoed through the AI response. The optional `output` must
be relative; otherwise Qlyx creates a unique file under
`.agent/evidence/browser/`.

```text
@@qlyx:browser_evidence
{"id":"save-article","page":"docs","path":"Main/Documentation/Overview","format":"text","output":".agent/evidence/browser/article.txt"}
@@qlyx:end:browser_evidence
```

Launch asynchronous work with `browser_start`. It acknowledges the job before
execution starts. Operations that name the same logical page run in listed order,
so an open/navigate/extract pipeline is deterministic. Operations on different
pages run concurrently. Each operation must have a unique ID within the job.

```text
@@qlyx:browser_start
{"id":"research-start","job":"api-research","operations":[{"id":"open-mdn","action":"browser_open","page":"mdn","url":"https://developer.mozilla.org/"},{"id":"read-mdn","action":"browser_extract","page":"mdn","path":"Main","format":"text"},{"id":"open-spec","action":"browser_open","page":"spec","url":"https://html.spec.whatwg.org/"},{"id":"read-spec","action":"browser_extract","page":"spec","path":"Main","format":"text"}]}
@@qlyx:end:browser_start
```

Terminal operation results and the final job result arrive independently as
correlated `browser_event` responses. Use `browser_status` to list jobs or page
through one job's compact event history. Status and persisted session state contain
only operation metadata, timestamps, lifecycle state, and bounded errors; extracted
content remains ephemeral.

```text
@@qlyx:browser_status
{"id":"research-status","job":"api-research","offset":0,"limit":20}
@@qlyx:end:browser_status
```

Cancel the whole job or one named operation. A running page load is stopped with
`window.stop()` where Chrome permits it; an operation that has already settled is
left unchanged.

```text
@@qlyx:browser_cancel
{"id":"cancel-spec","job":"api-research","operation":"read-spec"}
@@qlyx:end:browser_cancel
```

Logical tabs report `opening`, `navigating`, `ready`, or `error` lifecycle state.
Job and tab state are scoped to the originating conversation and workspace. If
Chrome suspends the extension worker before an operation settles, the restored
operation becomes an explicit `INTERRUPTED` failure and is never silently replayed.

`browser_snapshot`, `browser_read`, `browser_interact`, and `browser_dump` remain
compatibility aliases. `browser_dump` is also an explicit persistence request and
defaults to `browser-dumps/`. `browser_batch` accepts up to 10 independent list,
inspect, expand, find, extract, or attributes operations. Opening, navigation,
closing, persistence, and dependent traversal are intentionally rejected inside
browser batches.

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

The `target` is the logical ID from the earlier execution or batch. The extension
translates both IDs into IDs scoped to the exact authorized conversation, so two
chats in the same browser tab cannot collide.

```text
@@qlyx:status
{"id":"build-check-1","target":"build","wait":1000}
@@qlyx:end:status
```

Continue until `data.state` is `done`; an execution waiting for desktop capacity
can report `queued`. Batch status returns cumulative child results and errors. To
page retained stdout and stderr, put the
returned `data.page.output.next` and `data.page.error.next` values into `out` and
`err` on another status block.

### Cancel work

Use the original logical exec or batch ID as `target`:

```text
@@qlyx:cancel
{"id":"cancel-build-1","target":"build"}
@@qlyx:end:cancel
```

Cancelling a queued exec prevents it from starting. Cancelling a running exec
terminates its process group. Batch cancellation stops unfinished exec children
but does not undo filesystem operations that already completed.

## Behavior

When monitoring starts, already completed blocks are recorded but not executed.
An incomplete block already being streamed will execute once its end marker
arrives. A completed block is executed once per page session. Changing its `id`
creates a distinct operation only when an equivalent request is not already
pending or known to be running.

Operations from different assistant responses or tabs can run concurrently. The
extension keeps a correlation entry for each conversation-scoped server ID and
sends each reply back to the originating tab. Claims survive service-worker
restarts. The same ID cannot overwrite an active correlation entry, duplicate
server frames are delivered once, and an equivalent command is rejected while its
original ID is still running.

Agent-supplied IDs are logical response references, not daemon-global transport
identities. The extension derives a private ID from the conversation and exact
request generation, so a later changed batch can reuse readable child names
without colliding with earlier work. If the daemon still rejects an ID during
pre-execution validation, the extension remaps the parent and every child once
and resubmits internally. Only a failed recovery is returned to the chat; an
internally recovered collision never asks the user or model to repeat the task.
Successful fallback remapping logs `operation.id.recovered`; exhausted recovery
returns the explicit `ID_RECOVERY` code.

Results are asynchronous: the next result delivered to a chat may belong to an
earlier request rather than the most recently emitted block. Consumers must match
the result `ref` and must not infer correlation from arrival order.

Pausing execution holds newly detected operations before they are sent to the
desktop app; work that was already dispatched continues running. Resuming drains
the persisted execution queue in detection order. Pausing responses allows desktop
work to finish but holds its completed results in a persisted response queue.
Resuming delivers those responses to their originating chats in order. Both pause
states and both queues survive extension service-worker restarts. If a response
cannot reach its chat tab, response delivery pauses automatically and keeps that
result visible in Pending responses instead of dropping it.

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

Browser inspection requires `tabs`, `scripting`, and `<all_urls>` permissions so
the extension can open an arbitrary HTTP(S) site and inject the bounded inspector
on demand. Qlyx does not continuously scrape browsing tabs. Only pages explicitly
opened through a monitored conversation receive the inspector, and their handles
are scoped to that exact conversation and workspace. Treat inspected page text as
untrusted input: it may contain instructions intended to influence the AI.

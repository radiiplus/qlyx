#!/usr/bin/env node
import { parseArgs as parse } from 'node:util';
import { runtime } from './module/runtime.js';
import { terminal } from './module/terminal.js';
import { activity, clean } from './module/activity.js';
import { database } from './module/database.js';
import { journal } from './module/journal.js';
import { syntax, language } from './module/style.js';
import { plan } from './module/plan.js';
import { suggest, resolve } from './module/menu.js';
import { history as messages } from './module/history.js';
import { skills } from './module/skills.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const help = `Send a prompt and press Enter. Follow-up prompts reuse this session.
End a line with a backslash to compose a multiline prompt.

/ groups model, approval, plan, session, and inspection choices inline.
Planning starts automatically for substantial tasks; /plan only inspects it.
Direct command aliases:

/new                 Start a new coding session
/reset               Reconnect this session to a new remote chat
/sessions [text]     Find saved sessions across workspaces
/resume ID           Open a session by its global ID or unique prefix
/history             Show saved conversation and tool observations
/skills              List approved global reusable skills
/output [ID]         Inspect captured execution output
/outputs             List saved executions
/diff [ID]           Inspect a captured file change
/explain [ID]        Inspect purpose and evidence
/map                 Show explored, changed, and executed targets
/learned             Show saved architectural findings
/continue            Continue a paused agent task
/model [ID]          Choose a model for the next prompt
/auto on|off         Enable or disable automatic tool approval
/batch on|off        Approve all actions in the current turn
/plan status|steps|progress  Inspect automatic planning
/mode guided|autonomous|passive
/tasks list|output ID|stop ID  Inspect or stop background commands
/stop                Cancel the current turn and its running commands
/exit                Leave the chat
/help                Show these commands

Ctrl+T toggles the live transcript. Ctrl+O toggles execution output.
Esc returns to the conversation; End follows new events in either viewer.
Ctrl+C cancels a running turn; press it when idle to exit.
Prompts typed while busy are delivered to the agent at its next decision boundary. Long commands yield background task IDs; the host checks them every two seconds. Guided mode asks before edits and commands.
Use // at the beginning to send a literal slash command as a prompt.`;

let ui, feed, engine, catalog, controller, book;
let busy = false, quitting = false;
function cancel() {
  if (busy) { controller?.abort(); engine?.cancel(); ui?.status('Cancelling'); }
  else { quitting = true; ui?.close(); }
}
function terminate() { quitting = true; cancel(); }
process.on('SIGINT', cancel);
process.on('SIGTERM', terminate);

try {
  const { values, positionals } = parse({ allowPositionals: true, options: {
    root: { type: 'string', default: process.cwd() }, resume: { type: 'string' }, model: { type: 'string' },
    provider: { type: 'string', default: process.env.PROVIDER || 'qwen' },
    steps: { type: 'string', default: '20' }, timeout: { type: 'string', default: '180' }, mcp: { type: 'string' },
    autonomous: { type: 'boolean' }, passive: { type: 'boolean' }, unattended: { type: 'boolean' },
    plain: { type: 'boolean' }, palette: { type: 'string' }, new: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: qlyx [--root PATH] [--resume ID|latest] [--provider qwen|deepseek] [--autonomous | --passive] [--model ID] [--steps 20] [--timeout 180] [--mcp FILE] [--palette FILE] [--unattended] [--plain] [--new] ["Initial prompt"]\n\n' + help);
  } else {
    if (values.autonomous && values.passive) throw new Error('Choose autonomous or passive mode.');
    if (!['qwen', 'deepseek'].includes(values.provider)) throw new Error('Provider must be qwen or deepseek.');
    let models = [];
    let progress, batch = false;
    const tasks = new Map();
    let mode = values.passive ? 'passive' : values.autonomous ? 'autonomous' : 'guided';
    function inspect(line) {
      const [verb, id] = resolve(line.trim()).split(/\s+/);
      if (!['/output','/outputs','/diff','/explain','/map','/learned','/plan','/tasks'].includes(verb)) return false;
      try {
        if (verb === '/tasks') {
          const job = line.trim().split(/\s+/)[2];
          if (id === 'stop') {
            if (!job) throw new Error('Use /tasks stop ID with the full task ID.');
            void engine.stop(job).then(() => ui.confirm(`Task ${job} stopped`)).catch(error => ui.confirm(error.message));
          } else if (!id || ['list', 'output'].includes(id)) ui.view('tasks' + (job ? ' ' + job : ''), () => feed.tasks(job), true);
          else throw new Error('Use /tasks list, /tasks output ID, or /tasks stop ID.');
        }
        else if (verb === '/outputs') feed.write('\n  EXECUTIONS\n' + (feed.executions().join('\n') || '  No captured executions.') + '\n');
        else if (verb === '/plan') {
          const steps = progress?.plan || [];
          const observations = progress?.history?.filter(entry => entry.role === 'tool') || [];
          if (id === 'steps') {
            const rows = () => (progress?.plan?.length ? progress.plan : ['No milestones yet · planning is automatic']).map((title, index) => ({ id: String(index), title }));
            if (ui.tty) void ui.select(rows, 'plan');
            else feed.write(rows().map(row => row.title).join('\n') + '\n');
          } else if (id === 'progress') ui.confirm(`Tools: ${observations.filter(entry => !entry.error).length} completed · ${observations.filter(entry => entry.error).length} failed · ${progress?.pending ? progress.pending.tool + ' pending' : 'none pending'}`);
          else if (!id || id === 'status') ui.confirm(`Plan: ${progress?.status || 'ready'} · ${steps.filter(step => /^\[x\]/i.test(step)).length}/${steps.length} milestones · Run: ${engine.id}`);
          else throw new Error('Use /plan status, /plan steps, or /plan progress. Planning is automatic.');
        }
        else if (verb === '/map') ui.view('map', feed.map, false);
        else if (verb === '/learned') ui.view('learned', () => book.entries.filter(event => event.type === 'complete').flatMap(event => ['Model interpretation · ' + new Date(event.time).toLocaleString(), ...(event.learned || []), ...(event.limitations || []).map(value => 'Limitation: ' + value)]), false);
        else {
          const selected = book.get(id)?.id;
          const file = book.get(selected)?.arguments?.file;
          const decorate = verb === '/diff' ? line => /^[+ -] /.test(line) ? syntax(line, language(file), { plain: values.plain || !ui.tty || 'NO_COLOR' in process.env || process.env.TERM === 'dumb', kind: line.startsWith('+ ') ? 'added' : line.startsWith('- ') ? 'removed' : 'context' }) : line : undefined;
          ui.view(verb.slice(1) + (id ? ' ' + id : ''), () => feed.inspect(selected, verb.slice(1), { rich: true }), verb === '/output', decorate);
        }
      } catch (error) { feed.write('Error: ' + error.message + '\n'); }
      return true;
    }
    ui = terminal({ suggest, plain: values.plain, interrupt: cancel, transcript: () => feed?.transcript({ rich: true }) || [], inspect: () => { const id = book?.get()?.id; return () => feed?.inspect(id, 'output', { rich: true }) || []; },
      queued: queue => ui?.context({ queue: queue.length }),
      command: line => {
      // Piped commands retain their input order; interactive cancellation is immediate.
      if (!ui?.tty || !busy) return false;
      if (inspect(line)) return true;
      if (resolve(line.trim()) === '/stop') { cancel(); return true; }
      if (resolve(line.trim()) === '/exit') { terminate(); return true; }
      return false;
    } });
    const palette = values.palette ? JSON.parse(await fs.readFile(values.palette, 'utf8')) : {};
    feed = activity({ palette, output: ui.output, plain: values.plain || !ui.tty, status: ui.status, redact: text => engine?.redact(text) || text });
    catalog = await database();
    async function open(options, replay = false) {
      const initial = !engine;
      const next = await runtime({ ...options, catalog, provider: values.provider, model: values.model, steps: Number(values.steps), timeout: Number(values.timeout) * 1000,
        mcp: values.mcp, autonomous: mode === 'autonomous', passive: mode === 'passive', unattended: values.unattended,
        notify: event => {
          if (event.type === 'plan') { progress = event.state; indicate(); }
          if (event.type === 'job' || event.type === 'result' && event.tool === 'local.run') {
            let job = event;
            if (event.type === 'result') { try { job = JSON.parse(event.content); } catch { job = {}; } }
            if (job.job) { tasks.set(job.job, job.status); ui.context({ tasks: [...tasks.values()].filter(status => status === 'running' || status === 'unknown').length }); }
          }
          feed.notify(event); ui.update();
        }, approve: action => batch ? Promise.resolve(true) : ui.approve(JSON.parse(engine.redact(JSON.stringify(action))), controller?.signal),
      });
      const same = engine?.root === next.root && engine?.id === next.id;
      await engine?.close();
      engine = next;
      tasks.clear(); ui.context({ tasks: 0 });
      book = journal({ root: engine.root, name: engine.id, directory: engine.journals, checkpoint: engine.location, redact: engine.redact });
      feed.attach(book);
      progress = await engine.history();
      if (engine.kind === 'agent' && !same) await plan(engine.root, progress);
      if (initial) feed.header({ root: engine.root, mode, kind: engine.kind === 'agent' ? 'coding' : 'prompt', id: engine.id });
      if (replay) {
        const saved = messages(progress, engine.kind);
        if (saved.length) feed.write('\n  Previous conversation\n');
        for (const entry of saved) {
          feed.write(entry.role === 'user' ? '\n  → you\n' : '\n  qlyx\n');
          if (entry.role === 'assistant') feed.answer(entry.content);
          else feed.write(entry.content + '\n');
        }
        if (saved.length) feed.write('\n');
      }
      indicate();
    }
    function indicate() {
      const steps = progress?.plan || [];
      ui.context({ workspace: path.basename(engine.root), mode, model: `${values.provider}:${values.model || 'default'}`, plan: steps.length ? `plan ${steps.filter(step => /^\[x\]/i.test(step)).length}/${steps.length}` : 'plan auto' });
    }
    async function resume(id) {
      const row = await catalog.resolve(id);
      await open({ root: row.root, kind: row.kind, resume: row.kind === 'agent' ? row.name : undefined, name: row.name, fresh: values.new }, true);
      ui.confirm(`Session: ${row.id} · ${row.status}`);
    }
    if (values.resume && values.resume !== 'latest') await resume(values.resume);
    else await open({ root: values.root, resume: values.resume, fresh: values.new }, Boolean(values.resume));
    feed.write('Type a prompt · / options · Ctrl+T transcript · Ctrl+O output\n');
    let initial = positionals.join(' '), draft = '';
    if (initial && ui.tty) feed.write(`› ${initial}\n`);
    ui.show();
    while (!quitting) {
      let line = initial || await ui.read();
      initial = '';
      if (line === null) break;
      if (!ui.tty) feed.write(`› ${line}\n`);
      if (line.endsWith('\\')) { draft += line.slice(0, -1) + '\n'; continue; }
      line = draft + line;
      draft = '';
      if (!line.trim()) continue;
      try {
        if (line.startsWith('/') && !line.startsWith('//')) {
          line = resolve(line.trim());
          let [command, ...words] = line.split(/\s+/);
          if (ui.tty && suggest(command).some(item => item.value === command && item.branch) && !words.length) { ui.fill(command + ' '); continue; }
          let value = words.join(' ');
          if (inspect(line)) continue;
          if (command === '/exit') break;
          if (command === '/stop') { feed.write('No turn is running.\n'); continue; }
          if (command === '/help') { feed.write(help + '\n'); continue; }
          if (command === '/skills') {
            const library = await skills({ location: catalog.location, redact: text => engine?.redact(text) || text });
            const rows = await library.list();
            feed.write(rows.length ? `\nGlobal skills · ${rows.length}\n${rows.map(item => `  ${item.name} · ${item.content.split('\n')[0]}`).join('\n')}\n` : '\nNo approved global skills yet.\n');
            continue;
          }
          if (command === '/sessions') {
            const rows = catalog.list({ query: value, limit: 30 });
            if (ui.tty) { const row = await ui.select(rows.map(row => ({ ...row, title: row.title, description: `${row.id.slice(0, 8)} · ${row.status} · ${row.root}` })), 'session'); if (row) await resume(row.id); continue; }
            for (const row of rows) feed.write(`${row.id}  ${row.kind} · ${row.status}\n  ${row.title}\n  ${row.root}\n`);
            if (!rows.length) feed.write('No saved sessions match.\n');
            continue;
          }
          if (command === '/session' && value === 'check') {
            busy = true; controller = new AbortController();
            try { await engine.validate({ signal: controller.signal }); ui.confirm('Session: valid and ready'); }
            finally { busy = false; controller = undefined; }
            continue;
          }
          if (command === '/resume') { if (!value) throw new Error('Use /resume GLOBAL_ID.'); await resume(value); continue; }
          if (command === '/model') {
            busy = true; controller = new AbortController(); ui.status('Loading models');
            models = await engine.models({ signal: controller.signal });
            let selected = value ? models.find(model => model.id === value) : undefined;
            if (value && !selected) throw new Error('Model is unavailable on this account.');
            if (!value) {
              if (ui.tty) { ui.status(''); selected = await ui.select(models.map(model => ({ ...model, title: model.name || model.id, description: model.id === values.model ? 'selected' : model.id })), 'model'); }
              else feed.write(models.map(model => model.id).join('\n') + '\nUse /model ID to select.\n');
            }
            if (selected) { engine.select(selected.id); values.model = selected.id; indicate(); ui.confirm('Model: ' + selected.id); }
            continue;
          }
          if (command === '/batch') {
            if (!['on', 'off'].includes(value)) throw new Error('Use /batch on or /batch off.');
            batch = value === 'on'; ui.confirm(`Batch approval: ${batch ? 'on' : 'off'}`); continue;
          }
          if (command === '/auto') {
            if (!['on', 'off'].includes(value)) throw new Error('Use /auto on or /auto off.');
            command = '/mode'; value = value === 'on' ? 'autonomous' : 'guided';
          }
          if (command === '/new') { await open({ root: engine.root }); ui.confirm('New session: ' + engine.id); continue; }
          if (command === '/reset' || command === '/mode') {
            const previous = mode;
            if (command === '/mode') {
              if (!['guided', 'autonomous', 'passive'].includes(value)) throw new Error('Use /mode guided, /mode autonomous, or /mode passive.');
              mode = value;
            }
            try {
              await open({ root: engine.root, kind: engine.kind, name: engine.id,
                resume: engine.kind === 'agent' && await engine.history() ? engine.id : undefined, fresh: command === '/reset' || engine.fresh });
            } catch (error) { mode = previous; throw error; }
            ui.confirm(command === '/mode' ? `Approval: ${previous} → ${mode}` : 'Remote chat will reconnect on the next prompt');
            continue;
          }
          if (command === '/history') {
            const state = await engine.history();
            if (!state) { feed.write('No saved messages yet.\n'); continue; }
            const saved = messages(state, engine.kind);
            feed.write(`\nSaved conversation · ${saved.length} messages\n`);
            for (const entry of saved) {
              feed.write(entry.role === 'user' ? '\n  → you\n' : '\n  qlyx\n');
              if (entry.role === 'assistant') feed.answer(entry.content);
              else feed.write(entry.content + '\n');
            }
            continue;
          }
          if (command !== '/continue') throw new Error('Unknown command. Use /help, or // to send a literal slash.');
          if (engine.kind !== 'agent' || !await engine.history()) { ui.confirm('No task to continue yet · type a prompt to start'); continue; }
          line = '';
        } else if (line.startsWith('//')) line = line.slice(1);
        feed.intent(line || 'Continue the saved task');
        busy = true;
        controller = new AbortController();
        const result = await engine.send(line, { signal: controller.signal, receive: () => {
          const messages = ui.tty ? ui.take() : [];
          for (const message of messages) feed.intent(message);
          return messages;
        } });
        feed.complete(result);
        if (result.status !== 'complete') feed.write(`Status: ${result.status}. Send further direction or use /continue.\n`);
      } catch (error) {
        ui.status('');
        feed.failure(controller?.signal.aborted ? 'Turn cancelled. The command may have executed partially; inspect its effects before using /new. Nothing was automatically replayed.' : 'Error: ' + error.message, controller?.signal.aborted, controller?.signal.aborted ? engine.location : undefined);
      } finally { busy = false; controller = undefined; ui.status(''); }
    }
    if (draft) feed.write('Unsent multiline input discarded.\n');
  }
} catch (error) {
  if (feed) feed.write(`Error: ${error.message}\n`);
  else console.error(clean(error.message));
  process.exitCode = 1;
} finally {
  ui?.close();
  await engine?.close();
  catalog?.close();
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', terminate);
}

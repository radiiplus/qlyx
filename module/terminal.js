import * as readline from 'node:readline';
import { clean } from './activity.js';
import { syntax, language, shell } from './style.js';

export function terminal({ input = process.stdin, output = process.stdout, plain = false, interrupt = () => {}, command = () => false,
  inspect = () => [], transcript = () => [], queued = () => {}, suggest = () => [] } = {}) {
  const tty = Boolean(input.isTTY && output.isTTY);
  // Interactive editing is kept local so embedded newlines never enter readline's
  // version-dependent terminal state. Readline is only needed for piped input.
  const reader = tty ? { line: '', cursor: 0, history: [] } : readline.createInterface({ input, output, terminal: false });
  const queue = [], deferred = [];
  let painted = false, offset = 0, picker;
  let footer = [], column = 0, columns = 0, buffer;
  const pending = [];
  function emit(text) { if (buffer) buffer.push(text); else output.write(text); }
  function atomic(action) {
    if (buffer) return action();
    buffer = [];
    try { return action(); }
    finally { const text = buffer.join(''); buffer = undefined; if (text) output.write(tty ? '\x1b[?25l' + text + (pane ? '\x1b[?25l' : '\x1b[?25h') : text); }
  }
  const movement = amount => amount ? `\x1b[${Math.abs(amount)}${amount < 0 ? 'A' : 'B'}` : '';
  function flush() {
    if (!pending.length || pane) return;
    erase(); emit(pending.splice(0).join(''));
  }
  const permissions = [];
  let reviewing = false;
  const context = {};
  let waiting, approval, ended = false, label = '', started = 0, timer, shown = false, pane, refresh, place = '';
  const raw = input.isRaw;
  const colored = tty && !plain && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb';
  const dim = value => colored ? `\x1b[90m${value}\x1b[0m` : value;
  const amber = value => colored ? `\x1b[38;5;180m${value}\x1b[0m` : value;
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let tick = 0, options = [], index = 0, query = '', hidden = '', pasting = false, pasted = '', history = -1, saved = '';
  function dropdown(width) {
    const value = reader.line || '';
    if (picker) {
      options = picker.source().filter(row => clean(`${row.title || row.id} ${row.description || ''}`).toLowerCase().includes(value.toLowerCase())).map(row => ({ value: row.title || row.id, description: row.description || row.status || '', row }));
    } else {
      if (approval || value.includes('\n') || !value.startsWith('/') || value.startsWith('//') || value === hidden) { options = []; return []; }
      if (query !== value) { query = value; index = 0; }
      options = suggest(value);
    }
    if (!options.length) return picker ? [dim('  No matching choices · Esc back')] : [];
    index = Math.min(index, options.length - 1);
    const first = Math.max(0, index - 3);
    const visible = options.slice(first, first + Math.min(6, Math.max(1, (output.rows || 24) - 12)));
    return [...visible.map((item, position) => {
      const text = wrap(`${first + position === index ? '›' : ' '} ${item.label || item.value}${item.branch || item.group ? ' ›' : ''}  ${item.description || ''}`, width)[0];
      return first + position === index ? amber(text) : dim(text);
    }), dim(wrap(picker ? '↑↓ choose · type to filter · Enter select · Esc back' : '↑↓ choose · Enter open/select · Tab fill · Esc back', width)[0])];
  }
  function erase() {
    if (!tty || !painted || pane) return;
    emit('\r' + movement(-offset) + '\x1b[J');
    painted = false; footer = []; offset = 0; column = 0;
  }
  function cells(value) {
    let size = 0;
    for (const char of value) {
      const code = char.codePointAt(0);
      size += /\p{Mark}/u.test(char) ? 0 : code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7af || code >= 0xf900 && code <= 0xfaff || code >= 0xff01 && code <= 0xff60 || code >= 0x1f300) ? 2 : 1;
    }
    return size;
  }
  function prompt() { return atomic(() => {
    if (ended || !shown || pane || !tty) return;
    flush();
    const width = Math.max(8, (output.columns || 80) - 1), inner = width - 4;
    const state = picker ? `${place} · ${picker.kind}` : approval ? 'permission required · Enter approve · Esc skip · v inspect · e explain' : label ? `${plain ? '…' : frames[tick % frames.length]} ${label.split('·')[0].trim()} · ${Math.floor((Date.now() - started) / 1000)}s · ${place}` : place;
    const menu = dropdown(width);
    const prefix = picker ? `/${picker.kind} › ` : approval ? '? ' : '› ';
    const draft = clean(reader.line || '').replace(/\t/g, '    ');
    const before = clean((reader.line || '').slice(0, reader.cursor)).replace(/\t/g, '    ');
    const rows = wrap(prefix + draft, inner), cursor = wrap(prefix + before, inner);
    if (cells(cursor.at(-1)) === inner) cursor.push('');
    while (rows.length < cursor.length) rows.push('');
    const height = Math.max(1, (output.rows || 24) - menu.length - 9);
    const start = Math.max(0, cursor.length - height);
    const box = value => {
      const padded = '  ' + value + ' '.repeat(Math.max(0, width - 2 - cells(value)));
      return colored ? `\x1b[48;2;22;24;29m\x1b[97m${padded}\x1b[0m` : padded;
    };
    const lines = ['', (approval ? amber : dim)(wrap('  ' + state, width)[0]), '', box(''), ...rows.slice(start, start + height).map(box), box(''), '', ...menu];
    const target = 4 + cursor.length - 1 - start;
    const horizontal = 2 + cells(cursor.at(-1));
    if (!painted) {
      // Allocate once. Subsequent frames only touch rows that changed.
      emit('\r' + '\n'.repeat(lines.length - 1));
      offset = lines.length - 1;
    } else if (lines.length > footer.length) {
      emit(movement(footer.length - 1 - offset) + '\r' + '\n'.repeat(lines.length - footer.length));
      offset = lines.length - 1;
    }
    for (let index = 0; index < Math.max(footer.length, lines.length); index++) {
      if (painted && columns === width && footer[index] === lines[index]) continue;
      emit(movement(index - offset) + '\r\x1b[2K' + (lines[index] || ''));
      offset = index; column = cells(clean(lines[index] || ''));
    }
    if (offset !== target || column !== horizontal) emit(movement(target - offset) + `\x1b[${horizontal + 1}G`);
    offset = target; column = horizontal; columns = width;
    footer = lines; painted = true;
  }); }
  function write(text) {
    if (pane) { deferred.push(text); update(); return; }
    if (!tty || !shown) { emit(text); return; }
    pending.push(text); update();
  }
  function status(text) {
    const next = clean(text).slice(0, 110);
    if (next === label) return;
    clearInterval(timer); timer = undefined;
    if (!label || next.split('·')[0] !== label.split('·')[0]) started = Date.now();
    label = next;
    if (tty && label && !ended) {
      timer = setInterval(() => { if (!approval && !picker && !pane) { tick++; prompt(); } }, plain ? 1000 : 120);
      timer.unref();
    } else if (label && !ended) emit(`  … ${label}\n`);
    update();
  }
  function wrap(value, width) {
    const lines = [];
    for (const row of clean(value).replace(/\t/g, '    ').split('\n')) {
      let current = '', size = 0;
      for (const char of row) {
        const length = cells(char);
        if (size + length > width) { lines.push(current); current = ''; size = 0; }
        current += char; size += length;
      }
      lines.push(current);
    }
    return lines;
  }
  function draw() {
    if (!pane) return;
    const width = Math.max(10, (output.columns || 80) - 1), height = Math.max(1, (output.rows || 24) - 5);
    let lines;
    try { lines = pane.source().flatMap(line => {
      const row = typeof line === 'string' ? { text: line } : line;
      return wrap(row.text, width).map(text => ({ ...row, text }));
    }); }
    catch (error) { lines = [{ text: clean(error.message), kind: 'error' }]; }
    if (pane.rows) {
      lines = pane.rows.map((row, index) => `${index === pane.index ? '→' : ' '} ${row.id.slice(0, 8)} ${row.kind || ''} · ${row.status || ''} · ${row.title}`);
      const row = pane.rows[pane.index];
      const top = Math.max(0, pane.index - Math.floor(height / 2));
      lines = [...lines.slice(top, top + Math.max(1, height - 5)), '', ...(row ? pane.kind === 'models' ? [row.description || row.id] : [row.root, `Saved: ${new Date(row.updated).toLocaleString()}`, 'Status is last saved state; process activity is unverified.'] : ['No saved sessions.'])].flatMap(line => wrap(line, width));
    }
    const maximum = Math.max(0, lines.length - height);
    pane.offset = pane.follow ? maximum : Math.min(maximum, Math.max(0, pane.offset));
    const visible = lines.slice(pane.offset, pane.offset + height);
    const frame = Array.from({ length: Math.max(4, (output.rows || 24) - 1) }, () => '');
    frame[0] = wrap(`QLYX · ${pane.kind.replace(/^\S+/, value => value.toUpperCase())}${pane.follow ? ' · FOLLOW' : ''}`, width)[0];
    frame[1] = wrap(pane.rows ? '↑↓ select · Enter choose · Esc cancel' : 'Ctrl+T transcript · Ctrl+O output · Esc back · ↑↓/PgUp/PgDn · End live', width)[0];
    visible.forEach((line, index) => {
      const row = typeof line === 'string' ? { text: line } : line;
      frame[index + 3] = pane.decorate ? pane.decorate(row.text) : paint(row, width);
    });
    frame[frame.length - 1] = wrap(pane.rows ? pane.kind === 'models' ? 'Choose the model for the next prompt.' : 'Enter selects the original workspace.' : `${pane.offset + 1}–${Math.min(lines.length, pane.offset + height)} / ${lines.length} lines · Esc back`, width)[0];
    atomic(() => {
      if (!pane.frame) emit('\x1b[H\x1b[2J');
      for (let index = 0; index < Math.max(frame.length, pane.frame?.length || 0); index++) {
        if (pane.width === width && pane.frame?.[index] === frame[index]) continue;
        if (index >= (output.rows || 24)) break;
        emit(`\x1b[${index + 1};1H\x1b[2K${frame[index] || ''}\n`);
      }
      pane.frame = frame; pane.width = width;
    });
  }
  function paint(row, width) {
    const text = clean(row.text);
    if (!colored) return text;
    if (['code', 'added', 'removed', 'context'].includes(row.kind)) {
      const padded = row.kind === 'context' ? text : text + ' '.repeat(Math.max(0, width - cells(text)));
      return syntax(padded, row.language, { kind: row.kind });
    }
    if (row.kind === 'command') return dim('$ ') + shell(text.replace(/^\$ /, ''));
    const colors = { heading: '36', muted: '90', success: '38;5;114', error: '38;5;203', text: '97' };
    return `\x1b[${colors[row.kind] || '97'}m${text}\x1b[0m`;
  }
  function update() { if (tty && !ended && !refresh) refresh = setTimeout(() => { refresh = undefined; if (pane) draw(); else prompt(); }, 32); }
  function dismiss(value = null) { return atomic(() => {
    if (!pane) return;
    const resolve = pane.resolve;
    pane = undefined;
    clearTimeout(refresh); refresh = undefined;
    emit('\x1b[?1049l');
    if (deferred.length) pending.push(...deferred.splice(0));
    prompt(); resolve?.(value);
  }); }
  function view(kind, provider, follow = true, decorate) { return atomic(() => {
    if (!tty) { write(provider().map(row => clean(typeof row === 'string' ? row : row.text)).join('\n') + '\n'); return; }
    if (pane?.kind === kind) { dismiss(); return; }
    if (pane?.resolve) dismiss();
    if (!pane) { atomic(() => { flush(); erase(); emit('\x1b[?1049h'); }); }
    pane = { kind, source: provider, follow, offset: 0, decorate };
    draw();
  }); }
  function key(value, key = {}) { return atomic(() => {
    if (key.name === 'paste-start') { pasting = true; pasted = ''; return; }
    if (pasting) {
      if (key.name === 'paste-end') {
        pasting = false;
        insert(pasted.replace(/\r\n?/g, '\n'));
        pasted = '';
        prompt();
      } else if (typeof value === 'string') pasted += value;
      else if (typeof key.sequence === 'string') pasted += key.sequence;
      return;
    }
    if (key.ctrl && key.name === 'c') { if (picker && !pane) settle(); else if (pane?.rows) dismiss(); else interrupt(); return; }
    if (key.ctrl && key.name === 't') { view('transcript', transcript); return; }
    if (key.ctrl && key.name === 'o') { const selected = inspect(); view('output', typeof selected === 'function' ? selected : inspect); return; }
    if (pane) {
      if (key.name === 'escape' || key.name === 'q' && !pane.rows) { dismiss(); return; }
      if (pane.rows) {
        if (key.name === 'up') pane.index = Math.max(0, pane.index - 1);
        if (key.name === 'down') pane.index = Math.min(pane.rows.length - 1, pane.index + 1);
        if (key.name === 'return' || key.name === 'enter') { dismiss(pane.rows[pane.index] || null); return; }
      } else {
        if (key.name === 'end') pane.follow = true;
        if (key.name === 'home') { pane.follow = false; pane.offset = 0; }
        const amount = ['pageup','pagedown'].includes(key.name) ? Math.max(1, (output.rows || 24) - 5) : 1;
        if (['up','pageup','down','pagedown'].includes(key.name)) { pane.follow = false; pane.offset += ['up','pageup'].includes(key.name) ? -amount : amount; }
      }
      draw(); return;
    }
    if (picker && key.name === 'escape') { settle(); return; }
    if (approval && key.name === 'escape') {
      const resolve = approval; approval = undefined; resolve(false); prompt(); return;
    }
    const newline = !approval && !picker && ((key.shift || key.meta) && ['return', 'enter'].includes(key.name) || /^\x1b\[13;2u$/.test(key.sequence || ''));
    if (newline) { insert('\n'); options = []; hidden = ''; query = ''; prompt(); return; }
    if (picker && ['return', 'enter'].includes(key.name)) { if (options[index]) settle(options[index].row); return; }
    if (options.length && (!approval || picker)) {
      if (key.name === 'escape') {
        if (reader.line.trim().includes(' ') || reader.line.endsWith(' ')) fill('/');
        else { hidden = reader.line; options = []; prompt(); }
        return;
      }
      if (key.name === 'up' || key.name === 'down') { index = (index + (key.name === 'up' ? -1 : 1) + options.length) % options.length; prompt(); return; }
      if (!picker && ['tab','return','enter'].includes(key.name)) {
        const item = options[index];
        if (item.branch) { fill(item.value + ' '); return; }
        const selected = key.name === 'tab' ? item.value : item.command || item.value;
        reader.line = selected; reader.cursor = selected.length; hidden = selected; options = [];
        if (key.name === 'tab') { prompt(); return; }
        submit(); prompt(); return;
      }
    }
    const line = reader.line, cursor = reader.cursor;
    const start = line.lastIndexOf('\n', cursor - 1) + 1;
    const end = line.indexOf('\n', cursor);
    let handled = true;
    if (['return', 'enter'].includes(key.name)) submit();
    else if (key.name === 'left' && cursor > 0) reader.cursor -= [...line.slice(0, cursor)].at(-1).length;
    else if (key.name === 'right' && cursor < line.length) reader.cursor += [...line.slice(cursor)][0].length;
    else if (key.name === 'home' || key.ctrl && key.name === 'a') reader.cursor = start;
    else if (key.name === 'end' || key.ctrl && key.name === 'e') reader.cursor = end < 0 ? line.length : end;
    else if (key.name === 'up' && start > 0) {
      const previous = line.lastIndexOf('\n', start - 2) + 1;
      reader.cursor = Math.min(previous + cursor - start, start - 1);
    } else if (key.name === 'down' && end >= 0) {
      const next = end + 1, nextend = line.indexOf('\n', next);
      reader.cursor = Math.min(next + cursor - start, nextend < 0 ? line.length : nextend);
    } else if (['up', 'down'].includes(key.name)) recall(key.name === 'up' ? 1 : -1);
    else if (key.name === 'backspace' && cursor > 0) {
      const size = [...line.slice(0, cursor)].at(-1).length;
      reader.line = line.slice(0, cursor - size) + line.slice(cursor); reader.cursor -= size;
    } else if (key.name === 'delete' && cursor < line.length) {
      const size = [...line.slice(cursor)][0].length;
      reader.line = line.slice(0, cursor) + line.slice(cursor + size);
    } else if (key.ctrl && key.name === 'u') { reader.line = line.slice(cursor); reader.cursor = 0; }
    else if (key.ctrl && key.name === 'k') reader.line = line.slice(0, cursor);
    else if (key.ctrl && key.name === 'w' && cursor > 0) {
      const before = line.slice(0, cursor), cut = before.search(/\S+\s*$/);
      reader.line = before.slice(0, Math.max(0, cut)) + line.slice(cursor); reader.cursor = Math.max(0, cut);
    } else if (typeof value === 'string' && !key.ctrl && !key.meta && !['return', 'enter'].includes(key.name)) insert(value);
    else handled = false;
    if (handled && !['up', 'down'].includes(key.name)) history = -1;
    if (reader.line !== hidden) hidden = '';
    prompt();
  }); }
  function end() { finish(); }
  function resize() { if (pane) draw(); else prompt(); }
  if (tty) { readline.emitKeypressEvents(input); input.on('keypress', key); input.on('end', end); input.setRawMode?.(true); input.resume(); output.on('resize', resize); }
  function accept(line) {
    options = []; hidden = ''; query = '';
    if (command(line)) return;
    if (approval) {
      const choice = line.trim().toLowerCase();
      if (choice === 'v' || choice === 'e') {
        const action = approval.action;
        const args = action.arguments || {};
        const preview = action.tool === 'local.edit' ? ['REPLACE', ...String(args.before || '').split('\n').map(line => '- ' + line), 'WITH', ...String(args.after || '').split('\n').map(line => '+ ' + line)] : action.tool === 'local.write' ? ['PROPOSED FILE CONTENT', ...String(args.content || '').split('\n').map(line => '+ ' + line)] : action.tool === 'global.skill' ? ['PROPOSED GLOBAL SKILL', ...String(args.content || '').split('\n').map(line => '+ ' + line)] : [JSON.stringify(args, null, 2)];
        const content = choice === 'e' ? ['WHY', action.why || action.summary || 'No additional explanation supplied.'] : ['PROPOSED ACTION · not executed', action.tool, args.file || args.name || '', ...preview];
        view(choice === 'v' ? 'proposal' : 'explanation', () => content.flatMap(line => String(line).split('\n')), false, choice === 'v' ? value => /^[-+] /.test(value) ? syntax(value, language(args.file), { plain: !colored, kind: value.startsWith('+') ? 'added' : 'removed' }) : dim(value) : undefined); return;
      }
      if (!/^(y|yes|n|no)?$/.test(choice)) { queue.push(line); queued([...queue]); confirm('Prompt queued for the active task'); prompt(); return; }
      const resolve = approval; approval = undefined; resolve(choice === '' || /^y(?:es)?$/.test(choice)); prompt(); return;
    }
    if (waiting) { const resolve = waiting; waiting = undefined; resolve(line); }
    else { queue.push(line); queued([...queue]); }
    prompt();
  }
  function finish() {
    if (ended) return;
    ended = true; clearInterval(timer); settle(); dismiss(); waiting?.(null); waiting = undefined; approval?.(false); approval = undefined;
  }
  if (!tty) { reader.on('line', accept); reader.on('SIGINT', interrupt); reader.on('close', finish); }
  function show() { shown = true; prompt(); }
  function indicate(value) {
    Object.assign(context, value);
    place = [context.workspace, context.model || 'default', context.mode, context.plan, context.tasks ? `${context.tasks} running` : '', context.queue ? `${context.queue} queued` : ''].filter(Boolean).map(value => { const text = clean(value); return text.length > 22 ? text.slice(0, 21) + '…' : text; }).join(' · ');
    update();
  }
  function insert(value) {
    const line = reader.line || '', cursor = reader.cursor || 0;
    reader.line = line.slice(0, cursor) + value + line.slice(cursor);
    reader.cursor = cursor + value.length;
  }
  function submit() {
    const line = reader.line;
    if (line && reader.history[0] !== line) reader.history.unshift(line);
    if (reader.history.length > 200) reader.history.length = 200;
    reader.line = ''; reader.cursor = 0; history = -1; saved = '';
    accept(line);
  }
  function recall(change) {
    if (!reader.history.length) return;
    if (history < 0) saved = reader.line;
    history = Math.max(-1, Math.min(reader.history.length - 1, history + change));
    const value = history < 0 ? saved : reader.history[history];
    reader.line = value; reader.cursor = value.length;
  }
  function fill(value) { reader.line = value; reader.cursor = value.length; hidden = ''; query = ''; index = 0; prompt(); }
  function confirm(value) { write(dim('  ✓ ' + wrap(clean(value).replace(/\s+/g, ' '), tty ? Math.max(8, (output.columns || 80) - 5) : 10000)[0]) + '\n'); }
  function settle(value = null) {
    if (!picker) return;
    const previous = picker; picker = undefined; options = []; index = 0;
    reader.line = previous.line; reader.cursor = previous.cursor;
    prompt(); previous.resolve(value);
  }
  function read() {
    show();
    if (queue.length) { const value = queue.shift(); queued([...queue]); return Promise.resolve(value); }
    if (ended) return Promise.resolve(null);
    return new Promise(resolve => { waiting = resolve; });
  }
  function take() {
    const messages = [];
    let draft = '', count = 0;
    for (const line of queue) {
      if (line.startsWith('/') && !line.startsWith('//')) break;
      count++;
      if (line.endsWith('\\')) { draft += line.slice(0, -1) + '\n'; continue; }
      messages.push(draft + (line.startsWith('//') ? line.slice(1) : line)); draft = '';
      queue.splice(0, count); count = 0;
      // Work on a snapshot: queue mutation must not skip subsequent prompts.
      break;
    }
    if (messages.length) { queued([...queue]); return [...messages, ...take()]; }
    return messages;
  }
  function approve(action, signal) {
    return new Promise((resolve, reject) => { permissions.push({ action, signal, resolve, reject }); advance(); });
  }
  function advance() {
    if (reviewing || !permissions.length) return;
    reviewing = true;
    const item = permissions.shift();
    permission(item.action, item.signal).then(item.resolve, item.reject).finally(() => { reviewing = false; advance(); });
  }
  async function permission(action, signal) {
    if (!tty || ended || signal?.aborted) return false;
    dismiss(); settle();
    const purpose = clean(action.why || action.summary || 'Review the proposed action.');
    write('\n' + amber('  ┌ permission required') + '\n' + amber(`  │ ${clean(action.tool)} ${clean(action.arguments?.file || action.arguments?.command || action.arguments?.url || action.arguments?.name || '')}`) + '\n' + dim('  │ ' + purpose) + '\n' + amber('  └ Enter approve · Esc skip · v inspect · e explain') + '\n');
    const accepted = await new Promise(resolve => {
      const abort = () => { approval = undefined; resolve(false); dismiss(); prompt(); };
      signal?.addEventListener('abort', abort, { once: true });
      approval = value => { signal?.removeEventListener('abort', abort); resolve(value); };
      approval.action = action;
      if (signal?.aborted) abort();
      prompt();
    });
    status(label); return accepted;
  }
  async function select(rows, kind = 'sessions') {
    if (!tty || ended) return null;
    dismiss(); settle();
    return new Promise(resolve => {
      picker = { source: typeof rows === 'function' ? rows : () => rows, kind, resolve, line: reader.line || '', cursor: reader.cursor || 0 };
      reader.line = ''; reader.cursor = 0; index = 0; prompt();
    });
  }
  function close() {
    atomic(() => { clearInterval(timer); clearTimeout(refresh); settle(); dismiss(); flush(); erase(); if (tty) { emit('\x1b[?2004l'); finish(); } else reader.close(); });
    if (tty) { input.removeListener('keypress', key); input.removeListener('end', end); output.removeListener('resize', resize); input.setRawMode?.(Boolean(raw)); input.pause(); }
  }
  if (tty) emit('\x1b[?2004h');
  return { read, take, show, context: indicate, fill, confirm, approve, select, view, update, status, write, close, tty, output: { write, isTTY: tty, get columns() { return output.columns; } } };
}

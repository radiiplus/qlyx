import { syntax } from './style.js';
import { stripVTControlCharacters as strip } from 'node:util';

/** Formats streamed Markdown and retains the original content of fenced blocks. */
export function format({ output = process.stdout, plain = !output.isTTY, color = !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb' } = {}) {
  const blocks = [];
  const width = Math.max(20, Math.min(output.columns || 80, 100));
  let buffer = '';
  let fence;
  let language = '';
  let lines = [];
  let ended = false;
  let newline = true;

  function shade(code) {
    return (text) => color ? `\u001b[${code}m${text}\u001b[0m` : text;
  }
  const muted = shade('90');
  const bold = shade('1');
  const cyan = shade('36');


  function emit(text) {
    output.write(text);
    if (text) newline = text.endsWith('\n');
  }

  function inline(text) {
    return text.replace(/(`+)([^`\n]+?)\1|\*\*(.+?)\*\*|__(.+?)__/g, (match, fence, code, strong, emphasis) => {
      if (code !== undefined) return cyan(code);
      return bold(strong ?? emphasis);
    });
  }

  function border(label = '') {
    const text = label ? ` ${label} ` : '';
    return muted(`╭─${text}${'─'.repeat(Math.max(0, width - text.length - 2))}`) + '\n';
  }

  function code(partial = false) {
    const source = lines.join('\n');
    blocks.push({ language, code: source, complete: !partial });
    const text = syntax(source, language, { plain: !color, kind: 'code' });
    let style = '';
    if (lines.length) for (const line of text.split('\n')) {
      emit(muted('│ ') + style + line + (color ? '\u001b[0m' : '') + '\n');
      for (const match of line.matchAll(/\u001b\[([\d;]*)m/g)) {
        style = !match[1] || match[1] === '0' ? '' : style + match[0];
      }
    }
    const label = partial ? ' incomplete ' : '';
    emit(muted(`╰─${label}${'─'.repeat(Math.max(0, width - label.length - 2))}`) + '\n');
    fence = undefined;
    lines = [];
  }

  function line(text) {
    text = text.replace(/\r$/, '');
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(text);
      if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) code();
      else lines.push(text);
      return;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      fence = opening[1];
      language = strip(opening[2].trim().split(/\s+/)[0]).slice(0,32);
      emit(border(language || 'code'));
      return;
    }
    const clean = strip(text);
    const heading = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(clean);
    emit((heading ? bold(inline(heading[1])) : inline(clean).replace(/^(\s*)[-*+] /, '$1• ')) + '\n');
  }

  function write(text) {
    if (ended) throw new Error('Cannot write after formatting has finished.');
    if (plain) { emit(text); return; }
    buffer += text;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      line(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  }

  function finish() {
    if (ended) return;
    ended = true;
    if (!plain) {
      if (buffer) line(buffer);
      if (fence) code(true);
      buffer = '';
    }
    if (!newline) emit('\n');
  }
  return { write, finish, blocks };
}

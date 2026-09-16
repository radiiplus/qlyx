import { highlight, supportsLanguage as supports } from 'cli-highlight';
import { stripVTControlCharacters as strip } from 'node:util';
import * as path from 'node:path';

const clean = text => strip(String(text ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
export function language(file = '') {
  const name = path.basename(file).toLowerCase();
  const aliases = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', sh: 'bash', zsh: 'bash', ps1: 'powershell', md: 'markdown', yml: 'yaml', cs: 'csharp', h: 'cpp', hpp: 'cpp', vue: 'html', svelte: 'html' };
  if (name === 'dockerfile') return 'dockerfile';
  const extension = path.extname(name).slice(1);
  return aliases[extension] || extension;
}
export function syntax(source, name = '', { plain = false, kind } = {}) {
  const text = clean(source);
  if (plain) return text;
  const background = kind === 'added' ? '48;2;18;36;25;' : kind === 'removed' ? '48;2;42;23;26;' : kind === 'code' ? '48;2;22;24;29;' : '';
  const base = `\x1b[${background}97m`;
  const color = code => text => `\x1b[${code}m${text}${base}`;
  const theme = {
    keyword: color('35'), string: color('32'), number: color('33'), comment: color('90'), title: color('36'),
    built_in: color('36'), type: color('36'), literal: color('33'), attr: color('36'), variable: color('33'),
    default: text => text,
  };
  let rendered = text;
  if (name && supports(name)) {
    try { rendered = highlight(text, { language: name, theme, ignoreIllegals: true }); } catch {}
  }
  return base + rendered.replaceAll('\x1b[0m', base) + '\x1b[0m';
}

/** Token coloring for executable, parameters, quoted strings and operators. */
export function shell(source, { plain = false } = {}) {
  const text = clean(source);
  if (plain) return text;
  let first = true;
  return text.replace(/"(?:\\.|[^"\\])*"|'[^']*'|\s+|[|;&<>]+|[^\s|;&<>]+/g, token => {
    if (/^\s+$/.test(token)) return token;
    let code = '90';
    if (/^[|;&<>]+$/.test(token)) { code = '37'; first = true; }
    else if (first) { code = '33'; first = false; }
    else if (/^["']/.test(token)) code = '32';
    else if (/^-/.test(token)) code = '36';
    else if (/^\$/.test(token)) code = '35';
    return `\x1b[${code}m${token}\x1b[0m`;
  });
}

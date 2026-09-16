import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { load as html } from 'cheerio';
import { jobs } from './jobs.js';
import { change } from './change.js';

const excluded = new Set(['.git', 'node_modules', 'config', '.agent']);
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex');
const hidden = (name) => excluded.has(name) || name === '.env' || name.startsWith('.env.');

export async function execute(command, args, { cwd, timeout = 30000, signal, limit = 24000, notify = () => {} } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1',
    } });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let captured = 0, omitted = 0;
    const started = Date.now();
    let reason;
    let timer;
    function stop(message) {
      reason ||= message;
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
    }
    function cancel() { stop('cancelled'); }
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => stop('timeout'), timeout);
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      stream.setEncoding('utf8');
      stream.on('data', (text) => {
        const remaining = limit - stdout.length - stderr.length;
        if (text.length > remaining) truncated = true;
        if (name === 'stdout') stdout += text.slice(0, Math.max(0, remaining));
        else stderr += text.slice(0, Math.max(0, remaining));
        const available = Math.max(0, 524288 - captured);
        if (available) notify({ type: 'output', stream: name, text: text.slice(0, available) });
        captured += Math.min(text.length, available);
        omitted += Math.max(0, text.length - available);
      });
    }
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code, signal) => { cleanup(); if (omitted) notify({ type: 'capture', omitted }); resolve({ code, signal, reason, stdout, stderr, truncated, captured, omitted, duration: Date.now() - started }); });
    if (signal?.aborted) cancel();
  });
}

export async function workspace(directory) {
  const root = await fs.realpath(directory);
  function allowed(location) {
    const relative = path.relative(root, location);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.split(path.sep).some(hidden)) {
      throw new Error('Path is outside the workspace or belongs to an excluded directory.');
    }
  }
  async function locate(name) {
    const location = path.resolve(root, name);
    allowed(location);
    let ancestor = location;
    while (true) {
      try { allowed(await fs.realpath(ancestor)); break; }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    return location;
  }
  async function snapshot({ file }) {
    const location = await locate(file);
    const info = await fs.stat(location);
    if (!info.isFile() || info.size > 100000) throw new Error('Read supports text files up to 100000 bytes.');
    const content = await fs.readFile(location, 'utf8');
    if (content.includes('\0')) throw new Error('Binary files cannot be read as text.');
    return { file, content, digest: digest(content) };
  }
  async function read({ file, start = 1, lines = 200 }) {
    const original = await snapshot({ file });
    const parts = original.content.split('\n');
    const content = parts.slice(start - 1, start - 1 + lines).join('\n');
    return { file, digest: original.digest, start, total: parts.length, content: content.slice(0, 20000), truncated: start - 1 + lines < parts.length || content.length > 20000 };
  }
  async function write({ file, content, hash }, signal, notify = () => {}) {
    const location = await locate(file);
    let original;
    try { original = await snapshot({ file }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (original && original.digest !== hash) throw new Error('Read the current file and provide its digest as hash before overwriting.');
    if (!original && hash) throw new Error('File no longer exists; inspect the workspace again.');
    await fs.mkdir(path.dirname(location), { recursive: true });
    await locate(file);
    if (!original) await fs.writeFile(location, content, { flag: 'wx' });
    else {
      const temporary = `${location}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, content, { flag: 'wx', mode: (await fs.stat(location)).mode });
        if ((await snapshot({ file })).digest !== hash) throw new Error('File changed during editing. Read it again.');
        await fs.rename(temporary, location);
      } finally { await fs.rm(temporary, { force: true }); }
    }
    notify({ type: 'change', file, ...change(original?.content || '', content, !original) });
    return { file, bytes: Buffer.byteLength(content), digest: digest(content) };
  }
  async function edit({ file, before, after, hash }, signal, notify) {
    const original = await snapshot({ file });
    if (hash !== original.digest) throw new Error('File changed. Read it again before editing.');
    const index = original.content.indexOf(before);
    if (!before || index < 0 || original.content.indexOf(before, index + before.length) >= 0) throw new Error('The exact replacement must match once.');
    return write({ file, hash, content: original.content.slice(0, index) + after + original.content.slice(index + before.length) }, signal, notify);
  }
  async function list({ directory = '.' }) {
    const entries = await fs.readdir(await locate(directory), { withFileTypes: true });
    return { directory, entries: entries.filter((entry) => !hidden(entry.name)).slice(0, 500).map((entry) => ({ name: entry.name, type: entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file' })), truncated: entries.length > 500 };
  }
  async function search({ query, directory = '.' }, signal) {
    return execute('rg', ['-n', '--hidden', '--max-count', '30', ...[...excluded].flatMap((name) => ['-g', `!**/${name}/**`]), '-g', '!.env', '-g', '!.env.*', '--', query, '.'], { cwd: await locate(directory), signal });
  }
  const tasks = jobs(async ({ command, args = [], directory = '.', timeout = 120000 }, signal, notify) =>
    execute(command, args, { cwd: await locate(directory), timeout, signal, notify }));
  return { root, read, write, edit, list, search, run: tasks.start, jobs: tasks.list, poll: tasks.poll, stop: tasks.stop, close: tasks.close };
}

export async function browse({ url }, signal) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
  const response = await fetch(target, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), headers: { accept: 'text/html, application/xhtml+xml, text/plain, application/json, application/rss+xml' } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Website returned HTTP ${response.status}.`); }
  const type = response.headers.get('content-type') || '';
  if (!/text|json|xml/.test(type)) { await response.body?.cancel(); throw new Error('This URL is not a text page.'); }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let source = '';
  let size = 0;
  let clipped = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1000000) { clipped = true; await reader.cancel(); break; }
      source += decoder.decode(value, { stream: true });
    }
    source += decoder.decode();
  } finally { reader.releaseLock(); }
  if (!/html/.test(type)) return { url: response.url, text: source.slice(0, 18000), truncated: clipped || source.length > 18000, links: [] };
  const page = html(source);
  page('script, style, noscript, svg, nav, footer').remove();
  let marker;
  if (target.hash) {
    const fragment = decodeURIComponent(target.hash.slice(1));
    const anchor = page('[id], a[name]').filter((index, element) => page(element).attr('id') === fragment || page(element).attr('name') === fragment).first();
    if (!anchor.length) throw new Error('Page fragment was not found. Browse the URL without its fragment to inspect available links.');
    marker = crypto.randomUUID();
    const heading = anchor.closest('h1,h2,h3,h4,h5,h6');
    (heading.length ? heading : anchor).before(`\n${marker}\n`);
  }
  const links = [];
  page('a[href]').each((index, element) => {
    if (links.length >= 40) return;
    try {
      const url = new URL(page(element).attr('href'), response.url);
      if (['http:', 'https:'].includes(url.protocol)) links.push({ title: page(element).text().trim().slice(0, 160), url: url.href });
    } catch { /* Ignore malformed links. */ }
  });
  page('br').replaceWith('\n');
  page('p,div,h1,h2,h3,h4,li,pre,tr').append('\n');
  let text = page('body').text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
  if (marker) {
    const offset = text.indexOf(marker);
    if (offset < 0) throw new Error('Page fragment has no readable body content.');
    text = text.slice(offset + marker.length).trim();
  }
  const address = new URL(response.url);
  address.hash = target.hash;
  return { url: address.href, title: page('title').text().trim(), text: text.slice(0, 18000), links, truncated: clipped || text.length > 18000 };
}

export async function web({ query }, signal) {
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('format', 'rss');
  url.searchParams.set('q', query);
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Search returned HTTP ${response.status}.`); }
  const source = await response.text();
  if (source.length > 1000000) throw new Error('Search response is too large.');
  const page = html(source, { xml: true });
  const results = page('item').slice(0, 8).map((index, element) => ({ title: page(element).find('title').text(), url: page(element).find('link').text(), description: page(element).find('description').text() })).get();
  if (!results.length) throw new Error('Search did not return usable results. Try a specific URL with browse or configure another MCP search server.');
  return { query, results };
}

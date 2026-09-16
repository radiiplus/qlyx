import * as crypto from 'node:crypto';

/** Processes owned by one MCP connection; yielding never relaunches a command. */
export function jobs(execute) {
  const entries = new Map();
  let closed = false;
  function get(id) {
    const job = entries.get(id);
    if (!job) throw new Error('Task was not found in this runtime. It cannot be reattached after the runtime closes.');
    return job;
  }
  function summary(job) {
    return { job: job.id, command: job.args.command, args: job.args.args, directory: job.args.directory,
      status: job.result ? job.result.reason || job.result.code !== 0 ? 'failed' : 'complete' : 'running',
      duration: Date.now() - job.started, ...(job.result ? { code: job.result.code, signal: job.result.signal, reason: job.result.reason } : {}) };
  }
  async function pause(job, time, signal) {
    signal?.throwIfAborted();
    let timer, abort;
    try {
      await Promise.race([job.done, new Promise((resolve, reject) => {
        timer = setTimeout(resolve, time);
        abort = () => reject(signal.reason || new Error('Cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
      })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    signal?.throwIfAborted();
  }
  async function start(args, signal, notify = () => {}) {
    if (closed) throw new Error('Task manager is closed.');
    signal?.throwIfAborted();
    if (entries.size >= 32) {
      const finished = [...entries.values()].find(job => job.result);
      if (!finished) throw new Error('32 tasks are already running. Stop or finish one before starting more.');
      entries.delete(finished.id);
    }
    const job = { id: crypto.randomUUID().slice(0, 8), args, started: Date.now(), controller: new AbortController(), events: [], size: 0, omitted: 0 };
    entries.set(job.id, job);
    let attached = true;
    const cancel = () => job.controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    job.done = execute(args, job.controller.signal, event => {
      if (event.type === 'output') {
        const text = event.text.slice(0, Math.max(0, 524288 - job.size));
        job.size += text.length;
        job.omitted += event.text.length - text.length;
        for (let index = 0; index < text.length; index += 4000) job.events.push({ stream: event.stream, text: text.slice(index, index + 4000) });
      } else if (event.type === 'capture') job.omitted += event.omitted;
      if (attached) notify(event);
    }).then(result => { job.result = result; }, error => { job.result = { code: null, reason: error.message }; });
    try {
      await pause(job, args.background ? 0 : 1000, signal);
      if (job.result) return { ...job.result, ...summary(job) };
      return { ...summary(job), cursor: job.events.length, message: 'Command continues in the background. Use local.poll with this job and cursor to check new output; continue independent work.' };
    } finally { attached = false; signal?.removeEventListener('abort', cancel); }
  }
  function list() { return { jobs: [...entries.values()].map(summary) }; }
  async function poll({ job: id, cursor = 0, wait = 0 }, signal) {
    const job = get(id);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > job.events.length) throw new Error('Invalid task output cursor.');
    if (!job.result && wait) await pause(job, wait, signal);
    const events = [];
    let size = 0;
    for (const event of job.events.slice(cursor)) {
      if (size + event.text.length > 24000) break;
      events.push(event); size += event.text.length;
    }
    return { ...summary(job), cursor: cursor + events.length, more: cursor + events.length < job.events.length,
      stdout: events.filter(event => event.stream !== 'stderr').map(event => event.text).join(''),
      stderr: events.filter(event => event.stream === 'stderr').map(event => event.text).join(''), omitted: job.omitted };
  }
  async function stop({ job: id }) {
    const job = get(id);
    if (!job.result) job.controller.abort();
    await job.done;
    return summary(job);
  }
  async function close() {
    closed = true;
    for (const job of entries.values()) if (!job.result) job.controller.abort();
    await Promise.allSettled([...entries.values()].map(job => job.done));
  }
  return { start, list, poll, stop, close };
}

export type BrowserJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type BrowserJobError = {
  code: string;
  message: string;
  details?: unknown;
};

export type BrowserJobOperation = {
  id: string;
  action: string;
  page?: string;
  request: Record<string, unknown>;
  status: BrowserJobStatus;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: BrowserJobError;
};

export type BrowserJobEvent = {
  sequence: number;
  type:
    | 'job.started'
    | 'job.completed'
    | 'job.failed'
    | 'job.cancelled'
    | 'operation.started'
    | 'operation.completed'
    | 'operation.failed'
    | 'operation.cancelled';
  at: string;
  job: string;
  operation?: string;
  action?: string;
  page?: string;
  error?: BrowserJobError;
};

export type BrowserSessionJob = {
  key: string;
  scope: string;
  job: string;
  owner: number;
  session: string;
  workspace: string;
  ref: string;
  status: BrowserJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelRequested?: boolean;
  operations: BrowserJobOperation[];
  events: BrowserJobEvent[];
};

export type BrowserJobSummary = {
  job: string;
  status: BrowserJobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  counts: Record<BrowserJobStatus | 'total', number>;
  operations: Array<Omit<BrowserJobOperation, 'request'>>;
  events: BrowserJobEvent[];
  page: { offset: number; limit: number; total: number; next: number | null };
};

type BrowserSessionOptions = {
  actions: ReadonlySet<string>;
  maxJobs: number;
  maxOperations: number;
  maxEvents: number;
  execute: (
    job: BrowserSessionJob,
    operation: BrowserJobOperation,
    signal: AbortSignal,
  ) => Promise<object>;
  persist: () => Promise<void>;
  emit: (job: BrowserSessionJob, event: BrowserJobEvent, result?: object) => Promise<void>;
  cancel?: (job: BrowserSessionJob, operation: BrowserJobOperation) => Promise<void>;
};

export class BrowserSessionFault extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value.trim())) {
    throw new BrowserSessionFault('JOB', `${field} must contain 1-80 letters, numbers, dots, underscores, or hyphens.`);
  }
  return value.trim();
}

function timestamp(): string {
  return new Date().toISOString();
}

function terminal(status: BrowserJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function failure(error: unknown): BrowserJobError {
  const value = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown; details?: unknown }
    : undefined;
  return {
    code: typeof value?.code === 'string' && value.code ? value.code : 'BROWSER',
    message: typeof value?.message === 'string' && value.message
      ? value.message : error instanceof Error ? error.message : String(error),
  };
}

function operationView(operation: BrowserJobOperation): Omit<BrowserJobOperation, 'request'> {
  const { request: _request, ...view } = operation;
  return structuredClone(view);
}

export class BrowserSessionManager {
  private readonly jobs = new Map<string, BrowserSessionJob>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly muted = new Set<string>();

  constructor(private readonly options: BrowserSessionOptions) {}

  restore(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    let interrupted = false;
    for (const candidate of value.slice(-this.options.maxJobs)) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const stored = candidate as Partial<BrowserSessionJob>;
      if (typeof stored.key !== 'string' || !stored.key || typeof stored.scope !== 'string' || !stored.scope
        || typeof stored.job !== 'string' || !stored.job || !Number.isInteger(stored.owner)
        || typeof stored.session !== 'string' || !stored.session || typeof stored.workspace !== 'string'
        || !stored.workspace || typeof stored.ref !== 'string' || !stored.ref
        || typeof stored.createdAt !== 'string' || typeof stored.updatedAt !== 'string'
        || !Array.isArray(stored.operations) || !Array.isArray(stored.events)) continue;
      const operations = stored.operations.filter((item): item is BrowserJobOperation => Boolean(
        item && typeof item.id === 'string' && typeof item.action === 'string'
        && item.request && typeof item.request === 'object' && !Array.isArray(item.request)
        && typeof item.status === 'string' && typeof item.queuedAt === 'string',
      )).map((item) => structuredClone(item));
      if (operations.length !== stored.operations.length) continue;
      const job = structuredClone({ ...stored, operations }) as BrowserSessionJob;
      job.events = job.events.filter((event) => event && typeof event.sequence === 'number'
        && typeof event.type === 'string' && typeof event.at === 'string').slice(-this.options.maxEvents);
      const active = job.operations.filter((operation) => operation.status === 'queued' || operation.status === 'running');
      if (active.length > 0 || job.status === 'queued' || job.status === 'running') {
        interrupted = true;
        const at = timestamp();
        const error = { code: 'INTERRUPTED', message: 'The extension worker stopped before this browser operation completed.' };
        for (const operation of active) {
          operation.status = 'failed';
          operation.completedAt = at;
          operation.error = error;
          this.append(job, {
            type: 'operation.failed',
            at,
            job: job.job,
            operation: operation.id,
            action: operation.action,
            page: operation.page,
            error,
          });
        }
        job.status = 'failed';
        job.updatedAt = at;
        job.completedAt = at;
        this.append(job, { type: 'job.failed', at, job: job.job, error });
      }
      this.jobs.set(job.key, job);
    }
    return interrupted;
  }

  snapshot(): BrowserSessionJob[] {
    return structuredClone([...this.jobs.values()]);
  }

  list(scope: string): BrowserJobSummary[] {
    return [...this.jobs.values()]
      .filter((job) => job.scope === scope)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((job) => this.summary(job, 0, 0));
  }

  trace(scope: string, limit = 8): BrowserJobSummary[] {
    const safeLimit = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 100) : 8;
    return [...this.jobs.values()]
      .filter((job) => job.scope === scope)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((job) => this.summary(job, Math.max(0, job.events.length - safeLimit), safeLimit));
  }

  status(key: string, offset = 0, limit = 20): BrowserJobSummary {
    const job = this.jobs.get(key);
    if (!job) throw new BrowserSessionFault('JOB_NOT_FOUND', 'Browser job was not found in this conversation.');
    return this.summary(job, offset, limit);
  }

  async create(input: {
    key: string;
    scope: string;
    job: unknown;
    owner: number;
    session: string;
    workspace: string;
    ref: string;
    operations: unknown;
  }): Promise<BrowserJobSummary> {
    const name = identifier(input.job, 'job');
    if (this.jobs.has(input.key)) throw new BrowserSessionFault('JOB_EXISTS', `Browser job already exists: ${name}`);
    if (!Array.isArray(input.operations) || input.operations.length < 1
      || input.operations.length > this.options.maxOperations) {
      throw new BrowserSessionFault(
        'JOB',
        `operations must contain 1-${this.options.maxOperations} browser operations.`,
      );
    }
    const queuedAt = timestamp();
    const operations = input.operations.map((candidate, index): BrowserJobOperation => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new BrowserSessionFault('JOB', `operations[${index}] must be an object.`);
      }
      const request = candidate as Record<string, unknown>;
      const id = identifier(request.id, `operations[${index}].id`);
      const action = typeof request.action === 'string' ? request.action : '';
      if (!this.options.actions.has(action)) {
        throw new BrowserSessionFault('JOB_ACTION', `Unsupported asynchronous browser action: ${action || '(missing)'}`);
      }
      const page = typeof request.page === 'string' && request.page.trim()
        ? identifier(request.page, `operations[${index}].page`)
        : action === 'browser_open' ? id : undefined;
      return { id, action, page, request: structuredClone(request), status: 'queued', queuedAt };
    });
    if (new Set(operations.map((operation) => operation.id)).size !== operations.length) {
      throw new BrowserSessionFault('JOB', 'Browser operation ids must be unique within a job.');
    }
    this.prune();
    if (this.jobs.size >= this.options.maxJobs) {
      throw new BrowserSessionFault('JOB_LIMIT', `The ${this.options.maxJobs}-job browser history limit was reached.`);
    }
    const job: BrowserSessionJob = {
      key: input.key,
      scope: input.scope,
      job: name,
      owner: input.owner,
      session: input.session,
      workspace: input.workspace,
      ref: input.ref,
      status: 'queued',
      createdAt: queuedAt,
      updatedAt: queuedAt,
      operations,
      events: [],
    };
    this.jobs.set(job.key, job);
    await this.options.persist();
    return this.summary(job, 0, 20);
  }

  async run(key: string): Promise<void> {
    const job = this.jobs.get(key);
    if (!job || job.status !== 'queued') return;
    const at = timestamp();
    job.status = 'running';
    job.updatedAt = at;
    const started = this.append(job, { type: 'job.started', at, job: job.job });
    await this.options.persist();
    await this.notify(job, started);
    await Promise.all(job.operations.map(async (operation) => await this.schedule(job, operation)));
    if (terminal(job.status)) return;
    const failed = job.operations.some((operation) => operation.status === 'failed');
    const cancelled = job.cancelRequested === true
      || job.operations.some((operation) => operation.status === 'cancelled');
    const completedAt = timestamp();
    job.status = failed ? 'failed' : cancelled ? 'cancelled' : 'completed';
    job.updatedAt = completedAt;
    job.completedAt = completedAt;
    const type = job.status === 'cancelled'
      ? 'job.cancelled' : job.status === 'failed' ? 'job.failed' : 'job.completed';
    const error = failed ? { code: 'JOB_FAILED', message: 'One or more browser operations failed.' } : undefined;
    const event = this.append(job, { type, at: completedAt, job: job.job, error });
    await this.options.persist();
    await this.notify(job, event);
  }

  async cancel(key: string, operationId?: unknown): Promise<BrowserJobSummary> {
    const job = this.jobs.get(key);
    if (!job) throw new BrowserSessionFault('JOB_NOT_FOUND', 'Browser job was not found in this conversation.');
    if (terminal(job.status)) return this.summary(job, 0, 20);
    const selected = operationId === undefined
      ? job.operations.filter((operation) => !terminal(operation.status))
      : [job.operations.find((operation) => operation.id === identifier(operationId, 'operation'))]
        .filter((operation): operation is BrowserJobOperation => Boolean(operation));
    if (operationId !== undefined && selected.length === 0) {
      throw new BrowserSessionFault('OPERATION_NOT_FOUND', `Browser operation was not found: ${String(operationId)}`);
    }
    if (operationId === undefined) job.cancelRequested = true;
    const at = timestamp();
    for (const operation of selected) {
      if (operation.status === 'queued') {
        operation.status = 'cancelled';
        operation.completedAt = at;
        const event = this.append(job, {
          type: 'operation.cancelled',
          at,
          job: job.job,
          operation: operation.id,
          action: operation.action,
          page: operation.page,
        });
        await this.notify(job, event);
      } else if (operation.status === 'running') {
        this.controllers.get(this.operationKey(job, operation))?.abort();
        await this.options.cancel?.(job, operation).catch(() => undefined);
      }
    }
    job.updatedAt = at;
    await this.options.persist();
    return this.summary(job, 0, 20);
  }

  async cancelOwner(owner: number): Promise<void> {
    const jobs = [...this.jobs.values()].filter((job) => job.owner === owner && !terminal(job.status));
    for (const job of jobs) this.muted.add(job.key);
    await Promise.all(jobs.map(async (job) => await this.cancel(job.key)));
  }

  private async schedule(job: BrowserSessionJob, operation: BrowserJobOperation): Promise<void> {
    const lane = operation.page ? `${job.scope}:${operation.page}` : `${job.key}:${operation.id}`;
    const previous = this.lanes.get(lane) || Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => await this.execute(job, operation));
    this.lanes.set(lane, task);
    try {
      await task;
    } finally {
      if (this.lanes.get(lane) === task) this.lanes.delete(lane);
    }
  }

  private async execute(job: BrowserSessionJob, operation: BrowserJobOperation): Promise<void> {
    if (operation.status !== 'queued') return;
    const controller = new AbortController();
    const key = this.operationKey(job, operation);
    this.controllers.set(key, controller);
    const startedAt = timestamp();
    operation.status = 'running';
    operation.startedAt = startedAt;
    job.updatedAt = startedAt;
    const started = this.append(job, {
      type: 'operation.started',
      at: startedAt,
      job: job.job,
      operation: operation.id,
      action: operation.action,
      page: operation.page,
    });
    await this.options.persist();
    await this.notify(job, started);
    let result: object | undefined;
    let event: BrowserJobEvent;
    try {
      result = await this.options.execute(job, operation, controller.signal);
      if (controller.signal.aborted) throw new BrowserSessionFault('CANCELLED', 'Browser operation was cancelled.');
      const completedAt = timestamp();
      operation.status = 'completed';
      operation.completedAt = completedAt;
      event = this.append(job, {
        type: 'operation.completed',
        at: completedAt,
        job: job.job,
        operation: operation.id,
        action: operation.action,
        page: operation.page,
      });
    } catch (error) {
      const completedAt = timestamp();
      const cancelled = controller.signal.aborted;
      operation.status = cancelled ? 'cancelled' : 'failed';
      operation.completedAt = completedAt;
      operation.error = cancelled ? { code: 'CANCELLED', message: 'Browser operation was cancelled.' } : failure(error);
      event = this.append(job, {
        type: cancelled ? 'operation.cancelled' : 'operation.failed',
        at: completedAt,
        job: job.job,
        operation: operation.id,
        action: operation.action,
        page: operation.page,
        error: operation.error,
      });
      result = undefined;
    } finally {
      this.controllers.delete(key);
    }
    job.updatedAt = event.at;
    await this.options.persist();
    await this.notify(job, event, result);
  }

  private append(job: BrowserSessionJob, value: Omit<BrowserJobEvent, 'sequence'>): BrowserJobEvent {
    const last = job.events[job.events.length - 1]?.sequence || 0;
    const event = { ...value, sequence: last + 1 } as BrowserJobEvent;
    job.events.push(event);
    if (job.events.length > this.options.maxEvents) job.events.splice(0, job.events.length - this.options.maxEvents);
    return event;
  }

  private summary(job: BrowserSessionJob, offset: number, limit: number): BrowserJobSummary {
    const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const safeLimit = Number.isInteger(limit) && limit >= 0 ? Math.min(limit, 100) : 20;
    const events = safeLimit === 0 ? [] : job.events.slice(safeOffset, safeOffset + safeLimit);
    const counts: BrowserJobSummary['counts'] = {
      total: job.operations.length,
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const operation of job.operations) counts[operation.status] += 1;
    return {
      job: job.job,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
      counts,
      operations: job.operations.map(operationView),
      events: structuredClone(events),
      page: {
        offset: safeOffset,
        limit: safeLimit,
        total: job.events.length,
        next: safeOffset + events.length < job.events.length ? safeOffset + events.length : null,
      },
    };
  }

  private operationKey(job: BrowserSessionJob, operation: BrowserJobOperation): string {
    return `${job.key}:${operation.id}`;
  }

  private async notify(job: BrowserSessionJob, event: BrowserJobEvent, result?: object): Promise<void> {
    if (this.muted.has(job.key)) return;
    await this.options.emit(job, event, result);
  }

  private prune(): void {
    if (this.jobs.size < this.options.maxJobs) return;
    const removable = [...this.jobs.values()]
      .filter((job) => terminal(job.status))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    while (this.jobs.size >= this.options.maxJobs && removable.length > 0) {
      const job = removable.shift();
      if (job) this.jobs.delete(job.key);
    }
  }
}

export type LogLevel = 'info' | 'warn' | 'error';

export type LogEntry = {
  id: string;
  at: string;
  level: LogLevel;
  source: string;
  event: string;
  detail: string;
};

const key = 'diagnosticLogs';
const maximum = 100;
let writes: Promise<void> = Promise.resolve();

function entries(value: unknown): LogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is LogEntry => Boolean(
    item
    && typeof item.id === 'string'
    && typeof item.at === 'string'
    && ['info', 'warn', 'error'].includes(item.level)
    && typeof item.source === 'string'
    && typeof item.event === 'string'
    && typeof item.detail === 'string',
  ));
}

export async function readLogs(limit = 30): Promise<LogEntry[]> {
  await writes;
  try {
    const stored = await chrome.storage.local.get(key);
    return entries(stored[key]).slice(-Math.max(0, limit));
  } catch (error) {
    console.error('Qlyx diagnostic read failed', error);
    return [];
  }
}

export async function writeLog(
  level: LogLevel,
  source: string,
  event: string,
  detail = '',
): Promise<void> {
  const entry: LogEntry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    level,
    source: source.slice(0, 40),
    event: event.slice(0, 80),
    detail: detail.slice(0, 500),
  };
  writes = writes.catch(() => undefined).then(async () => {
    const stored = await chrome.storage.local.get(key);
    const next = [...entries(stored[key]), entry].slice(-maximum);
    await chrome.storage.local.set({ [key]: next });
  }).catch((error) => console.error('Qlyx diagnostic write failed', error));
  await writes;
}

export async function clearLogs(): Promise<void> {
  await writes;
  try {
    await chrome.storage.local.remove(key);
  } catch (error) {
    console.error('Qlyx diagnostic clear failed', error);
  }
}

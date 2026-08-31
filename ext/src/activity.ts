export type ActivityStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export type ActivityItem = {
  id: string;
  tab: number;
  action: string;
  detail?: string;
  target: string;
  result?: string;
  status: ActivityStatus;
  startedAt: string;
  updatedAt: string;
};

const key = 'operationActivity';
const maximum = 100;
let writes: Promise<void> = Promise.resolve();

function entries(value: unknown): ActivityItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ActivityItem => Boolean(
    item
    && typeof item.id === 'string'
    && Number.isInteger(item.tab)
    && typeof item.action === 'string'
    && (item.detail === undefined || typeof item.detail === 'string')
    && typeof item.target === 'string'
    && (item.result === undefined || typeof item.result === 'string')
    && ['queued', 'running', 'succeeded', 'failed'].includes(item.status)
    && typeof item.startedAt === 'string'
    && typeof item.updatedAt === 'string',
  ));
}

export async function readActivity(tab: number, limit = 30): Promise<ActivityItem[]> {
  await writes;
  try {
    const stored = await chrome.storage.local.get(key);
    return entries(stored[key]).filter((item) => item.tab === tab).slice(-Math.max(0, limit));
  } catch (error) {
    console.error('Qlyx activity read failed', error);
    return [];
  }
}

export async function writeActivity(item: ActivityItem): Promise<void> {
  writes = writes.catch(() => undefined).then(async () => {
    const stored = await chrome.storage.local.get(key);
    const activity = entries(stored[key]);
    const index = activity.findIndex((entry) => entry.id === item.id && entry.tab === item.tab);
    if (index === -1) activity.push(item);
    else activity[index] = { ...activity[index], ...item };
    await chrome.storage.local.set({ [key]: activity.slice(-maximum) });
  }).catch((error) => console.error('Qlyx activity write failed', error));
  await writes;
}

export async function replaceActivityId(tab: number, before: string, after: string): Promise<void> {
  if (!before || !after || before === after) return;
  writes = writes.catch(() => undefined).then(async () => {
    const stored = await chrome.storage.local.get(key);
    const activity = entries(stored[key]);
    const index = activity.findIndex((entry) => entry.id === before && entry.tab === tab);
    if (index === -1) return;
    const current = activity[index];
    if (!current) return;
    activity[index] = { ...current, id: after, updatedAt: new Date().toISOString() };
    await chrome.storage.local.set({ [key]: activity.slice(-maximum) });
  }).catch((error) => console.error('Qlyx activity id replacement failed', error));
  await writes;
}

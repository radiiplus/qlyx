const maximum = 200;

export function correlationIdentity(value: string): string {
  if (!value) return '';
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `qlx_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function bounded(prefix: string, value: string): string {
  if (prefix.length + value.length <= maximum) return `${prefix}${value}`;
  const digest = correlationIdentity(value).slice(4);
  const available = Math.max(0, maximum - prefix.length - digest.length - 1);
  return `${prefix}${value.slice(0, available)}:${digest}`;
}

export function transportOperationId(tab: number, value: unknown, key: string, session: string): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : key;
  const scope = correlationIdentity(session).slice(4);
  const generation = correlationIdentity(key).slice(4);
  return bounded(`${tab}:${scope}:${generation}:`, text);
}

export function legacyOperationId(tab: number, value: unknown, key: string, session: string): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : key;
  const scope = correlationIdentity(session).slice(4);
  return bounded(`${tab}:${scope}:`, text);
}

export function retryOperationId(id: string, token: string): string {
  return bounded(`retry:${correlationIdentity(token).slice(4)}:`, id);
}

export function retryTransportRequest(
  input: Record<string, unknown>,
  ids: string[],
  token: string,
): { id: string; replacements: Map<string, string>; work: Record<string, unknown> } {
  const replacements = new Map(ids.map((id) => [id, retryOperationId(id, token)]));
  const work = structuredClone(input);
  const currentId = typeof work.id === 'string' ? work.id : ids[0] || '';
  const id = replacements.get(currentId) || retryOperationId(currentId, token);
  work.id = id;
  if (Array.isArray(work.operations)) {
    work.operations = work.operations.map((operation) => {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return operation;
      const child = operation as Record<string, unknown>;
      const childId = typeof child.id === 'string' ? child.id : '';
      return { ...child, id: replacements.get(childId) || retryOperationId(childId, token) };
    });
  }
  return { id, replacements, work };
}

export type Mark = {
  action: string;
  start: string;
  end: string;
};

export type Block = {
  action: string;
  value?: Record<string, unknown>;
  error?: string;
  key: string;
  at: number;
};

function clean(value: string): string {
  let body = value.trim();
  if (body.startsWith('```')) {
    const line = body.indexOf('\n');
    body = line < 0 ? '' : body.slice(line + 1);
    if (body.trimEnd().endsWith('```')) body = body.trimEnd().slice(0, -3);
  } else if (/^json\s*[\r\n]/i.test(body)) {
    body = body.replace(/^json\s*[\r\n]+/i, '');
  }
  return body.trim();
}

function hash(value: string): string {
  let code = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    code ^= value.charCodeAt(index);
    code = Math.imul(code, 16777619);
  }
  return (code >>> 0).toString(36);
}

function decode(
  action: string,
  raw: string,
  at: number,
  limit: number,
): Block {
  const body = clean(raw);
  const key = `${action}:${body.length}:${hash(body)}`;
  if (new TextEncoder().encode(body).byteLength > limit) {
    return { action, error: `Block exceeds ${limit} bytes.`, key, at };
  }
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Payload must be a JSON object.');
    }
    return { action, value: value as Record<string, unknown>, key, at };
  } catch (error) {
    return { action, error: (error as Error).message, key, at };
  }
}

export function parse(text: string, marks: Mark[], limit = 1048576): Block[] {
  const blocks: Block[] = [];
  for (const mark of marks) {
    if (!mark.action || !mark.start || !mark.end || mark.start === mark.end) continue;
    let offset = 0;
    while (offset < text.length) {
      const at = text.indexOf(mark.start, offset);
      if (at < 0) break;
      const head = at + mark.start.length;
      const tail = text.indexOf(mark.end, head);
      if (tail < 0) break;
      const raw = text.slice(head, tail);
      blocks.push(decode(mark.action, raw, at, limit));
      offset = tail + mark.end.length;
    }
  }
  return blocks.sort((left, right) => left.at - right.at);
}

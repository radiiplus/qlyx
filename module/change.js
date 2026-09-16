/** A bounded, exact replacement hunk, with surrounding lines for orientation. */
export function change(before, after, created = false) {
  const split = text => text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const original = split(before), current = split(after);
  let start = 0, end = 0;
  while (start < original.length && start < current.length && original[start] === current[start]) start++;
  while (end < original.length - start && end < current.length - start && original.at(-end - 1) === current.at(-end - 1)) end++;
  const removed = original.length - start - end, added = current.length - start - end;
  const lines = [];
  const append = (kind, text, number) => { if (lines.length < 60) lines.push({ kind, text: text.slice(0, 240), number }); };
  for (let index = Math.max(0, start - 2); index < start; index++) append('context', original[index], index + 1);
  for (let index = start; index < original.length - end; index++) append('removed', original[index], index + 1);
  for (let index = start; index < current.length - end; index++) append('added', current[index], index + 1);
  for (let index = current.length - end; index < Math.min(current.length, current.length - end + 2); index++) append('context', current[index], index + 1);
  return { created, added, removed, lines, before, after, truncated: Math.min(2, start) + removed + added + Math.min(2, end) > 60 || [...original, ...current].some(line => line.length > 240), newline: !created && before.endsWith('\n') !== after.endsWith('\n') };
}

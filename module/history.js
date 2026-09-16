export function history(state, kind = 'agent') {
  if (!state) return [];
  if (kind === 'prompt') return (state.history || []).filter(item =>
    ['user', 'assistant'].includes(item.role) && typeof item.content === 'string');
  const result = [];
  if (typeof state.task === 'string' && state.task.trim()) result.push({ role: 'user', content: state.task });
  for (const item of state.history || []) {
    if (item.role === 'user' && typeof item.content === 'string') result.push(item);
    if (item.role === 'assistant' && ['final', 'question'].includes(item.content?.action) && typeof item.content.message === 'string') {
      result.push({ role: 'assistant', content: item.content.message });
    }
  }
  if (typeof state.message === 'string' && state.message && result.at(-1)?.content !== state.message) {
    result.push({ role: 'assistant', content: state.message });
  }
  return result;
}

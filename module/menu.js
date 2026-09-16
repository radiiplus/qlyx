/** Group navigation is local; only leaf choices submit commands. */
const groups = [
  { value: '/model', description: 'Choose model', command: '/model' },
  { value: '/batch', description: 'Approve all actions in this turn' },
  { value: '/approval', description: 'Tool permissions', children: [
    ['on', 'Approve enabled tools automatically', '/auto on'],
    ['off', 'Ask before edits and commands', '/auto off'],
    ['passive', 'Read and research only', '/mode passive'],
  ] },
  { value: '/plan', description: 'Automatic task progress', children: [
    ['status', 'Current task and milestone count', '/plan status'],
    ['steps', 'Inspect live milestones', '/plan steps'],
    ['progress', 'Completed tools and pending work', '/plan progress'],
  ] },
  { value: '/session', description: 'Saved conversations', children: [
    ['resume', 'Choose a saved session', '/sessions'], ['new', 'Start a new session', '/new'],
    ['continue', 'Resume unfinished work', '/continue'], ['check', 'Validate the Qwen session', '/session check'], ['reset', 'Reconnect the remote chat', '/reset'],
    ['history', 'Read saved conversation', '/history'], ['skills', 'List approved global skills', '/skills'],
  ] },
  { value: '/tasks', description: 'Background commands', children: [
    ['list', 'Show running and finished commands', '/tasks list'],
    ['output', 'Inspect output by task ID', '/tasks output'],
    ['stop', 'Stop a command by task ID', '/tasks stop'],
  ] },
  { value: '/inspect', description: 'Execution details', children: [
    ['output', 'Captured command output', '/output'], ['executions', 'List executions', '/outputs'],
    ['diff', 'Inspect a file change', '/diff'], ['explain', 'Purpose and observations', '/explain'],
    ['map', 'Session activity map', '/map'], ['learned', 'Recorded findings', '/learned'],
  ] },
  { value: '/help', description: 'Command help' }, { value: '/stop', description: 'Cancel current turn' },
  { value: '/exit', description: 'Leave chat' },
];
export function suggest(value) {
  const group = groups.find(group => value.startsWith(group.value + ' '));
  if (group?.children) return group.children.map(([name, description, command]) => ({ value: group.value + ' ' + name, label: name, description, command })).filter(item => item.value.startsWith(value));
  return groups.filter(group => group.value.startsWith(value)).map(group => ({ value: group.value, description: group.description, branch: Boolean(group.children), group: Boolean(group.children || group.command), command: group.command }));
}
export function resolve(line) {
  for (const group of groups) for (const [name, , command] of group.children || []) {
    const value = group.value + ' ' + name;
    if (line === value || line.startsWith(value + ' ')) return command + line.slice(value.length);
  }
  return line;
}

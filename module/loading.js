export function loading({ output = process.stderr, label = 'Waiting for model' } = {}) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const started = Date.now();
  let index = 0;
  let timer;
  let stopped = false;
  function render() {
    output.write(`\r\u001b[2K${frames[index++ % frames.length]} ${label}… ${Math.floor((Date.now() - started) / 1000)}s`);
  }
  if (output.isTTY) {
    render();
    timer = setInterval(render, 80);
    timer.unref();
  } else output.write(`${label}…\n`);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (output.isTTY) output.write('\r\u001b[2K');
  };
}

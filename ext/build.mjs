import { build } from 'esbuild';

await build({
  entryPoints: ['src/worker.ts', 'src/watch.ts', 'src/browse.ts', 'src/popup.ts', 'src/sidepanel.ts'],
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  platform: 'browser',
  target: 'chrome116',
  sourcemap: true,
});

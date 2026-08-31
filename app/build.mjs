import { chmod } from 'node:fs/promises';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  outfile: 'dist/cli.js',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  define: { __QLYX_CLI_BUNDLE__: 'true' },
  sourcemap: true,
});

await chmod('dist/cli.js', 0o755);

import { build } from 'esbuild';

await build({
  entryPoints: { index: 'src/index.ts', operations: 'src/operations/schema.ts' },
  outdir: 'dist',
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
});

// Bundle the server (and the shared package) into one file. npm packages stay external.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@snackoverflow/'));

await build({
  entryPoints: ['src/index.ts', 'src/migrate.ts'],
  outdir: 'dist',
  entryNames: '[name]',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  outExtension: { '.js': '.js' },
  logLevel: 'info',
});

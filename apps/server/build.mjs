// Bundle the server, the shared package and all npm dependencies into dist/,
// so the Docker image needs no node_modules.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts', 'src/migrate.ts'],
  outdir: 'dist',
  entryNames: '[name]',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  // Optional native add-ons some packages try to load; never used here.
  external: ['pg-native', 'bufferutil', 'utf-8-validate'],
  // CommonJS dependencies call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});

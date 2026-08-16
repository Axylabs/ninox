import { defineConfig } from 'tsup';

/**
 * Build config for the published package (`ninox`).
 *
 * - Two entries mirror the runtime `exports` map: `.` (src/index.ts) and
 *   `./utils` (src/utils/index.ts).
 * - ESM-only (package.json `"type": "module"`). Node 18.17+ / Bun 1.0+.
 * - `dts: true` emits `dist/index.d.ts` + `dist/utils.d.ts` for consumers.
 * - `mongodb` is a real runtime dependency and stays external.
 * - The source uses explicit `.ts` import specifiers; the bundler + rollup-dts
 *   resolve them, so the emitted `dist` has no `.ts` extension leakage.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    utils: 'src/utils/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'neutral',
  treeshake: true,
  splitting: false,
  outDir: 'dist',
  external: ['mongodb'],
});

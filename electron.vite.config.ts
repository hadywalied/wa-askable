import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { dependencies?: Record<string, string> };

/**
 * Nothing in `dependencies` may be bundled, and neither may `electron`.
 *
 * Two ways this bites, both hit during Phase 0 (PLAN.md §11.6):
 *
 *  - `electron` lives in devDependencies, so externalizeDepsPlugin() does not
 *    externalize it. Bundled, its npm launcher stub (the one that reads
 *    path.txt) ends up in out/main/ and the app dies with "Electron failed to
 *    install correctly", because __dirname is no longer node_modules/electron.
 *
 *  - Setting build.rollupOptions.external REPLACES the list the plugin
 *    populated rather than adding to it. Clobber it and better-sqlite3 gets
 *    bundled too, then looks for its .node binary at out/build/Release/ and
 *    fails. So the list is built explicitly here and kept in one place.
 *
 * Native modules must also stay in `dependencies` (not devDependencies) so
 * electron-builder collects their binaries at packaging time.
 */
const EXTERNAL = ['electron', ...Object.keys(pkg.dependencies ?? {})];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: EXTERNAL,
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: EXTERNAL,
        input: { index: resolve('src/preload/index.ts') },
        // A sandboxed preload MUST be CommonJS — Electron only supports ESM
        // preloads when sandbox is false, and we are not turning the sandbox
        // off for an app that holds other people's private messages. The .cjs
        // extension is required because package.json sets "type": "module".
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
});

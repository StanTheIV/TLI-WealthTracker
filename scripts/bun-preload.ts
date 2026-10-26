/**
 * Preload for running main-process code under plain Bun (the replay CLI).
 * The engine reaches `electron` only through the logger's `app.getPath`, and
 * the real package resolves to a binary path outside Electron — so swap in
 * the same one-function stub vitest uses (src/test/electron-stub.ts).
 */
import {plugin} from 'bun';
import {tmpdir} from 'os';

plugin({
  name: 'electron-stub',
  setup(build) {
    build.module('electron', () => ({
      exports: {app: {getPath: () => tmpdir()}},
      loader:  'object',
    }));
  },
});

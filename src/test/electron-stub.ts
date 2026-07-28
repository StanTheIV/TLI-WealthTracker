/**
 * Stub for the `electron` module under vitest. Engine code reaches it
 * transitively (TrackerRegistry → logger → `app`), and the real module throws
 * at import time when the binary is absent — the case in CI, which installs
 * with `--ignore-scripts`.
 *
 * Only `app.getPath` is stubbed: it's all the main process calls at this
 * boundary, lazily inside init functions the tests never invoke.
 */
export const app = {
  getPath: (_name: string): string => '/tmp/tli-tracker-test',
};

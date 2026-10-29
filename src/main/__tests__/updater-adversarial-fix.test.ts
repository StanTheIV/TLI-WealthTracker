/** One download in flight: a concurrent request joins it; install never opens a file still being written. */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createHash} from 'crypto';
import {mkdtempSync, readFileSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

type Fn = (...args: unknown[]) => unknown;
const h = vi.hoisted(() => ({
  handle:   new Map<string, (...args: unknown[]) => unknown>(),
  on:       new Map<string, (...args: unknown[]) => unknown>(),
  fetch:    vi.fn(),
  openPath: vi.fn(),
  quit:     vi.fn(),
  warn:     vi.fn(),
  error:    vi.fn(),
  temp:     '',
}));
vi.mock('electron', () => ({
  app:     {getVersion: () => '1.0.0', getPath: () => h.temp, quit: h.quit},
  net:     {fetch: h.fetch},
  shell:   {openPath: h.openPath},
  ipcMain: {
    handle: (channel: string, fn: Fn) => { h.handle.set(channel, fn); },
    on:     (channel: string, fn: Fn) => { h.on.set(channel, fn); },
  },
}));
vi.mock('@/main/logger', () => ({log: {debug: () => undefined, info: () => undefined, warn: h.warn, error: h.error}}));
vi.mock('@/main/db', () => ({settingsGet: () => undefined, settingsSet: () => undefined}));

const API_URL      = 'https://api.github.com/repos/StanTheIV/TLI-WealthTracker/releases/latest';
const SETUP_URL    = 'https://example.invalid/TLI.Tracker.Setup.2.0.0.exe';
const INSTALLER    = new Uint8Array(Buffer.from('MZ fake NSIS installer payload '.repeat(64)));
const HEX          = createHash('sha256').update(INSTALLER).digest('hex');
const ASSET        = {name: 'TLI.Tracker.Setup.2.0.0.exe', browser_download_url: SETUP_URL, size: INSTALLER.length, digest: `sha256:${HEX}`};

const dest     = () => join(h.temp, 'TLI-Tracker-Setup.exe');
const download = () => h.handle.get('updater:download')!({}) as Promise<{success: boolean; error?: string}>;
/** `updater:install` is fire-and-forget (`ipcMain.on`); let the openPath promise settle. */
const install  = async () => {
  h.on.get('updater:install')!({});
  await new Promise(r => setTimeout(r, 0));
};
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A Setup body the test feeds by hand. */
const gated = () => {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({start: c => { ctl = c; }});
  return {stream, ctl: () => ctl};
};

/** `net.fetch`: the release JSON for the API, the next of `bodies` for each Setup request. */
function serve(bodies: ReadableStream<Uint8Array>[]): void {
  h.fetch.mockImplementation(async (url: string) => {
    if (url === API_URL) {
      return new Response(JSON.stringify({tag_name: 'v2.0.0', body: '', html_url: '', assets: [ASSET]}));
    }
    if (url === SETUP_URL) return new Response(bodies.shift()!);
    throw new Error(`unexpected fetch ${url}`);
  });
}
const setupFetches = () => h.fetch.mock.calls.filter(c => c[0] === SETUP_URL).length;

beforeEach(async () => {
  vi.clearAllMocks();
  h.handle.clear();
  h.on.clear();
  h.temp = mkdtempSync(join(tmpdir(), 'tli-updater-test-'));
  h.openPath.mockResolvedValue('');
  vi.resetModules(); // fresh module state: no installer verified, no download in flight
  const {registerUpdaterHandlers} = await import('@/main/ipc/updater');
  registerUpdaterHandlers(() => null);
});

afterEach(() => {
  rmSync(h.temp, {recursive: true, force: true});
});

describe('concurrent downloads', () => {
  it('a second download joins the one in flight: no second writer, same outcome, install opens only the complete verified file', async () => {
    const a = gated();
    const b = gated();
    serve([a.stream, b.stream]);
    const opened: Uint8Array[] = [];
    h.openPath.mockImplementation(async (p: string) => { opened.push(readFileSync(p)); return ''; });

    const pa = download();
    await wait(50);
    const pb = download();
    await wait(50);
    b.ctl().enqueue(new Uint8Array(10).fill(0x42)); // would-be second writer's bytes: never fetched, never written
    await wait(50);
    a.ctl().enqueue(INSTALLER);
    a.ctl().close();

    expect((await pa).success).toBe(true);
    expect(await pb).toEqual(await pa);
    expect(setupFetches()).toBe(1);

    await install();
    expect(h.openPath).toHaveBeenCalledTimes(1);
    expect(h.openPath).toHaveBeenCalledWith(dest());
    expect(Buffer.from(opened[0]).equals(Buffer.from(INSTALLER))).toBe(true);
    b.ctl().error(new Error('abort'));
  });

  it('a joined download that fails fails both callers and leaves nothing to install', async () => {
    const a = gated();
    serve([a.stream]);

    const pa = download();
    await wait(50);
    const pb = download();
    await wait(50);
    a.ctl().enqueue(new Uint8Array(10).fill(0x42));
    a.ctl().close(); // size mismatch → verification fails

    const ra = await pa;
    expect(ra.success).toBe(false);
    expect(await pb).toEqual(ra);
    expect(setupFetches()).toBe(1);

    await install();
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it('install during an in-flight download opens nothing, even with an earlier verified installer', async () => {
    const first  = gated();
    const second = gated();
    serve([first.stream, second.stream]);

    const p1 = download();
    await wait(50);
    first.ctl().enqueue(INSTALLER);
    first.ctl().close();
    expect((await p1).success).toBe(true);

    const p2 = download(); // rewrites the same file
    await wait(50);
    second.ctl().enqueue(new Uint8Array(10).fill(0x42));
    await wait(50);

    await install();
    expect(h.openPath).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();

    second.ctl().enqueue(INSTALLER.subarray(10));
    second.ctl().close(); // wrong bytes overall → fails, nothing verified
    expect((await p2).success).toBe(false);
    await install();
    expect(h.openPath).not.toHaveBeenCalled();
  });
});

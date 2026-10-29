/** Adversarial 5.4: install provenance, verification edges, launch outcomes (no network, temp dir only). */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createHash} from 'crypto';
import {existsSync, mkdtempSync, rmSync} from 'fs';
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
const sha256       = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const HEX          = sha256(INSTALLER);

interface Asset {name: string; browser_download_url: string; size?: unknown; digest?: unknown}
const setupAsset = (over: Partial<Asset> = {}): Asset => ({
  name: 'TLI.Tracker.Setup.2.0.0.exe', browser_download_url: SETUP_URL, size: INSTALLER.length, digest: `sha256:${HEX}`, ...over,
});

/** `net.fetch`: the release JSON for the API, `body` for the Setup asset. */
function serve(assets: Asset[], body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array> = INSTALLER): void {
  h.fetch.mockImplementation(async (url: string) => {
    if (url === API_URL) {
      return new Response(JSON.stringify({tag_name: 'v2.0.0', body: 'notes', html_url: '', assets}));
    }
    if (url === SETUP_URL) return new Response(body);
    throw new Error(`unexpected fetch ${url}`);
  });
}

let updater: typeof import('@/main/updater');
const dest = () => join(h.temp, 'TLI-Tracker-Setup.exe');
const check    = () => h.handle.get('updater:check')!({}) as Promise<unknown>;
const download = () => h.handle.get('updater:download')!({}) as Promise<{success: boolean; error?: string}>;
/** `updater:install` is fire-and-forget (`ipcMain.on`); let the openPath promise settle. */
const install  = async (...args: unknown[]) => {
  h.on.get('updater:install')!({}, ...args);
  await new Promise(r => setTimeout(r, 0));
};

beforeEach(async () => {
  vi.clearAllMocks();
  h.handle.clear();
  h.on.clear();
  h.temp = mkdtempSync(join(tmpdir(), 'tli-updater-test-'));
  h.openPath.mockResolvedValue('');
  vi.resetModules(); // fresh module state: no installer verified yet
  updater = await import('@/main/updater');
  const {registerUpdaterHandlers} = await import('@/main/ipc/updater');
  registerUpdaterHandlers(() => null);
});

afterEach(() => {
  rmSync(h.temp, {recursive: true, force: true});
});


const exe = (n: number, fill = 0x41) => new Uint8Array(n).fill(fill);
const bodyOf = (b: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) => new Response(b, {headers});
const release = (assets: Asset[]) => JSON.stringify({tag_name: 'v2.0.0', body: '', html_url: '', assets});

describe('install provenance', () => {
  it('install before any download → nothing opened, no quit', async () => {
    await install();
    expect(h.openPath).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
  });

  it('install with an object / array / string payload is ignored (no path from the renderer)', async () => {
    await install({path: 'C:\\evil.exe'}, ['x'], 'calc.exe');
    expect(h.openPath).not.toHaveBeenCalled();
    serve([setupAsset()]);
    await download();
    await install({installerPath: 'C:\\evil.exe'}, '..\\..\\evil.exe');
    expect(h.openPath).toHaveBeenCalledTimes(1);
    expect(h.openPath).toHaveBeenCalledWith(dest());
  });

  it('verified download followed by a failing one: the first path is no longer launchable, file gone', async () => {
    serve([setupAsset()]);
    expect((await download()).success).toBe(true);
    serve([setupAsset()], exe(INSTALLER.length));
    expect((await download()).success).toBe(false);
    expect(existsSync(dest())).toBe(false);
    await install();
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it('a download answered with HTTP 500 also forgets the earlier verified installer', async () => {
    serve([setupAsset()]);
    await download();
    h.fetch.mockImplementation(async (url: string) =>
      url.includes('api.github.com') ? new Response(release([setupAsset()])) : new Response('no', {status: 500}));
    expect((await download()).success).toBe(false);
    await install();
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it('a failed re-check leaves the earlier verified installer (untouched on disk) launchable', async () => {
    serve([setupAsset()]);
    await download();
    h.fetch.mockRejectedValue(new Error('offline'));
    expect((await download()).success).toBe(false);
    expect(existsSync(dest())).toBe(true);
    await install();
    expect(h.openPath).toHaveBeenCalledWith(dest());
  });
});

describe('verification edges', () => {
  it('size off by one (one byte short / one byte long) → rejected, file deleted', async () => {
    for (const delta of [-1, 1]) {
      serve([setupAsset({size: INSTALLER.length + delta})]);
      expect((await download()).success).toBe(false);
      expect(existsSync(dest())).toBe(false);
    }
    await install();
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it('empty body → rejected, nothing installable', async () => {
    serve([setupAsset()], new Uint8Array(0));
    expect((await download()).success).toBe(false);
    expect(existsSync(dest())).toBe(false);
    await install();
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ['sha1 algo', `sha1:${HEX.slice(0, 40)}`],
    ['63 hex', `sha256:${HEX.slice(0, 63)}`],
    ['65 hex', `sha256:${HEX}a`],
    ['leading space', ` sha256:${HEX}`],
    ['trailing newline', `sha256:${HEX}\n`],
    ['no prefix', HEX],
    ['non-hex char', `sha256:${'g'.repeat(64)}`],
    ['number', 123],
    ['null', null],
  ])('digest %s → no hash, never throws', (_n, digest) => {
    expect(updater.parseSha256Digest(digest)).toBeNull();
  });

  it('`sha256:` + UPPERCASE hex is accepted and verifies end to end', async () => {
    serve([setupAsset({digest: `sha256:${HEX.toUpperCase()}`})]);
    expect((await download()).success).toBe(true);
  });

  it.each<[string, unknown]>([
    ['missing', undefined], ['zero', 0], ['negative', -5], ['float', 1.5], ['string', '100'], ['NaN', NaN],
  ])('asset size %s → no update offered, download refused', async (_n, size) => {
    serve([setupAsset({size})]);
    expect(await check()).toBeNull();
    expect((await download()).success).toBe(false);
  });

  it.each<[string, Record<string, string>]>([
    ['larger', {'content-length': '999999999'}],
    ['smaller', {'content-length': '3'}],
    ['absent', {}],
    ['garbage', {'content-length': 'abc'}],
  ])('lying content-length (%s) is irrelevant: the real body is verified', async (_n, headers) => {
    h.fetch.mockImplementation(async (url: string) =>
      url.includes('api.github.com')
        ? new Response(release([setupAsset()]))
        : bodyOf(INSTALLER as Uint8Array<ArrayBuffer>, headers));
    expect((await download()).success).toBe(true);
  });

  it('tampered body of the declared size still fails the hash', async () => {
    h.fetch.mockImplementation(async (url: string) =>
      url.includes('api.github.com')
        ? new Response(release([setupAsset()]))
        : bodyOf(exe(INSTALLER.length), {'content-length': String(INSTALLER.length)}));
    expect((await download()).success).toBe(false);
    expect(existsSync(dest())).toBe(false);
  });
});

describe('launch outcomes', () => {
  beforeEach(async () => { serve([setupAsset()]); await download(); });

  it('openPath resolves an error string → logged, no quit; a retry can still succeed', async () => {
    h.openPath.mockResolvedValueOnce('Access is denied');
    await install();
    expect(h.quit).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalled();
    await install();
    expect(h.quit).toHaveBeenCalledTimes(1);
  });

  it('openPath rejects → no unhandled rejection, no quit', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    h.openPath.mockRejectedValueOnce(new Error('boom'));
    await install();
    await new Promise(r => setTimeout(r, 10));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
  });

  it('success → quit exactly once', async () => {
    await install();
    expect(h.quit).toHaveBeenCalledTimes(1);
  });
});

describe('isNewer edges', () => {
  it.each<[string, string, boolean]>([
    ['1.2.3', 'v1.2.3-beta', false],
    ['1.2.3', 'v1.2.4-beta', false], // NaN patch: not newer, same as the old parse
    ['1.0',   '1.0.1',       true],
    ['1',     '1.0.0',       false],
    ['1.0.0', 'v2',          true],
    ['1.0.0', 'latest',      false],
    ['1.0.0', '',            false],
  ])('isNewer(%s, %s) = %s', (base, candidate, expected) => {
    expect(updater.isNewer(base, candidate)).toBe(expected);
  });
});

/**
 * 5.4: the updater downloads the Setup asset, checks it against GitHub's
 * per-asset `size` + `digest`, and main alone remembers the verified file —
 * `updater:install` takes no path from the renderer and opens it via
 * `shell.openPath` (no cmd.exe). No network: `net.fetch` serves fakes; the
 * installer lands in a fresh dir under the OS temp dir.
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createHash} from 'crypto';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'fs';
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
const PORTABLE_URL = 'https://example.invalid/TLI.Tracker.Portable.exe';
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

describe('parseSha256Digest', () => {
  it('valid `sha256:<64 hex>` → the hex', () => {
    expect(updater.parseSha256Digest(`sha256:${HEX}`)).toBe(HEX);
  });

  it('uppercase hex is accepted and normalised to lowercase; the algorithm prefix is not case-folded', () => {
    expect(updater.parseSha256Digest(`sha256:${HEX.toUpperCase()}`)).toBe(HEX);
    expect(updater.parseSha256Digest(`SHA256:${HEX}`)).toBeNull();
  });

  it.each([
    ['sha512',  `sha512:${HEX}${HEX}`],
    ['sha1',    'sha1:da39a3ee5e6b4b0d3255bfef95601890afd80709'],
    ['md5',     `md5:${HEX.slice(0, 32)}`],
  ])('another algorithm (%s) → null', (_n, digest) => {
    expect(updater.parseSha256Digest(digest)).toBeNull();
  });

  it.each([
    ['63 hex',           `sha256:${HEX.slice(1)}`],
    ['65 hex',           `sha256:${HEX}0`],
    ['a non-hex char',   `sha256:${HEX.slice(1)}g`],
    ['trailing newline', `sha256:${HEX}\n`],
    ['leading space',    ` sha256:${HEX}`],
    ['no hex',           'sha256:'],
    ['no prefix',        HEX],
    ['empty',            ''],
  ])('malformed (%s) → null', (_n, digest) => {
    expect(updater.parseSha256Digest(digest)).toBeNull();
  });

  it.each([undefined, null, 42, {}, [`sha256:${HEX}`]])('missing / not a string (%s) → null', digest => {
    expect(updater.parseSha256Digest(digest)).toBeNull();
  });
});

describe('checkForUpdate', () => {
  it('keeps the Setup asset\'s size and sha256 (not another asset\'s); the renderer gets only UpdateInfo', async () => {
    serve([
      {name: 'TLI.Tracker.Portable.exe', browser_download_url: PORTABLE_URL, size: 1, digest: `sha256:${'0'.repeat(64)}`},
      setupAsset(),
    ]);
    expect(await updater.checkForUpdate()).toEqual({
      version: 'v2.0.0', changelog: 'notes', downloadUrl: SETUP_URL, expected: {size: INSTALLER.length, sha256: HEX},
    });
    expect(await check()).toEqual({version: 'v2.0.0', changelog: 'notes', downloadUrl: SETUP_URL});
  });

  it('an asset without a usable digest → sha256 null (still offered)', async () => {
    serve([setupAsset({digest: undefined})]);
    expect((await updater.checkForUpdate())?.expected).toEqual({size: INSTALLER.length, sha256: null});
  });

  it.each([undefined, 0, -5, 1.5, '1984', NaN])('an asset with no valid size (%s) → no update, warned', async size => {
    serve([setupAsset({size})]);
    expect(await updater.checkForUpdate()).toBeNull();
    expect(h.warn).toHaveBeenCalledWith('update', expect.stringMatching(/no valid size/));
  });
});

describe('download verification', () => {
  it('size + sha256 match → success; the file stays and install opens it', async () => {
    serve([setupAsset()]);
    expect(await download()).toEqual({success: true});
    expect(new Uint8Array(readFileSync(dest()))).toEqual(INSTALLER);
    await install();
    expect(h.openPath).toHaveBeenCalledWith(dest());
    expect(h.quit).toHaveBeenCalledTimes(1);
  });

  it('size mismatch → failure, file deleted, nothing to install', async () => {
    serve([setupAsset({size: INSTALLER.length + 1})]);
    const res = await download();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/size mismatch/);
    expect(existsSync(dest())).toBe(false);
    await install();
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it('sha256 mismatch (same size, different bytes) → failure, file deleted, nothing to install', async () => {
    const tampered = INSTALLER.slice();
    tampered[10] ^= 0xff;
    serve([setupAsset()], tampered);
    const res = await download();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/sha256 mismatch/);
    expect(existsSync(dest())).toBe(false);
    await install();
    expect(h.openPath).not.toHaveBeenCalled();
  });

  it('no digest → size-only check passes with a warning; install opens it', async () => {
    serve([setupAsset({digest: 'sha512:abc'})]);
    expect(await download()).toEqual({success: true});
    expect(h.warn).toHaveBeenCalledWith('update', expect.stringMatching(/no sha256 digest.*size only/));
    await install();
    expect(h.openPath).toHaveBeenCalledWith(dest());
  });

  it('no digest still enforces the size', async () => {
    serve([setupAsset({digest: undefined, size: 3})]);
    expect((await download()).success).toBe(false);
    expect(existsSync(dest())).toBe(false);
  });

  it('a stream that fails mid-download → failure, partial file deleted', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(INSTALLER.subarray(0, 100)); c.error(new Error('connection reset')); },
    });
    serve([setupAsset()], broken);
    const res = await download();
    expect(res).toEqual({success: false, error: 'Error: connection reset'});
    expect(existsSync(dest())).toBe(false);
  });

  it('a later failed download forgets the earlier verified installer', async () => {
    serve([setupAsset()]);
    expect((await download()).success).toBe(true);
    serve([setupAsset({size: 1})]);
    expect((await download()).success).toBe(false);
    await install();
    expect(h.openPath).not.toHaveBeenCalled();
  });
});

describe('updater:install', () => {
  it('without a verified download: a renderer-supplied path is ignored — nothing opened, no quit, warned', async () => {
    await install('C:\\Windows\\System32\\cmd.exe');
    expect(h.openPath).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith('update', expect.stringMatching(/without a verified download/));
  });

  it('after a verified download: opens main\'s file, never the path the renderer sent', async () => {
    serve([setupAsset()]);
    await download();
    await install('C:\\evil.exe & calc');
    expect(h.openPath).toHaveBeenCalledTimes(1);
    expect(h.openPath).toHaveBeenCalledWith(dest());
  });

  it('openPath reports an error → logged, the app does not quit', async () => {
    serve([setupAsset()]);
    await download();
    h.openPath.mockResolvedValue('The operation was canceled by the user.');
    await install();
    expect(h.quit).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith('update', 'Could not launch installer: The operation was canceled by the user.');
  });

  it('openPath rejects → logged, the app does not quit', async () => {
    serve([setupAsset()]);
    await download();
    h.openPath.mockRejectedValue(new Error('boom'));
    await install();
    expect(h.quit).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalledWith('update', expect.stringMatching(/^Could not launch installer: Error: boom/));
  });
});

describe('isNewer (the one copy)', () => {
  it.each<[string, string, boolean]>([
    ['1.0.0',  'v1.0.1', true],
    ['v1.2.0', '1.10.0', true],
    ['1.0.0',  '1.0.0',  false],
    ['2.0.0',  '1.9.9',  false],
    ['0.0.0',  '0.19.0', true],
  ])('isNewer(%s, %s) = %s', (base, candidate, expected) => {
    expect(updater.isNewer(base, candidate)).toBe(expected);
  });
});

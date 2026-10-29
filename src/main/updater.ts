import {app, net, shell} from 'electron';
import {createReadStream, createWriteStream, statSync, unlinkSync} from 'fs';
import {createHash} from 'crypto';
import {pipeline} from 'stream/promises';
import {join} from 'path';
import {log} from './logger';
import type {UpdateInfo} from '@/shared/contracts/api';
import {describeError} from '@/shared/describe-error';

export const REPO = 'StanTheIV/TLI-WealthTracker';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

interface GitHubRelease {
  tag_name: string;
  body:     string;
  html_url: string;
  assets:   Array<{name: string; browser_download_url: string; size?: unknown; digest?: unknown}>;
}

/** What the installer download must match: GitHub's per-asset `size` and `digest`. */
export interface ExpectedInstaller {
  size:   number;
  /** Lowercase hex; null when the release asset carries no usable sha256 digest. */
  sha256: string | null;
}

/** A newer release as main sees it — the renderer only ever gets the `UpdateInfo` part. */
export interface AvailableUpdate extends UpdateInfo {
  expected: ExpectedInstaller;
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/** True when `candidate` is a strictly higher `major.minor.patch` than `base` (a leading `v` is ignored). */
export function isNewer(base: string, candidate: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const b = parse(base);
  const c = parse(candidate);
  for (let i = 0; i < 3; i++) {
    if ((c[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((c[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/**
 * GitHub's asset `digest` is `sha256:<64 hex>`. Anything else (another
 * algorithm, malformed, missing) → null. Hex case is normalised to lowercase.
 */
export function parseSha256Digest(digest: unknown): string | null {
  if (typeof digest !== 'string') return null;
  const m = /^sha256:([0-9a-fA-F]{64})$/.exec(digest);
  return m ? m[1].toLowerCase() : null;
}

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  try {
    const res = await net.fetch(API_URL, {
      headers: {'User-Agent': 'TLI-Tracker'},
    });
    if (!res.ok) {
      log.warn('update', `GitHub API returned ${res.status}`);
      return null;
    }

    const data = (await res.json()) as GitHubRelease;
    const current = app.getVersion();

    if (!isNewer(current, data.tag_name)) {
      log.debug('update', `Up to date (${current})`);
      return null;
    }

    const setupAsset = data.assets.find(a => /setup/i.test(a.name) && a.name.endsWith('.exe'));
    if (!setupAsset) {
      log.warn('update', 'No Setup .exe found in release assets');
      return null;
    }
    const size = setupAsset.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
      log.warn('update', `Setup asset ${setupAsset.name} has no valid size — not offering the update`);
      return null;
    }

    log.info('update', `Update available: ${current} → ${data.tag_name}`);
    return {
      version:     data.tag_name,
      changelog:   data.body ?? '',
      downloadUrl: setupAsset.browser_download_url,
      expected:    {size, sha256: parseSha256Digest(setupAsset.digest)},
    };
  } catch (err) {
    log.warn('update', `Update check failed: ${describeError(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetch changelog for a specific version (used after update)
// ---------------------------------------------------------------------------

export async function fetchChangelog(version: string): Promise<string | null> {
  try {
    const tag = version.startsWith('v') ? version : `v${version}`;
    const url = `https://api.github.com/repos/${REPO}/releases/tags/${tag}`;
    const res = await net.fetch(url, {
      headers: {'User-Agent': 'TLI-Tracker'},
    });
    if (!res.ok) return null;
    const data = (await res.json()) as GitHubRelease;
    return data.body ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Download + verification
// ---------------------------------------------------------------------------

/**
 * The installer that passed verification in this app run — the only file
 * `launchInstallerAndQuit` will ever open. Never taken from a renderer.
 */
let verifiedInstaller: string | null = null;

/**
 * Checks the file on disk against the release asset: size always, sha256 when
 * the asset had a digest (otherwise warns — size only). Throws on mismatch.
 */
export async function verifyInstaller(path: string, expected: ExpectedInstaller): Promise<void> {
  const size = statSync(path).size;
  if (size !== expected.size) {
    throw new Error(`Installer size mismatch: expected ${expected.size} bytes, got ${size}`);
  }
  if (expected.sha256 === null) {
    log.warn('update', 'Release asset has no sha256 digest — installer not verified (size only)');
    return;
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const actual = hash.digest('hex');
  if (actual !== expected.sha256) {
    throw new Error(`Installer sha256 mismatch: expected ${expected.sha256}, got ${actual}`);
  }
}

/** The one download allowed at a time — every download writes the same temp file. */
let inFlight: Promise<void> | null = null;

/**
 * Streams the installer to the temp dir and verifies it. On success main
 * remembers the path for `launchInstallerAndQuit`; on any failure the file is
 * deleted and the error rethrown. A call made while a download runs joins it
 * (same promise, same outcome); its `onProgress` is ignored.
 */
export function downloadUpdate(
  update: AvailableUpdate,
  onProgress?: (pct: number) => void,
): Promise<void> {
  if (inFlight) {
    log.info('update', 'Download already in progress — joining it');
    return inFlight;
  }
  const run = streamAndVerify(update, onProgress).finally(() => { inFlight = null; });
  inFlight = run;
  return run;
}

async function streamAndVerify(
  update: AvailableUpdate,
  onProgress?: (pct: number) => void,
): Promise<void> {
  verifiedInstaller = null; // the file below is about to be overwritten
  const dest = join(app.getPath('temp'), 'TLI-Tracker-Setup.exe');

  const res = await net.fetch(update.downloadUrl, {
    headers: {'User-Agent': 'TLI-Tracker'},
  });
  const body = res.body;
  if (!res.ok || !body) throw new Error(`Download failed: ${res.status}`);

  const total = Number(res.headers.get('content-length') ?? 0) || update.expected.size;
  let received = 0;

  const writer = createWriteStream(dest);
  try {
    await pipeline(
      async function* () {
        const reader = body.getReader();
        for (;;) {
          const {done, value} = await reader.read();
          if (done) return;
          received += value.byteLength;
          if (onProgress) onProgress(Math.round((received / total) * 100));
          yield value;
        }
      },
      writer,
    );
    await verifyInstaller(dest, update.expected);
  } catch (err) {
    // A destroyed writer may still be opening the file: unlink only once it has closed
    // (`events.once` would reject on the writer's own 'error' and skip the unlink).
    if (!writer.closed) await new Promise<void>(resolve => writer.once('close', () => resolve()));
    try { unlinkSync(dest); } catch { /* ignore */ }
    throw err;
  }

  verifiedInstaller = dest;
  log.info('update', `Downloaded and verified installer at ${dest}`);
}

// ---------------------------------------------------------------------------
// Launch installer & quit
// ---------------------------------------------------------------------------

/**
 * Opens the verified installer the way Explorer would (ShellExecute — no
 * cmd.exe, and a per-machine NSIS installer can raise UAC), then quits. No
 * verified download → nothing happens; an open failure → logged, app stays up.
 */
export async function launchInstallerAndQuit(): Promise<void> {
  const path = verifiedInstaller;
  if (!path) {
    log.warn('update', 'Install requested without a verified download — ignored');
    return;
  }
  log.info('update', `Launching installer: ${path}`);
  const error = await shell.openPath(path).catch(describeError);
  if (error) {
    log.error('update', `Could not launch installer: ${error}`);
    return;
  }
  app.quit();
}

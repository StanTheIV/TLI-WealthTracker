import {app, net} from 'electron';
import {createWriteStream, unlinkSync} from 'fs';
import {join} from 'path';
import {spawn} from 'child_process';
import {log} from './logger';

const REPO = 'StanTheIV/TLI-WealthTracker';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface UpdateInfo {
  version:     string;
  changelog:   string;
  downloadUrl: string;
}

interface GitHubRelease {
  tag_name: string;
  body:     string;
  html_url: string;
  assets:   Array<{name: string; browser_download_url: string}>;
}

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

function isNewer(current: string, remote: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const c = parse(current);
  const r = parse(remote);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

export async function checkForUpdate(): Promise<UpdateInfo | null> {
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

    log.info('update', `Update available: ${current} → ${data.tag_name}`);
    return {
      version:     data.tag_name,
      changelog:   data.body ?? '',
      downloadUrl: setupAsset.browser_download_url,
    };
  } catch (err) {
    log.warn('update', `Update check failed: ${err}`);
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
// Download
// ---------------------------------------------------------------------------

export async function downloadUpdate(
  url: string,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const dest = join(app.getPath('temp'), 'TLI-Tracker-Setup.exe');

  const res = await net.fetch(url, {
    headers: {'User-Agent': 'TLI-Tracker'},
  });
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);

  const total = Number(res.headers.get('content-length') ?? 0);
  let received = 0;

  const writer = createWriteStream(dest);
  const reader = res.body.getReader();

  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      writer.write(value);
      received += value.byteLength;
      if (total > 0 && onProgress) {
        onProgress(Math.round((received / total) * 100));
      }
    }
  } catch (err) {
    writer.close();
    try { unlinkSync(dest); } catch { /* ignore */ }
    throw err;
  }

  await new Promise<void>((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
    writer.end();
  });

  log.info('update', `Downloaded installer to ${dest}`);
  return dest;
}

// ---------------------------------------------------------------------------
// Launch installer & quit
// ---------------------------------------------------------------------------

export function launchInstallerAndQuit(installerPath: string): void {
  log.info('update', `Launching installer: ${installerPath}`);
  spawn(installerPath, [], {detached: true, stdio: 'ignore', shell: true}).unref();
  app.quit();
}

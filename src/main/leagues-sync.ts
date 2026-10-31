import {net} from 'electron';
import {log} from './logger';
import {leaguesGetAll, leaguesApply, priceBackfillOnce} from './db';
import type {Broadcast} from './broadcast';
import {REPO} from './updater';
import {mergeLeagues, parseLeaguesJson} from '@/lib/leagues';
import {describeError} from '@/shared/describe-error';
import bundledLeagues from '../../resources/leagues.json';

const REMOTE_URL = `https://raw.githubusercontent.com/${REPO}/main/resources/leagues.json`;

/** Merge official rows into the DB. Returns true when anything changed. */
function applyOfficial(json: unknown, source: 'bundled' | 'remote'): boolean {
  const official = parseLeaguesJson(json, source);
  if (official.length === 0) return false;
  const change = mergeLeagues(leaguesGetAll(), official);
  if (change.upserts.length === 0 && change.deletes.length === 0) return false;
  leaguesApply(change);
  log.info('price', `Applied ${source} leagues: ${change.upserts.length} upserted, ${change.deletes.length} deleted`);
  return true;
}

async function syncRemote(broadcast: Broadcast): Promise<void> {
  try {
    const res = await net.fetch(REMOTE_URL, {
      headers: {'User-Agent': 'TLI-Tracker'},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn('price', `Remote leagues.json returned ${res.status}`);
      return;
    }
    if (applyOfficial(await res.json(), 'remote')) broadcast('leagues:changed');
  } catch (err) {
    log.warn('price', `Remote leagues sync failed: ${describeError(err)}`);
  }
}

/** Startup: bundled leagues, one-time price backfill, then a fire-and-forget remote refresh. */
export function initLeaguesAndPriceHistory(broadcast: Broadcast): void {
  try {
    applyOfficial(bundledLeagues, 'bundled');
  } catch (err) {
    log.error('price', `Bundled leagues merge failed: ${describeError(err)}`);
  }
  try {
    const r = priceBackfillOnce();
    if (!r.skipped) log.info('price', `Backfill complete: ${r.inserted} rows`);
  } catch (err) {
    log.error('price', `Price backfill failed: ${describeError(err)}`);
  }
  void syncRemote(broadcast);
}

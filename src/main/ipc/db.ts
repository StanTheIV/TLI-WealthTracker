import {ipcMain} from 'electron';
import {log} from '@/main/logger';
import {
  settingsGetAll, settingsSet,
  itemsGetAll, itemsSetName, itemsSetType, priceRecord, itemsSetLocked, itemsImportBatch,
  leaguesGetAll, leaguesInsertUser, leaguesSetStart, pricesHistory, pricesMovers, pricesExport,
  wealthGetRange, wealthGetLatest, wealthDelete, wealthClear,
  getLookupCountToday, recordLookup,
  filtersGetAll, filtersInsert, filtersUpdate, filtersDelete, filtersSetEnabled,
} from '@/main/db';
import type {DbItem} from '@/shared/contracts/db';
import type {SqliteSessionStore} from '@/main/db/session-store';
import type {Broadcast} from '@/main/broadcast';
import type {TrackingService} from '@/main/tracking-service';

interface RegisterDeps {
  /** Fan-out to both renderer windows (items:changed, leagues:changed). */
  broadcast:        Broadcast;
  sessions:         SqliteSessionStore;
  /** The tracking run — guards writes that would pull the live session out from under it. */
  tracking:         Pick<TrackingService, 'deleteSession' | 'isTracking'>;
  /** Notify the engine that an item's type changed so its filter cache stays in sync. */
  onItemTypeChanged?: (id: string, type: string) => void;
}

export function registerDbHandlers(deps: RegisterDeps): void {
  const {broadcast} = deps;
  ipcMain.handle('db:settings:get-all',  ()               => settingsGetAll());
  ipcMain.handle('db:settings:set',      (_e, k, v)       => settingsSet(k, v));

  ipcMain.handle('db:items:get-all',     ()               => itemsGetAll());
  ipcMain.handle('db:items:set-name',    (_e, id: string, name: string)   => {
    itemsSetName(id, name);
    broadcast('items:changed', {id, changes: {name}});
  });
  ipcMain.handle('db:items:set-type',    (_e, id: string, type: string)   => {
    itemsSetType(id, type);
    broadcast('items:changed', {id, changes: {type}});
    deps.onItemTypeChanged?.(id, type);
  });
  ipcMain.handle('db:items:set-price',   (_e, id: string, price: number)  => {
    const {priceDate} = priceRecord(id, 'manual', price, undefined, {updateItem: true});
    broadcast('items:changed', {id, changes: {price, ...(priceDate !== null && {priceDate})}});
  });
  ipcMain.handle('db:items:set-locked',  (_e, id: string, locked: boolean) => {
    itemsSetLocked(id, locked);
    broadcast('items:changed', {id, changes: {locked}});
  });
  ipcMain.handle('db:items:lookup-name',  async (_e, id: string) => {
    const result = await lookupName(id);
    if ('name' in result || 'type' in result) {
      // Persist whatever we found and broadcast the patch so all renderers
      // (including the overlay) update without an extra round-trip.
      const changes: Partial<Omit<DbItem, 'id'>> = {};
      if (result.name) {
        itemsSetName(id, result.name);
        changes.name = result.name;
      }
      if (result.type && result.type !== 'other') {
        itemsSetType(id, result.type);
        changes.type = result.type;
        deps.onItemTypeChanged?.(id, result.type);
      }
      if (Object.keys(changes).length > 0) broadcast('items:changed', {id, changes});
    }
    return result;
  });
  ipcMain.handle('db:items:import-batch',       (_e, items: DbItem[])     => {
    const insertedIds = new Set(itemsImportBatch(items));
    // Bulk import: broadcast per-item so each renderer can patch incrementally.
    // Rows skipped by INSERT OR IGNORE keep their DB values, so they're not broadcast.
    for (const item of items) {
      if (!insertedIds.has(item.id)) continue;
      broadcast('items:changed', {id: item.id, changes: {name: item.name, type: item.type, price: item.price, priceDate: item.priceDate}});
    }
    return insertedIds.size;
  });

  ipcMain.handle('db:leagues:get-all',   ()               => leaguesGetAll());
  ipcMain.handle('db:leagues:start-now', (_e, name?: string) => {
    const trimmed = typeof name === 'string' ? name.trim().slice(0, 100) : '';
    const league = leaguesInsertUser(trimmed || 'New league', Date.now());
    broadcast('leagues:changed');
    return league;
  });
  ipcMain.handle('db:leagues:set-start', (_e, id: string, ts: number) => {
    if (typeof id !== 'string' || !Number.isFinite(ts)) return false;
    const changed = leaguesSetStart(id, ts);
    if (changed) broadcast('leagues:changed');
    return changed;
  });

  ipcMain.handle('db:prices:history', (_e, itemId: string, from: number, to: number) => pricesHistory(String(itemId), from, to));
  ipcMain.handle('db:prices:movers',  (_e, from: number, to: number)                  => pricesMovers(from, to));
  ipcMain.handle('db:prices:export',  (_e, from: number, to: number)                  => pricesExport(from, to));

  const {sessions, tracking} = deps;
  ipcMain.handle('db:sessions:get-all',  ()                      => sessions.listSessions());
  // Through the service: it refuses (rejects the invoke for) the active session.
  ipcMain.handle('db:sessions:delete',   (_e, id: string)        => tracking.deleteSession(id));
  ipcMain.handle('db:sessions:rename',   (_e, id: string, name: string) => sessions.renameSession(id, name));
  ipcMain.handle('db:session-maps:get-for-session', (_e, sessionId: string) => sessions.getRows(sessionId));

  ipcMain.handle('db:wealth:get-range',  (_e, from, to)   => wealthGetRange(from, to));
  ipcMain.handle('db:wealth:get-latest', (_e, limit)      => wealthGetLatest(limit));
  ipcMain.handle('db:wealth:delete',     (_e, id)         => wealthDelete(id));
  ipcMain.handle('db:wealth:clear',      ()               => {
    // Clearing all history would delete the live session under the run.
    if (tracking.isTracking()) throw new Error('Cannot clear all data while tracking');
    wealthClear();
  });

  ipcMain.handle('db:lookups:get-today', ()               => getLookupCountToday());

  ipcMain.handle('db:filters:get-all',    ()                        => filtersGetAll());
  ipcMain.handle('db:filters:insert',     (_e, filter)              => filtersInsert(filter));
  ipcMain.handle('db:filters:update',     (_e, filter)              => filtersUpdate(filter));
  ipcMain.handle('db:filters:delete',     (_e, id: string)          => filtersDelete(id));
  ipcMain.handle('db:filters:set-enabled',(_e, id: string, enabled: boolean) => filtersSetEnabled(id, enabled));

  log.debug('ipc', 'DB handlers registered');
}

// ---------------------------------------------------------------------------
// Item name lookup via Serper (Google Search)
// ---------------------------------------------------------------------------

async function lookupName(id: string): Promise<{name?: string | null; type?: string | null; error?: string; lookupsToday: number}> {
  const apiKey = settingsGetAll()['serper_api_key'];
  if (!apiKey) return {error: 'no_api_key', lookupsToday: getLookupCountToday()};

  const count = getLookupCountToday();
  if (count >= 500) return {error: 'limit_reached', lookupsToday: count};

  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {'X-API-KEY': apiKey, 'Content-Type': 'application/json'},
    body: JSON.stringify({q: `site:tlidb.com ${id}`, num: 5}),
  });

  if (!res.ok) return {error: 'api_error', lookupsToday: count};

  const data = await res.json() as {
    organic?: {title: string; link: string; snippet: string}[];
  };

  recordLookup(id);
  const lookupsToday = count + 1;

  const results = data.organic ?? [];
  if (results.length === 0) return {name: null, type: null, lookupsToday};

  // Prefer English page (no language prefix), then any result with id in snippet
  const LANG_PREFIX = /^https:\/\/tlidb\.com\/[a-z]{2}\//;
  const englishResults = results.filter(r => !LANG_PREFIX.test(r.link));
  const pool = englishResults.length > 0 ? englishResults : results;
  const best = pool.find(r => r.snippet.includes(`ID: ${id}`) || r.snippet.includes(`id: ${id}`)) ?? pool[0];

  // Derive name from URL slug — reliable across all locales
  const rawSlug = best.link.replace(/^https?:\/\/tlidb\.com\/(?:[a-z]{2}\/)?/, '');
  const name = decodeURIComponent(rawSlug).replace(/_/g, ' ').trim();

  // Fetch the tlidb page to extract the item type
  const itemType = await lookupTypeFromPage(best.link);
  log.info('database', `Lookup: id=${id} -> "${name}", type="${itemType ?? 'null'}" (${lookupsToday}/500)`);

  return {name: name || null, type: itemType, lookupsToday};
}

// ---------------------------------------------------------------------------
// Scrape item type from a tlidb.com item page
// Maps tlidb tag/banner patterns to our ItemType keys
// ---------------------------------------------------------------------------

// tlidb uses bannerskill for skills; the first tag inside the banner indicates
// more granular type. We map known skill-banner items to 'skill', and map
// the first tag text for non-skill items.
const TLIDB_TAG_TO_TYPE: Record<string, string> = {
  fuel:              'fuel',
  'corrosion material': 'fuel',
  'equipment material': 'fuel',
  'erosion material':   'fuel',
  'overlay material':   'fuel',
  'tower material':     'fuel',
  ember:             'ember',
  'remembrance material': 'ember',
  compass:           'compass',
  'dream material':  'dream',
  'cube material':        'cube',
  'magic cube material':  'cube',
  'statue of the new god': 'cube',
  'memory fluorescence': 'card',
};

const SKILL_TAGS = new Set(['spell', 'attack', 'support', 'warcry', 'Activation Medium', 'aura']);

async function lookupTypeFromPage(url: string): Promise<string | null> {
  try {
    const pageRes = await fetch(url, {
      headers: {'User-Agent': 'Mozilla/5.0 (compatible; TLI-Tracker/1.0)'},
      signal: AbortSignal.timeout(5000),
    });
    if (!pageRes.ok) return null;
    const html = await pageRes.text();

    // Equipment: icon src path contains /Equip as a path segment (e.g. /EquipCommon/, /EquipArmor/)
    if (/cdn\.tlidb\.com\/[^"']*\/Equip[A-Za-z]+\/[^"']*\.webp/i.test(html)) return 'equipment';

    // Fluorescent Memory cards: icon src path contains /FateCard/
    if (/cdn\.tlidb\.com\/[^"']*\/FateCard\/[^"']*\.webp/i.test(html)) return 'card';

    // Compasses: icon src path contains /Compass/
    if (/cdn\.tlidb\.com\/[^"']*\/Compass\/[^"']*\.webp/i.test(html)) return 'compass';

    // Extract the first tag tlborder span text
    const tagMatch = html.match(/<span[^>]*\bclass="[^"]*\btag\b[^"]*\btlborder\b[^"]*"[^>]*>\s*([^<]+?)\s*<\/span>/i);
    if (tagMatch) {
      const tagText = tagMatch[1].replace(/\\n/g, '').trim().toLowerCase();
      if (SKILL_TAGS.has(tagText)) return 'skill';
      return TLIDB_TAG_TO_TYPE[tagText] ?? 'other';
    }

    return 'other';
  } catch {
    return null;
  }
}

import {ipcMain} from 'electron';
import {log} from '@/main/logger';
import {
  settingsGetAll, settingsSet,
  itemsGetAll, itemsUpsert, itemsSetName, itemsSetType, itemsSetPrice, itemsImportBatch,
  sessionsGetAll, sessionsInsert, sessionsUpdate, sessionsDelete, sessionsRename, sessionsGetOne,
  seasonalStatsGetAll, seasonalStatsUpsert,
  wealthInsert, wealthGetRange, wealthGetLatest,
  getLookupCountToday, recordLookup,
  filtersGetAll, filtersInsert, filtersUpdate, filtersDelete, filtersSetEnabled,
} from '@/main/db';

export function registerDbHandlers(): void {
  ipcMain.handle('db:settings:get-all',  ()               => settingsGetAll());
  ipcMain.handle('db:settings:set',      (_e, k, v)       => settingsSet(k, v));

  ipcMain.handle('db:items:get-all',     ()               => itemsGetAll());
  ipcMain.handle('db:items:upsert',      (_e, item)       => itemsUpsert(item));
  ipcMain.handle('db:items:set-name',    (_e, id, name)   => itemsSetName(id, name));
  ipcMain.handle('db:items:set-type',    (_e, id, type)   => itemsSetType(id, type));
  ipcMain.handle('db:items:set-price',   (_e, id, price)  => itemsSetPrice(id, price));
  ipcMain.handle('db:items:lookup-name',  async (_e, id: string) => lookupName(id));
  ipcMain.handle('db:items:import-batch',       (_e, items)     => itemsImportBatch(items));

  ipcMain.handle('db:sessions:get-all',  ()                      => sessionsGetAll());
  ipcMain.handle('db:sessions:insert',   (_e, session)           => sessionsInsert(session));
  ipcMain.handle('db:sessions:update',   (_e, session)           => sessionsUpdate(session));
  ipcMain.handle('db:sessions:delete',   (_e, id: string)        => sessionsDelete(id));
  ipcMain.handle('db:sessions:rename',   (_e, id: string, name: string) => sessionsRename(id, name));
  ipcMain.handle('db:sessions:get-one',  (_e, id: string)        => sessionsGetOne(id));

  ipcMain.handle('db:seasonal:get-all',  ()               => seasonalStatsGetAll());
  ipcMain.handle('db:seasonal:upsert',   (_e, stat)       => seasonalStatsUpsert(stat));

  ipcMain.handle('db:wealth:insert',     (_e, point)      => wealthInsert(point));
  ipcMain.handle('db:wealth:get-range',  (_e, from, to)   => wealthGetRange(from, to));
  ipcMain.handle('db:wealth:get-latest', (_e, limit)      => wealthGetLatest(limit));

  ipcMain.handle('db:lookups:today',     ()               => getLookupCountToday());

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

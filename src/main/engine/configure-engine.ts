import type {Engine} from './engine';
import type {FilterRule} from '@/types/itemFilter';
import {mapRawType} from '@/types/itemType';

export interface EngineSettingsInput {
  /** Every known item (id + raw type) — seeds `new_item` de-dup and the filter's type map. */
  items:       ReadonlyArray<{id: string; type: string}>;
  /** Rules of the enabled filter, or null when no filter is active. */
  filterRules: FilterRule[] | null;
  /** The raw settings table. */
  settings:    Record<string, string>;
}

/**
 * Apply persisted settings to a freshly started engine. Must run AFTER
 * `start()` — ctx.reset() wipes context state, including the filter and the
 * known-item set. Pure (no DB access) so the log replayer configures its
 * engine exactly like production does.
 */
export function configureEngine(engine: Engine, input: EngineSettingsInput): void {
  engine.setKnownItems(input.items.map(i => i.id));
  engine.setItemTypes(input.items.map(i => [i.id, mapRawType(i.type)] as const));
  engine.setFilterRules(input.filterRules);

  const s = input.settings;
  engine.setLowStockThreshold(parsePositiveInt(s['lowStockThreshold'], 0, /*allowZero*/ true));

  // Per-handler loot collection windows (ms). Default 5000, except the Sandlord
  // in-map wave window (10000) — it measures wave activity, not loot pickup.
  engine.setOverrealmLootDurationMs(parsePositiveInt(s['overrealmLootMs'], 5000, false));
  engine.setCarjackLootDurationMs(parsePositiveInt(s['carjackLootMs'], 5000, false));
  engine.setClockworkLootDurationMs(parsePositiveInt(s['clockworkLootMs'], 5000, false));
  engine.setLunariaLootDurationMs(parsePositiveInt(s['lunariaLootMs'], 5000, false));
  engine.setSandlordWaveDurationMs(parsePositiveInt(s['sandlordWaveMs'], 10000, false));
  engine.setHuntingLootDurationMs(parsePositiveInt(s['huntingLootMs'], 5000, false));
  engine.setAfterlightLootDurationMs(parsePositiveInt(s['afterlightLootMs'], 5000, false));
}

function parsePositiveInt(raw: string | undefined, fallback: number, allowZero: boolean): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (allowZero ? n < 0 : n <= 0) return fallback;
  return Math.floor(n);
}

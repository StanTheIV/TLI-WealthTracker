import type {Engine} from './engine';
import type {FilterRule} from '@/shared/item-filter';
import {mapRawType} from '@/shared/items';
import {parseSettings} from '@/shared/settings';

export interface EngineSettingsInput {
  /** Every known item (id + raw type) — seeds `new_item` de-dup and the filter's type map. */
  items:       ReadonlyArray<{id: string; type: string}>;
  /** Rules of the enabled filter, or null when no filter is active. */
  filterRules: FilterRule[] | null;
  /** The raw settings table; parsed here. */
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

  engine.configure(parseSettings(input.settings));
}

import type {RawEvent} from '@/worker/processors/types';
import type {EventHandler, EmitFn} from '@/main/engine/types';
import type {EngineContext} from '@/main/engine/context';

/**
 * PriceHandler — persists in-game market prices to the database and notifies the renderer.
 *
 * Receives `price_update` raw events from the PriceProcessor (worker) and:
 *   1. Writes the new price to the `items` SQLite table via an injected persist function.
 *   2. Emits a `price_update` EngineEvent so the renderer can update its in-memory cache.
 *
 * Intentionally ungated on engine phase — price lookups happen in town before/between
 * sessions and should always be captured.
 *
 * The persist function is injected rather than imported directly so that tests can
 * verify DB writes without loading the native `electron`/`better-sqlite3` modules.
 */
export class PriceHandler implements EventHandler {
  readonly name    = 'price';
  readonly handles = ['price_update'] as const;

  private readonly _persist: (id: string, price: number) => void;

  constructor(persist: (id: string, price: number) => void) {
    this._persist = persist;
  }

  handle(event: RawEvent, _ctx: EngineContext, emit: EmitFn): void {
    if (event.type !== 'price_update') return;

    this._persist(String(event.itemId), event.price);

    emit({type: 'price_update', itemId: event.itemId, price: event.price, timestamp: Date.now()});
  }
}

import type {Engine} from '@/main/engine/engine';
import {slotKey} from '@/main/engine/bag-state';
import type {EngineEvent} from '@/main/engine/types';
import type {RawEvent} from '@/worker/processors/types';

export type AnomalyKind =
  /** BagState's per-item totals disagree with the sum over its slots. */
  | 'bag-totals-inconsistent'
  /** After a bag dump settled, the engine's inventory differs from the dump. */
  | 'snapshot-mismatch'
  /** Two full bag dumps landed close enough together to share one debounce window. */
  | 'double-dump'
  /** One drop batch credited a large share of the whole inventory at once. */
  | 'mass-credit';

export interface Anomaly {
  kind:   AnomalyKind;
  ts:     number;
  /** Last log line delivered before the anomaly was detected. */
  lineNo: number | null;
  detail: string;
}

/** Window inside which a second dump would have merged into the first under
 *  the pre-fix 300 ms resort debounce. */
const DOUBLE_DUMP_MS = 300;
/** In log time, a dump is over once no `bag_init` arrived for this long. The
 *  game writes a dump's lines a few ms apart, and two dumps at least ~200 ms
 *  apart (each click waits on a server round trip). */
const DUMP_GAP_MS = 150;
/** Wait for every bag debounce (init 500 ms, resort 300 ms) before checking. */
const SETTLE_MS = 1000;
const MASS_CREDIT_MIN_ITEMS = 10;
const MASS_CREDIT_SHARE     = 0.5;

interface Dump {
  startLine: number;
  startTs:   number;
  endTs:     number;
  slots:     Map<string, {itemId: number; quantity: number}>;
}

/**
 * Watches a replay from the outside and flags states the engine must never
 * reach. It reconstructs bag dumps from raw `bag_init` events on its own —
 * by log-time gap, not the engine's marker — so it does not trust the code
 * under test.
 */
export class InvariantMonitor {
  readonly anomalies: Anomaly[] = [];

  private _dump: Dump | null = null;
  private _lastDump: Dump | null = null;
  /** True once a slot changed after the last dump — the dump no longer describes the bag. */
  private _bagMovedSinceDump = false;
  private _lastBagEventAt = -Infinity;
  private _dirty = false;

  private _creditAt = -1;
  private _creditItems = new Set<number>();
  private _creditLine: number | null = null;

  constructor(private readonly _getEngine: () => Engine | null) {}

  /** `logTs` is the line's own timestamp, not the (poll-batched) delivery time. */
  onRawEvent(event: RawEvent, logTs: number, lineNo: number): void {
    if (event.type === 'bag_init') {
      if (!this._dump || logTs - this._dump.endTs > DUMP_GAP_MS) {
        this._closeDump();
        this._dump = {startLine: lineNo, startTs: logTs, endTs: logTs, slots: new Map()};
      }
      this._dump.slots.set(slotKey(event.pageId, event.slotId), {itemId: event.itemId, quantity: event.quantity});
      this._dump.endTs = logTs;
      this._bagMovedSinceDump = false;
    } else if (event.type === 'bag_update' || event.type === 'bag_remove') {
      this._bagMovedSinceDump = true;
    } else {
      return;
    }
    this._lastBagEventAt = logTs;
    this._dirty = true;
  }

  onEngineEvent(event: EngineEvent, lineNo: number | null): void {
    if (event.type !== 'drop' || event.change <= 0) return;
    if (event.timestamp !== this._creditAt) this._closeCredit();
    this._creditAt = event.timestamp;
    this._creditLine = lineNo;
    this._creditItems.add(event.itemId);
  }

  /** Called after every clock advance. Runs the checks once the bag is quiet. */
  afterAdvance(now: number, lineNo: number | null): void {
    if (!this._dirty || now - this._lastBagEventAt < SETTLE_MS) return;
    this._dirty = false;
    this._closeDump();
    this._check(now, lineNo);
  }

  finish(now: number, lineNo: number | null): void {
    this._closeCredit();
    this._closeDump();
    if (this._dirty) this._check(now, lineNo);
  }

  private _closeDump(): void {
    const dump = this._dump;
    if (!dump) return;
    this._dump = null;
    const prev = this._lastDump;
    if (prev && dump.startTs - prev.endTs <= DOUBLE_DUMP_MS) {
      this._push('double-dump', dump.startTs, dump.startLine,
        `bag dump of ${dump.slots.size} slots began ${dump.startTs - prev.endTs} ms after the previous one (line ${prev.startLine})`);
    }
    this._lastDump = dump;
  }

  private _closeCredit(): void {
    if (this._creditItems.size === 0) return;
    const engine = this._getEngine();
    const inventoryItems = engine ? engine.getInventory().size : 0;
    const n = this._creditItems.size;
    if (n >= MASS_CREDIT_MIN_ITEMS && n >= inventoryItems * MASS_CREDIT_SHARE) {
      this._push('mass-credit', this._creditAt, this._creditLine,
        `${n} distinct items credited in one batch (inventory holds ${inventoryItems})`);
    }
    this._creditItems = new Set();
  }

  private _check(now: number, lineNo: number | null): void {
    const engine = this._getEngine();
    if (!engine) return;
    const diag = engine.getBagDiagnostics();
    if (!diag.initialized) return;

    const fromSlots = sumSlots(diag.slots.values());
    const drift = diffTotals(fromSlots, diag.totals);
    if (drift.length > 0) {
      this._push('bag-totals-inconsistent', now, lineNo, describe(drift, 'Σslots', 'totals'));
    }

    const dump = this._lastDump;
    if (dump && !this._bagMovedSinceDump) {
      const mismatch = diffTotals(sumSlots(dump.slots.values()), diag.totals);
      if (mismatch.length > 0) {
        this._push('snapshot-mismatch', now, lineNo, `dump at line ${dump.startLine}: ${describe(mismatch, 'dump', 'engine')}`);
      }
    }
  }

  private _push(kind: AnomalyKind, ts: number, lineNo: number | null, detail: string): void {
    this.anomalies.push({kind, ts, lineNo, detail});
  }
}

export function sumSlots(slots: Iterable<{itemId: number; quantity: number}>): Map<number, number> {
  const out = new Map<number, number>();
  for (const s of slots) {
    if (s.quantity !== 0) out.set(s.itemId, (out.get(s.itemId) ?? 0) + s.quantity);
  }
  return out;
}

export function diffTotals(a: Map<number, number>, b: Map<number, number>): Array<{itemId: number; a: number; b: number}> {
  const out: Array<{itemId: number; a: number; b: number}> = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const av = a.get(id) ?? 0;
    const bv = b.get(id) ?? 0;
    if (av !== bv) out.push({itemId: id, a: av, b: bv});
  }
  return out;
}

function describe(diff: Array<{itemId: number; a: number; b: number}>, aName: string, bName: string): string {
  const shown = diff.slice(0, 5).map(d => `${d.itemId}: ${aName}=${d.a} ${bName}=${d.b}`).join(', ');
  return `${diff.length} item(s) differ — ${shown}${diff.length > 5 ? ', …' : ''}`;
}

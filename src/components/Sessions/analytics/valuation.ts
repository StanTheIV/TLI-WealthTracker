import type {DbItem} from '@/types/electron';
import {taxedUnitPrice, type TaxConfig} from '@/lib/tax';
import type {PriceLookup, Valuation, Valuator} from './types';

export const ZERO_VAL: Valuation = {snapshot: 0, live: 0};

export function addVal(a: Valuation, b: Valuation): Valuation {
  return {snapshot: a.snapshot + b.snapshot, live: a.live + b.live};
}

export function subVal(a: Valuation, b: Valuation): Valuation {
  return {snapshot: a.snapshot - b.snapshot, live: a.live - b.live};
}

export function scaleVal(v: Valuation, k: number): Valuation {
  if (!Number.isFinite(k)) return ZERO_VAL;
  return {snapshot: v.snapshot * k, live: v.live * k};
}

/** Clamp both legs at zero. Guards the overlap subtraction, where float drift
 *  or an inconsistent legacy row can push a difference just below zero. */
export function clampVal(v: Valuation): Valuation {
  return {snapshot: Math.max(0, v.snapshot), live: Math.max(0, v.live)};
}

export function isZeroVal(v: Valuation): boolean {
  return v.snapshot === 0 && v.live === 0;
}

/** Percentage change from snapshot to live. Null when the snapshot leg is zero
 *  — the change is undefined, not infinite, and must not render as a number. */
export function driftPct(v: Valuation): number | null {
  if (v.snapshot === 0) return null;
  return ((v.live - v.snapshot) / v.snapshot) * 100;
}

/** Value per hour. Returns zero rather than Infinity when no time elapsed. */
export function perHour(v: Valuation, seconds: number): Valuation {
  if (seconds <= 0) return ZERO_VAL;
  return scaleVal(v, 3600 / seconds);
}

/** Percentage share of a total, per leg. Zero where that leg's total is zero,
 *  so a share never renders as NaN beside a real value. */
export function sharePct(part: Valuation, total: Valuation): Valuation {
  return {
    snapshot: total.snapshot === 0 ? 0 : (part.snapshot / total.snapshot) * 100,
    live:     total.live === 0 ? 0 : (part.live / total.live) * 100,
  };
}

/** Safe ratio for both legs. Null per-leg when the divisor is zero. */
export function ratio(a: Valuation, b: Valuation): {snapshot: number | null; live: number | null} {
  return {
    snapshot: b.snapshot === 0 ? null : a.snapshot / b.snapshot,
    live:     b.live === 0 ? null : a.live / b.live,
  };
}

/** An empty snapshot is indistinguishable from a pre-column session, so both
 *  degrade identically: `snapshot` aliases `live` and `hasSnapshot` tells the UI
 *  to hide the comparison. Per-item misses fall back the same way, so one
 *  unpriced item can't make a whole session look like it lost value.
 *
 *  Both legs come out taxed, which is what makes this the seam for the whole
 *  analytics module: `makeValuator`, `valueOne` and every aggregate built on
 *  them inherit the auction-house cut without knowing it exists. The snapshot
 *  leg is taxed too — the cut is a property of realising the value, not of when
 *  the haul happened, so a saved session must not read as gross. */
export function makePriceLookup(
  items: Record<string, DbItem>,
  snapshot: Record<string, number> | null | undefined,
  /** Required (and positional, ahead of the optional `coveredIds`) so adding it
   *  breaks every existing caller rather than silently valuing at gross. */
  tax: TaxConfig,
  /** Ids the page actually values. A snapshot covering none of them (only
   *  consumed materials, say) can't support a comparison, so it counts as
   *  absent rather than as "nothing moved". */
  coveredIds?: Iterable<string>,
): PriceLookup {
  const snap = snapshot ?? {};
  const anySnapshot = Object.keys(snap).length > 0;
  const hasSnapshot = anySnapshot && (
    coveredIds === undefined || [...coveredIds].some(id => snap[id] !== undefined)
  );
  const taxed = (itemId: string, price: number) => taxedUnitPrice(price, items[itemId]?.type, tax);
  const live  = (itemId: string) => taxed(itemId, items[itemId]?.price ?? 0);

  return {
    live,
    hasSnapshot,
    snapshot: (itemId: string) => (
      hasSnapshot && snap[itemId] !== undefined ? taxed(itemId, snap[itemId]) : live(itemId)
    ),
    isMissing: (itemId: string) => hasSnapshot && snap[itemId] === undefined,
  };
}

/** `clampNegative` is the income policy: negative quantities are auction-house
 *  conversions, not drops, so aggregates answering "what did this yield" must
 *  exclude them. The raw item table passes false to show them verbatim. */
export function makeValuator(prices: PriceLookup, opts: {clampNegative: boolean}): Valuator {
  return (drops: Record<string, number>): Valuation => {
    let snapshot = 0;
    let live     = 0;
    for (const [id, qty] of Object.entries(drops)) {
      if (opts.clampNegative && qty <= 0) continue;
      snapshot += qty * prices.snapshot(id);
      live     += qty * prices.live(id);
    }
    return {snapshot, live};
  };
}

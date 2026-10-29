/**
 * Doubles for TrackingDeps' wealth pair, for harnesses that don't test wealth:
 * a recorder whose every snapshot "stores" a row with the next id, and a
 * series that shows a row at its stored value.
 */
import {vi, type Mock} from 'vitest';
import type {Engine} from '@/main/engine/engine';
import type {StoredWealthDatapoint} from '@/shared/contracts/db';
import type {WealthSeriesPoint} from '@/shared/contracts/wealth';

export function fakeWealthRecorder(): {snapshot: Mock<(engine: Engine) => StoredWealthDatapoint>} {
  let id = 0;
  return {snapshot: vi.fn((_engine: Engine) => ({id: ++id, timestamp: Date.now(), value: 0, breakdown: '{}'}))};
}

export function fakeWealthSeries(): {pointOf: Mock<(row: StoredWealthDatapoint) => WealthSeriesPoint>} {
  return {pointOf: vi.fn((row: StoredWealthDatapoint) => ({id: row.id, ts: row.timestamp, value: row.value}))};
}

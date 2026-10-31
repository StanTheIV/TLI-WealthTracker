/**
 * Rig for the interlude-at-session-open tests (3.1b): the production chain
 * with an OwnerWatcher on every event, a started-but-uninitialized session,
 * and a `control` mode that plays the same pre-init script AFTER init (waits
 * skipped), so each scenario's expectations are proven against the ordinary
 * post-init flow. No `.test.ts` suffix on purpose (vitest only runs `*.test.ts`).
 */
import {vi, expect} from 'vitest';
import type {Engine} from '@/main/engine/engine';
import type {EngineEvent, SeasonalType} from '@/shared/contracts/engine';
import {OwnerWatcher} from '@/test/owner-invariant';
import {checkCheckpoints, checkUnits} from '@/test/unit-invariant';
import {unitsOf} from '@/test/unit-events';
import {TEST_IDENTITY, createDispatcher, createEngineWithEmit, ctx, feed, log} from './seasonal-fixtures';
import {beginSession, completeInit} from './identity-fixtures';

export const LOOT = 800;
export const INV  = [{slotId: 1, itemId: LOOT, quantity: 0}];

export function rig(opts: {control?: boolean} = {}) {
  const events: EngineEvent[] = [];
  let e!: Engine;
  const w = new OwnerWatcher({writer: () => ctx(e).registry.writer(), store: true});
  e = createEngineWithEmit(ev => { events.push(ev); w.onEmit(ev); });
  const d = createDispatcher();
  beginSession(e);
  const resets: number[] = [];
  let lootTotal = 0;
  let skipWaits = false;
  const reg = () => ctx(e).registry;

  /** Exact settled-point check: the watcher's view equals the engine's truth. */
  const settle = (label: string) => {
    w.checkLive(label, {
      writer:    reg().writer(),
      seasonals: [...reg().seasonals()].map(t => ({type: t.seasonalType, active: t.active})),
    });
    expect(w.violations, label).toEqual([]);
  };

  const o = {
    e, d, events, w, reg, resets,
    control: opts.control === true,
    line: (l: string) => { feed(d, e, l); settle(l.slice(0, 50)); },
    go:   (from: string, to: string) => { feed(d, e, log.zoneTransition(from, to)); settle(`go ${to.slice(-24)}`); },
    drop: (n = 1) => { lootTotal += n; feed(d, e, log.bagUpdate(1, LOOT, lootTotal)); settle('drop'); },
    adv:  (ms: number) => { if (!skipWaits) vi.advanceTimersByTime(ms); settle(`adv ${ms}`); },
    init: () => completeInit(d, e, INV),
    pause:  () => { e.pause();  settle('pause'); },
    resume: () => { e.resume(); settle('resume'); },
    reset:  () => { resets.push(events.length); e.reset(TEST_IDENTITY); settle('reset'); },
    units:  () => unitsOf(events),

    /** The scenario: `pre` is what happens before the bag baseline; in control
     *  mode the baseline lands first and `pre` replays after it, without waits. */
    play(pre: () => void) {
      if (!o.control) { pre(); o.init(); return; }
      o.init();
      skipWaits = true;
      pre();
      skipWaits = false;
    },

    seasonal: (t: SeasonalType) => reg().seasonal(t),
    map:      () => reg().map,
    /** The saved units as `[primary, ...overlaps]` type lists. */
    shape: () => unitsOf(events).map(u => ({
      primary:  u.tracker.kind === 'map' ? 'map' : u.tracker.seasonalType,
      overlaps: u.overlaps.map(c => c.tracker.seasonalType),
    })),
    /** Whole-stream invariants: unit structure, checkpoints, owner publishing. */
    assertClean() {
      expect(checkUnits(events, {resets})).toEqual([]);
      expect(checkCheckpoints(events)).toEqual([]);
      expect(w.violations).toEqual([]);
    },
  };
  return o;
}
export type Rig = ReturnType<typeof rig>;

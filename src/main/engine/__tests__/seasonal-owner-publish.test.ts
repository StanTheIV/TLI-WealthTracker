/**
 * What a seasonal PUBLISHES about ownership. The renderer replaces a seasonal's
 * snapshot on every tracker_update and draws the overlay's owner ring from its
 * `owner` flag, so every seasonal update must carry the true flag, and one is
 * sent only on a real change: drops/elapsed, or a changed `{active, owner}`
 * pair. Production chain only.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent, SeasonalType, TrackerSnapshot} from '@/shared/contracts/engine';
import {boot, createDispatcher, createEngine, ctx, feed, log, MAP, TOWN} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

const ITEM = 9000;

function setup() {
  const events: EngineEvent[] = [];
  const d = createDispatcher();
  const e = createEngine(events);
  boot(d, e, [{slotId: 1, itemId: ITEM, quantity: 0}]);
  feed(d, e, log.zoneTransition(TOWN, MAP));
  const line = (l: string) => feed(d, e, l);
  const reg  = () => ctx(e).registry;
  const seasonal = (type: SeasonalType) => reg().seasonal(type)!;
  return {events, e, line, reg, seasonal, emit: (ev: EngineEvent) => events.push(ev)};
}

/** The `{active, owner}` of every tracker_update a seasonal published. */
function flags(events: EngineEvent[], type: SeasonalType): Array<{active: boolean; owner: boolean | undefined}> {
  return events.flatMap(ev =>
    ev.type === 'tracker_update' && ev.tracker.seasonalType === type
      ? [{active: ev.tracker.active, owner: ev.tracker.owner}]
      : []);
}

const updates = (events: EngineEvent[]) => events.filter(ev => ev.type === 'tracker_update');

/** The Sandlord tile, parked dormant by its expired wave window. */
function dormantTile(o: ReturnType<typeof setup>) {
  o.line(log.s10Wave);
  vi.advanceTimersByTime(10_100);
  expect(o.seasonal('sandlord').active).toBe(false);
  o.events.length = 0;
  return o.seasonal('sandlord');
}

describe('drop updates carry the owner flag', () => {
  it('a drop on the owner publishes owner: true', () => {
    const o = setup();
    o.line(log.afterlightStart);
    o.events.length = 0;

    o.line(log.bagUpdate(1, ITEM, 2));

    expect(flags(o.events, 'afterlight')).toEqual([{active: true, owner: true}]);
  });

  it('a drop while a newer seasonal owns updates only the owner; the older one is stamped owner: false', () => {
    const o = setup();
    o.line(log.afterlightStart);
    o.line(log.s10Wave);                     // tile newer -> owns
    o.events.length = 0;

    o.line(log.bagUpdate(1, ITEM, 3));

    expect(flags(o.events, 'sandlord')).toEqual([{active: true, owner: true}]);
    expect(flags(o.events, 'afterlight')).toEqual([]);

    // The one emitter stamps an active non-owner false, never leaves it unset.
    o.events.length = 0;
    o.reg().emitUpdate(o.seasonal('afterlight'), o.emit);
    expect(flags(o.events, 'afterlight')).toEqual([{active: true, owner: false}]);
  });

  it('an owner re-armed between drops keeps owner: true on every update (no flap)', () => {
    const o = setup();
    o.line(log.s10Wave);
    o.events.length = 0;

    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(1_100);
      o.line(log.s10Land);                   // re-arm
      o.line(log.bagUpdate(1, ITEM, i + 1)); // drop
    }

    expect(flags(o.events, 'sandlord')).toEqual(Array(4).fill({active: true, owner: true}));
  });
});

describe('a wake publishes exactly one update', () => {
  it.each([
    ['armLootTimer',            (t: ReturnType<typeof dormantTile>) => t.armLootTimer()],
    ['resetLootTimer',          (t: ReturnType<typeof dormantTile>) => t.resetLootTimer()],
    ['resetLootTimerThrottled', (t: ReturnType<typeof dormantTile>) => { t.resetLootTimerThrottled(); }],
  ] as const)('%s on a dormant claims-drops tracker: one active owner update, before the window', (_name, arm) => {
    const o = setup();
    const tile = dormantTile(o);

    arm(tile);

    expect(updates(o.events)).toHaveLength(1);
    expect(flags(o.events, 'sandlord')).toEqual([{active: true, owner: true}]);
    const update = o.events.findIndex(ev => ev.type === 'tracker_update');
    const window = o.events.findIndex(ev => ev.type === 'loot_window_started');
    expect(window).toBeGreaterThan(update);
  });

  it('a late wave line on the dormant tile: one update', () => {
    const o = setup();
    dormantTile(o);

    o.line(log.s10Land);

    expect(updates(o.events)).toHaveLength(1);
    expect(flags(o.events, 'sandlord')).toEqual([{active: true, owner: true}]);
  });
});

describe('re-arms publish only a real ownership change', () => {
  it.each([
    ['armLootTimer',   (t: ReturnType<typeof dormantTile>) => t.armLootTimer()],
    ['resetLootTimer', (t: ReturnType<typeof dormantTile>) => t.resetLootTimer()],
    ['a wave line',    null],
  ] as const)('re-arming the already-active owner (%s) publishes no tracker_update', (_name, arm) => {
    const o = setup();
    o.line(log.s10Wave);
    o.events.length = 0;

    vi.advanceTimersByTime(1_100);
    if (arm) arm(o.seasonal('sandlord'));
    else     o.line(log.s10Land);

    expect(updates(o.events)).toEqual([]);
    expect(o.events.some(ev => ev.type === 'loot_window_started')).toBe(true);
  });

  it('re-arming an older tracker while a newer one owns: each gets exactly one update, flag flipped', () => {
    const o = setup();
    o.line(log.afterlightStart);
    o.line(log.s10Wave);                     // tile newer -> owns
    o.events.length = 0;

    vi.advanceTimersByTime(1_100);
    o.line(log.afterlightWave);              // afterlight re-armed -> takes it back

    expect(flags(o.events, 'afterlight')).toEqual([{active: true, owner: true}]);
    expect(flags(o.events, 'sandlord')).toEqual([{active: true, owner: false}]);
    expect(updates(o.events)).toHaveLength(2);
    expect(o.reg().writer()).toBe('afterlight');
  });
});

describe('timing-only (Clockwork fight phase)', () => {
  function clockwork() {
    const o = setup();
    o.line(log.s7Podium);
    return o;
  }

  it('park and wake still publish their active flip, never owner', () => {
    const o = clockwork();
    o.line(log.s7Cogwheel);
    o.events.length = 0;

    o.line(log.s7CogwheelEnd);
    expect(flags(o.events, 'clockwork')).toEqual([{active: false, owner: false}]);

    o.events.length = 0;
    o.line(log.s7Cogwheel);
    expect(flags(o.events, 'clockwork')).toEqual([{active: true, owner: false}]);
  });

  it('a cogwheel pulse on the live fight publishes nothing', () => {
    const o = clockwork();
    o.line(log.s7Cogwheel);
    o.events.length = 0;

    vi.advanceTimersByTime(2_800);
    o.line(log.s7Cogwheel);

    expect(flags(o.events, 'clockwork')).toEqual([]);
  });

  it('the turn-in on a parked tracker: one update, owner: true', () => {
    const o = clockwork();
    o.line(log.s7Cogwheel);
    o.line(log.s7CogwheelEnd);
    o.events.length = 0;

    o.line(log.s7Turnin);

    expect(flags(o.events, 'clockwork')).toEqual([{active: true, owner: true}]);
  });

  it('the turn-in during a live fight (claims flip only): one update, owner: true', () => {
    const o = clockwork();
    o.line(log.s7Cogwheel);
    o.events.length = 0;

    o.line(log.s7Turnin);

    expect(flags(o.events, 'clockwork')).toEqual([{active: true, owner: true}]);
    expect(o.reg().writer()).toBe('clockwork');
  });
});

describe('session pause / resume', () => {
  it.each([
    ['owner created last',  [log.afterlightStart, log.s10Wave]],
    ['owner created first', [log.s10Wave, log.afterlightStart, 'advance', log.s10Land]],
  ] as const)('%s: each frozen seasonal publishes active:false, then active:true with its final owner flag', (_name, script) => {
    const o = setup();
    for (const step of script) {
      if (step === 'advance') vi.advanceTimersByTime(1_100);
      else                    o.line(step);
    }
    expect(o.reg().writer()).toBe('sandlord');
    o.events.length = 0;

    o.e.pause();
    expect(flags(o.events, 'sandlord')).toEqual([{active: false, owner: false}]);
    expect(flags(o.events, 'afterlight')).toEqual([{active: false, owner: false}]);

    o.events.length = 0;
    o.e.resume();
    expect(flags(o.events, 'sandlord')).toEqual([{active: true, owner: true}]);
    expect(flags(o.events, 'afterlight')).toEqual([{active: true, owner: false}]);
    expect(o.reg().writer()).toBe('sandlord');   // order restored, not bumped
  });
});

describe('map and session updates never carry owner', () => {
  it('drops, re-arms, a wake, pause/resume and an interlude publish no owner on map/session', () => {
    const o = setup();
    o.line(log.s10Wave);
    o.line(log.bagUpdate(1, ITEM, 1));
    vi.advanceTimersByTime(10_100);          // tile dormant
    o.line(log.s10Land);                     // wake
    o.line(log.bagUpdate(1, ITEM, 3));
    o.e.pause();
    o.e.resume();
    o.line(log.s9Minigame);                  // arcana interlude pauses the map
    o.line(log.s9Close);                     // and resumes it
    o.line(log.bagUpdate(1, ITEM, 4));

    const plain = o.events.flatMap((ev): TrackerSnapshot[] =>
      (ev.type === 'tracker_update' || ev.type === 'tracker_started') && ev.tracker.kind !== 'seasonal'
        ? [ev.tracker]
        : []);
    expect(plain.some(t => t.kind === 'map')).toBe(true);
    expect(plain.some(t => t.kind === 'session')).toBe(true);
    expect(plain.filter(t => 'owner' in t)).toEqual([]);
  });
});

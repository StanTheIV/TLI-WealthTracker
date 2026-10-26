/**
 * Step 1.2 adversarial — entry cost on the map tracker.
 *
 * Production chain via seasonal-fixtures. Item 100 (material) starts at 10, so
 * 10 -> 7 in town is a cost of 3.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent, TrackerSnapshot} from '@/shared/contracts/engine';
import {MAP, TOWN, boot, createDispatcher, createEngine, ctx, feed, log} from './seasonal-fixtures';
import {dropEvents, sessionDrops} from './location-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

const MATERIAL = 100;
const LOOT     = 200;
const OTHER    = 300;
const S_MATERIAL = 1;
const S_LOOT     = 2;
const S_OTHER    = 3;

function setup() {
  const events: EngineEvent[] = [];
  const d = createDispatcher();
  const e = createEngine(events);
  boot(d, e, [
    {slotId: S_MATERIAL, itemId: MATERIAL, quantity: 10},
    {slotId: S_LOOT,     itemId: LOOT,     quantity: 0},
    {slotId: S_OTHER,    itemId: OTHER,    quantity: 10},
  ]);
  events.length = 0;
  return {
    events, d, e,
    bag:  (slot: number, id: number, qty: number) => feed(d, e, log.bagUpdate(slot, id, qty)),
    go:   (from: string, to: string) => feed(d, e, log.zoneTransition(from, to)),
    map:  () => ctx(e).registry.map?.snapshot(),
    sess: () => ctx(e).registry.session?.snapshot(),
  };
}

const finished = (events: EngineEvent[], kind: TrackerSnapshot['kind']) =>
  events.flatMap(ev => (ev.type === 'tracker_finished' && ev.tracker.kind === kind ? [ev.tracker] : []));

const updatesWithSpent = (events: EngineEvent[], kind: TrackerSnapshot['kind']) =>
  events.filter(ev => ev.type === 'tracker_update' && ev.tracker.kind === kind && ev.tracker.spent !== undefined);

describe('charging is once per real town -> map entry', () => {
  it('a duplicated town -> map transition line does not charge twice', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);
    s.go(TOWN, MAP);
    s.go(TOWN, MAP);
    expect(s.map()?.spent).toEqual({[MATERIAL]: 3});
    expect(s.sess()?.spent).toEqual({[MATERIAL]: 3});
    expect(sessionDrops(s.e)).toEqual({});
    expect(dropEvents(s.events)).toEqual([]);
  });

  it('a duplicated transition with a spend in between: the second spend is in-map loot, not cost', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);
    s.go(TOWN, MAP);
    s.bag(S_MATERIAL, MATERIAL, 5);       // -2 inside the map
    s.go(TOWN, MAP);
    expect(s.sess()?.spent).toEqual({[MATERIAL]: 3});
    expect(s.sess()?.drops[MATERIAL]).toBe(-2);
  });

  it('town -> map -> town -> map: costs do not leak between maps; session is the sum', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);
    s.go(TOWN, MAP);
    s.go(MAP, TOWN);
    s.go(TOWN, MAP);                         // nothing bought
    expect(s.map()?.spent).toBeUndefined();
    expect(s.sess()?.spent).toEqual({[MATERIAL]: 3});
    expect(finished(s.events, 'map')[0].spent).toEqual({[MATERIAL]: 3});
  });

  it('two entries both spend the same id: map 2 carries only its own 2, session 5', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);
    s.go(TOWN, MAP);
    s.go(MAP, TOWN);
    s.bag(S_MATERIAL, MATERIAL, 5);
    s.go(TOWN, MAP);
    expect(s.map()?.spent).toEqual({[MATERIAL]: 2});
    expect(s.sess()?.spent).toEqual({[MATERIAL]: 5});
  });
});

describe('buffer shape at entry', () => {
  it('a buffer with only positives: no cost anywhere, no spent updates, nothing credited', () => {
    const s = setup();
    s.bag(S_OTHER, OTHER, 14);               // +4 purchase
    s.go(TOWN, MAP);
    expect(s.map()?.spent).toBeUndefined();
    expect(s.sess()?.spent).toBeUndefined();
    expect(s.map()?.drops).toEqual({});
    expect(sessionDrops(s.e)).toEqual({});
    expect(updatesWithSpent(s.events, 'map')).toEqual([]);
    expect(updatesWithSpent(s.events, 'session')).toEqual([]);
  });

  it('mixed buffer: only the negatives are cost, the positive is never credited', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 6);          // -4
    s.bag(S_OTHER, OTHER, 12);               // +2
    s.go(TOWN, MAP);
    expect(s.map()?.spent).toEqual({[MATERIAL]: 4});
    expect(s.sess()?.spent).toEqual({[MATERIAL]: 4});
    expect(sessionDrops(s.e)).toEqual({});
  });

  it('spend then restore inside the same buffer nets to zero: no cost', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);
    s.bag(S_MATERIAL, MATERIAL, 10);
    s.go(TOWN, MAP);
    expect(s.map()?.spent).toBeUndefined();
  });

  it('a material spent in town and looted back in the map: gross loot +3 and cost 3, net zero', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);
    s.go(TOWN, MAP);
    s.bag(S_MATERIAL, MATERIAL, 10);         // +3 picked up in the map
    expect(s.map()?.drops).toEqual({[MATERIAL]: 3});
    expect(sessionDrops(s.e)).toEqual({[MATERIAL]: 3});
    expect(s.map()?.spent).toEqual({[MATERIAL]: 3});
    expect(s.sess()?.spent).toEqual({[MATERIAL]: 3});
  });

  it('negative for an id whose slot is removed in town (bag_remove) is cost too', () => {
    const s = setup();
    feed(s.d, s.e, log.bagRemove(S_MATERIAL));
    s.go(TOWN, MAP);
    expect(s.map()?.spent).toEqual({[MATERIAL]: 10});
  });
});

describe('pause around the entry buffer', () => {
  it('buffer built before a pause survives pause/resume and is charged at the next entry; spend during the pause is not', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);          // -3 buffered
    s.e.pause();
    s.bag(S_MATERIAL, MATERIAL, 5);          // -2 while paused: bookkeeping only
    s.e.resume();
    s.go(TOWN, MAP);
    expect(s.map()?.spent).toEqual({[MATERIAL]: 3});
    expect(s.sess()?.spent).toEqual({[MATERIAL]: 3});
    expect(sessionDrops(s.e)).toEqual({});
  });

  it('after that pause the bag baseline is right: a later in-map +1 is exactly +1', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);
    s.e.pause();
    s.bag(S_MATERIAL, MATERIAL, 5);
    s.e.resume();
    s.go(TOWN, MAP);
    s.bag(S_MATERIAL, MATERIAL, 6);
    expect(s.map()?.drops).toEqual({[MATERIAL]: 1});
  });

  it('pause, enter the map paused, resume, enter another map: only the second is charged', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);
    s.e.pause();
    s.go(TOWN, MAP);
    s.e.resume();
    expect(s.map()?.spent).toBeUndefined();
    s.go(MAP, TOWN);
    s.bag(S_MATERIAL, MATERIAL, 6);
    s.go(TOWN, MAP);
    expect(s.map()?.spent).toEqual({[MATERIAL]: 1});
    expect(s.sess()?.spent).toEqual({[MATERIAL]: 1});
  });
});

describe('reset', () => {
  it('reset twice mid-map does not double the session cost', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);
    s.go(TOWN, MAP);
    s.e.reset();
    s.e.reset();
    expect(s.map()?.spent).toEqual({[MATERIAL]: 3});
    expect(s.sess()?.spent).toEqual({[MATERIAL]: 3});
    s.e.reset();
    expect(s.sess()?.spent).toEqual({[MATERIAL]: 3});
  });

  it('every reset finishes the old map carrying the cost', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);
    s.go(TOWN, MAP);
    s.e.reset();
    s.e.reset();
    const fin = finished(s.events, 'map');
    expect(fin).toHaveLength(2);
    for (const f of fin) expect(f.spent).toEqual({[MATERIAL]: 3});
  });

  it('the cost carried by a reset survives map -> town and tracker_finished carries it', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);
    s.go(TOWN, MAP);
    s.e.reset();
    s.bag(S_LOOT, LOOT, 4);
    s.events.length = 0;
    s.go(MAP, TOWN);
    const fin = finished(s.events, 'map');
    expect(fin).toHaveLength(1);
    expect(fin[0].spent).toEqual({[MATERIAL]: 3});
    expect(fin[0].drops).toEqual({[LOOT]: 4});
    expect(s.sess()?.spent).toEqual({[MATERIAL]: 3});
  });

  it('after a carrying reset, the next map adds its own cost on top (session = carried + new)', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);
    s.go(TOWN, MAP);
    s.e.reset();
    s.go(MAP, TOWN);
    s.bag(S_MATERIAL, MATERIAL, 5);
    s.go(TOWN, MAP);
    expect(s.map()?.spent).toEqual({[MATERIAL]: 2});
    expect(s.sess()?.spent).toEqual({[MATERIAL]: 5});
  });

  it('reset while paused mid-map keeps the cost on both trackers', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);
    s.go(TOWN, MAP);
    s.e.pause();
    s.e.reset();
    expect(s.map()?.spent).toEqual({[MATERIAL]: 3});
    expect(s.sess()?.spent).toEqual({[MATERIAL]: 3});
  });

  it('reset emits a session tracker_update carrying the carried cost, only when there is one', () => {
    const s = setup();
    s.go(TOWN, MAP);
    s.events.length = 0;
    s.e.reset();
    expect(updatesWithSpent(s.events, 'session')).toEqual([]);

    const t = setup();
    t.bag(S_MATERIAL, MATERIAL, 7);
    t.go(TOWN, MAP);
    t.events.length = 0;
    t.e.reset();
    expect(updatesWithSpent(t.events, 'session')).toHaveLength(1);
  });

  it('the carried cost is a copy: later cost on the rebuilt map does not alias the finished snapshot', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);
    s.go(TOWN, MAP);
    s.e.reset();
    const old = finished(s.events, 'map')[0].spent;
    ctx(s.e).registry.map!.addCost(MATERIAL, 9);
    expect(old).toEqual({[MATERIAL]: 3});
  });
});

describe('stop mid-map (characterization)', () => {
  it('the final session snapshot includes the in-flight map\'s cost; the unfinished map is not emitted', () => {
    const s = setup();
    s.bag(S_MATERIAL, MATERIAL, 7);
    s.go(TOWN, MAP);
    s.events.length = 0;
    s.e.stop();
    expect(finished(s.events, 'map')).toEqual([]);
    const sess = finished(s.events, 'session');
    expect(sess).toHaveLength(1);
    expect(sess[0].spent).toEqual({[MATERIAL]: 3});
    expect(sess[0].drops).toEqual({});
  });
});

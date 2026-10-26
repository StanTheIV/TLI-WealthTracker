/**
 * A seasonal that merely EXISTS (panel open or backed out in town) must not
 * make town a loot context: bag changes there are town activity and credit
 * nothing. Only the fight scene that follows is loot.
 *
 * Item 200 starts at 10 in slot 1; each step moves it to an absolute count.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent} from '@/shared/contracts/engine';
import {
  ARCANA_FIGHT, TOWN, boot, createDispatcher, createEngine, ctx, feed, log,
} from './seasonal-fixtures';
import {UNKNOWN_SCENE, dropEvents, dropsBySource, resort, sessionDrops} from './location-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

const ITEM = 200;
const SETTLE_MS = 2_000; // past the 1.5 s town buffer

function setup() {
  const events: EngineEvent[] = [];
  const d = createDispatcher();
  const e = createEngine(events);
  boot(d, e, [{slotId: 1, itemId: ITEM, quantity: 10}]);
  events.length = 0;
  const bag = (qty: number) => {
    feed(d, e, log.bagUpdate(1, ITEM, qty));
    vi.advanceTimersByTime(SETTLE_MS);
  };
  const line = (l: string) => feed(d, e, l);
  return {events, d, e, bag, line};
}

const PANELS = [
  ['arcana',  'arcana',  log.s9Minigame, log.s9Close],
  ['tartarus', 'tartarus', log.s16BoardOpen, log.s16BoardClose],
  ['vorex',   'vorex',   log.s13Start, log.s13WindowClose],
] as const;

describe.each(PANELS)('%s panel in town', (_name, type, open, close) => {
  it('open panel: bag change credits nothing; closed (paused) panel: nor does the next', () => {
    const {events, e, bag, line} = setup();

    line(open);
    expect(ctx(e).registry.seasonal(type)?.active).toBe(true);
    bag(15); // +5 with the panel open
    expect(dropEvents(events)).toEqual([]);
    expect(sessionDrops(e)).toEqual({});

    line(close);
    expect(ctx(e).registry.seasonal(type)).not.toBeNull(); // still in the registry
    bag(19); // +4 with the panel closed
    expect(dropEvents(events)).toEqual([]);
    expect(sessionDrops(e)).toEqual({});
    expect(dropsBySource(e)).toEqual({});
    expect(ctx(e).registry.seasonal(type)?.snapshot().drops).toEqual({});
  });

  it('open panel: a bag resort credits nothing', () => {
    const {events, d, e, line} = setup();

    line(open);
    resort(d, e, 1, ITEM, 15);
    vi.advanceTimersByTime(SETTLE_MS);

    expect(dropEvents(events)).toEqual([]);
    expect(sessionDrops(e)).toEqual({});
    expect(dropsBySource(e)).toEqual({});
  });
});

describe('town panel then a real fight', () => {
  it('backed-out Arcana panel, reopened, fight: only the fight loot is credited', () => {
    const {events, e, bag, line} = setup();

    line(log.s9Minigame);
    bag(15);                       // +5 in the panel
    line(log.s9Close);
    bag(19);                       // +4 backed out
    line(log.s9Minigame);          // reopened
    line(log.zoneTransition(TOWN, ARCANA_FIGHT));
    bag(31);                       // +12 in the Fateful Contest

    expect(sessionDrops(e)).toEqual({[ITEM]: 12});
    expect(dropsBySource(e)).toEqual({arcana: {[ITEM]: 12}});
    expect(ctx(e).registry.seasonal('arcana')?.snapshot().drops).toEqual({[ITEM]: 12});
    expect(dropEvents(events).map(ev => ev.type === 'drop' ? ev.change : 0)).toEqual([12]);

    line(log.zoneTransition(ARCANA_FIGHT, TOWN));
    bag(35);                       // +4 back in town: town activity again
    expect(sessionDrops(e)).toEqual({[ITEM]: 12});
  });
});

describe('a seasonal alive while the location is other', () => {
  it('bag changes in an unrecognised scene are not credited', () => {
    const {events, e, bag, line} = setup();

    line(log.s9Minigame);
    line(log.zoneTransition(TOWN, UNKNOWN_SCENE));
    expect(ctx(e).registry.seasonal('arcana')).not.toBeNull();

    bag(15);
    expect(dropEvents(events)).toEqual([]);
    expect(sessionDrops(e)).toEqual({});
  });
});

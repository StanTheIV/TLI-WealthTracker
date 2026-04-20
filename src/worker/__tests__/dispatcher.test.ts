import {describe, it, expect} from 'vitest';
import {Dispatcher} from '@/worker/dispatcher';
import {BagProcessor} from '@/worker/processors/bag';
import {ZoneProcessor} from '@/worker/processors/zone';
import {LevelTypeProcessor} from '@/worker/processors/level-type';

function createDispatcher(): Dispatcher {
  const d = new Dispatcher();
  d.register(new BagProcessor());
  d.register(new ZoneProcessor());
  d.register(new LevelTypeProcessor());
  return d;
}

const ts = '[2026.01.25-12.34.56:789]';

describe('Dispatcher', () => {
  it('routes bag_init to BagProcessor', () => {
    const d = createDispatcher();
    const events = d.dispatch(`${ts}TLLua: Display: [Game] BagMgr@:InitBagData PageId = 0 SlotId = 5 ConfigBaseId = 111 Num = 10`);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('bag_init');
  });

  it('routes zone transition to ZoneProcessor', () => {
    const d = createDispatcher();
    const events = d.dispatch(`PageApplyBase@ _UpdateGameEnd: LastSceneName = World'A' NextSceneName = World'B'`);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({type: 'zone_transition', fromScene: 'A', toScene: 'B'});
  });

  it('routes level type to LevelTypeProcessor', () => {
    const d = createDispatcher();
    const events = d.dispatch('PreloadLevelType = 11');
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({type: 'level_type', levelType: 11});
  });

  it('returns empty array for unrelated lines', () => {
    const d = createDispatcher();
    const events = d.dispatch('LogNet: some irrelevant log line');
    expect(events).toHaveLength(0);
  });

  it('returns empty array for empty line', () => {
    const d = createDispatcher();
    expect(d.dispatch('')).toHaveLength(0);
  });

  it('dispatches to multiple processors if line matches both', () => {
    // This is unlikely with real data, but tests the multi-match behavior.
    // Create a synthetic processor that matches everything.
    const d = new Dispatcher();
    d.register({
      name: 'catch-all',
      test: () => true,
      process: (line) => ({type: 'reader_ready'} as const),
    });
    d.register(new BagProcessor());

    const events = d.dispatch(`${ts}TLLua: Display: [Game] BagMgr@:InitBagData PageId = 0 SlotId = 0 ConfigBaseId = 1 Num = 1`);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('reader_ready');
    expect(events[1].type).toBe('bag_init');
  });

  it('handles high volume dispatch', () => {
    const d = createDispatcher();
    const line = `${ts}TLLua: Display: [Game] BagMgr@:Modfy BagItem PageId = 0 SlotId = 3 ConfigBaseId = 555 Num = 20`;

    // Simulate 10k lines
    let count = 0;
    for (let i = 0; i < 10_000; i++) {
      const events = d.dispatch(line);
      count += events.length;
    }
    expect(count).toBe(10_000);
  });
});

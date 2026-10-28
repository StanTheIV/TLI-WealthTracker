/**
 * Engine.configure — every handler reads its own field of the parsed settings
 * (the windowed mechanics their `lootWindowMs` entry, MapMaterial the low-stock
 * threshold) — and the table's 'interlude' categories against the handlers
 * that actually freeze the map. Production chain only.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, it, expect, beforeEach, vi} from 'vitest';
import type {EngineEvent, SeasonalType} from '@/shared/contracts/engine';
import {parseSettings} from '@/shared/settings';
import {MECHANICS, mechanic, type WindowedSeasonalType} from '@/shared/mechanics';
import {MAP, TOWN, boot, createDispatcher, createEngine, feed, log} from './seasonal-fixtures';

beforeEach(() => {
  vi.useFakeTimers();
});

const ITEM = 100;

function setup() {
  const events: EngineEvent[] = [];
  const d = createDispatcher();
  const e = createEngine(events);
  boot(d, e, [{slotId: 1, itemId: ITEM, quantity: 10}]);
  events.length = 0;
  const line = (l: string) => feed(d, e, l);
  const go   = (from: string, to: string) => line(log.zoneTransition(from, to));
  return {events, e, line, go};
}

/** The log lines that start each windowed mechanic and arm its window. */
const ARM: Record<WindowedSeasonalType, string[]> = {
  overrealm:  [log.s12Entry, log.s12Exit],
  carjack:    [log.s11Start],
  clockwork:  [log.s7Podium, log.s7Turnin],
  lunaria:    [log.s14Strum],
  sandlord:   [log.s10Wave],
  hunting:    [log.huntingStatue, log.huntingBossStart, log.huntingBossEnd],
  afterlight: [log.afterlightStart],
};

/** Length (ms) of the last window armed for `type`. */
function lastWindowMs(events: EngineEvent[], type: SeasonalType): number | undefined {
  const armed = events.filter((ev): ev is Extract<EngineEvent, {type: 'loot_window_started'}> =>
    ev.type === 'loot_window_started' && ev.seasonalType === type);
  const last = armed[armed.length - 1];
  return last && last.deadline - last.timestamp;
}

/** Configure, then start `type` in a fresh map and report its armed window. */
function armedWindow(type: WindowedSeasonalType, settings: Record<string, string>): number | undefined {
  const {events, e, line, go} = setup();
  e.configure(parseSettings(settings));
  go(TOWN, MAP);
  for (const l of ARM[type]) line(l);
  return lastWindowMs(events, type);
}

const WINDOWED = MECHANICS.flatMap(m => (m.window ? [m.key] : []));

describe('Engine.configure: windowed mechanics', () => {
  it('every windowed mechanic has an arming scenario', () => {
    expect(Object.keys(ARM).sort()).toEqual([...WINDOWED].sort());
  });

  it.each(WINDOWED)('%s: a missing key arms the table default', (type) => {
    expect(armedWindow(type, {})).toBe(mechanic(type).window.defaultMs);
  });

  it.each(WINDOWED)('%s: its own setting key sets the window', (type) => {
    expect(armedWindow(type, {[mechanic(type).window.settingKey]: '7000'})).toBe(7000);
  });

  it.each(WINDOWED)('%s: fractional values floor', (type) => {
    expect(armedWindow(type, {[mechanic(type).window.settingKey]: '7000.9'})).toBe(7000);
  });

  it.each(WINDOWED.flatMap(type => ['0', '-5', 'abc', '', '0.5', 'Infinity'].map(raw => [type, raw] as const)))(
    '%s: %j falls back to the table default',
    (type, raw) => {
      expect(armedWindow(type, {[mechanic(type).window.settingKey]: raw})).toBe(mechanic(type).window.defaultMs);
    },
  );

  it('a key only reaches its own mechanic', () => {
    expect(armedWindow('carjack', {overrealmLootMs: '7000', sandlordWaveMs: '7000'})).toBe(5_000);
  });

  it('a reconfigure resets a key that disappeared back to the default', () => {
    const {events, e, line, go} = setup();
    e.configure(parseSettings({carjackLootMs: '7000'}));
    e.configure(parseSettings({}));
    go(TOWN, MAP);
    line(log.s11Start);
    expect(lastWindowMs(events, 'carjack')).toBe(5_000);
  });

  it('a new value applies from the next seasonal start: the live tracker keeps its window', () => {
    const {events, e, line, go} = setup();
    go(TOWN, MAP);
    line(log.s11Start);
    expect(lastWindowMs(events, 'carjack')).toBe(5_000);

    e.configure(parseSettings({carjackLootMs: '7000'}));
    line(log.s11End);                               // re-arms the live tracker
    expect(lastWindowMs(events, 'carjack')).toBe(5_000);

    go(MAP, TOWN);                                  // town entry finishes it
    go(TOWN, MAP);
    line(log.s11Start);
    expect(lastWindowMs(events, 'carjack')).toBe(7_000);
  });
});

describe('Engine.configure: low-stock threshold', () => {
  function lowStock(configure: (e: ReturnType<typeof setup>['e']) => void) {
    const {events, e, line, go} = setup();
    configure(e);
    let qty = 10;
    const spend = () => { qty -= 1; line(log.bagUpdate(1, ITEM, qty)); };
    // Two paid entries make the item watched; the second entry reports it at 8.
    spend(); go(TOWN, MAP); go(MAP, TOWN);
    spend(); go(TOWN, MAP);
    const warnings = events.filter((ev): ev is Extract<EngineEvent, {type: 'map_material_warning'}> =>
      ev.type === 'map_material_warning');
    return warnings[warnings.length - 1].items;
  }

  it('warns at or under the configured threshold', () => {
    expect(lowStock(e => e.configure(parseSettings({lowStockThreshold: '8'})))).toEqual([{itemId: ITEM, quantity: 8}]);
    expect(lowStock(e => e.configure(parseSettings({lowStockThreshold: '7'})))).toEqual([]);
  });

  it('0 is a valid threshold; missing or invalid values reset to 0', () => {
    for (const raw of ['0', '-1', 'abc']) {
      expect(lowStock(e => {
        e.configure(parseSettings({lowStockThreshold: '100'}));
        e.configure(parseSettings({lowStockThreshold: raw}));
      })).toEqual([]);
    }
    expect(lowStock(e => { e.configure(parseSettings({lowStockThreshold: '100'})); e.configure(parseSettings({})); })).toEqual([]);
  });
});

describe('MECHANICS categories vs the handlers', () => {
  const HANDLERS = join(__dirname, '..', 'handlers');

  /** The `name` of every handler whose source calls pauseMapForInterlude. */
  function mapFreezingHandlers(): string[] {
    return readdirSync(HANDLERS)
      .filter(f => f.endsWith('.ts'))
      .map(f => readFileSync(join(HANDLERS, f), 'utf8'))
      .filter(src => /\bpauseMapForInterlude\(ctx\b/.test(src))
      .map(src => {
        const name = /readonly name\s*=\s*'([^']+)'/.exec(src)?.[1];
        if (!name) throw new Error('a handler calling pauseMapForInterlude has no name');
        return name;
      })
      .sort();
  }

  it('the handlers that freeze the map are exactly the rows that are not in-map', () => {
    const freezing = MECHANICS.filter(m => m.category !== 'in-map').map(m => m.key).sort();
    expect(mapFreezingHandlers()).toEqual(freezing);
    expect(freezing).toEqual(['arcana', 'sandlord', 'tartarus', 'vorex']);
  });
});

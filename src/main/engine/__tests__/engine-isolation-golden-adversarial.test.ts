/**
 * 5.1c adversarial: a handler that throws on EVERY raw event, across the whole golden log
 * replays. The run must complete, everything non-error must equal the clean run, the
 * invariants hold, and the throttle bounds the error events by elapsed (virtual) time.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {describe, it, expect, vi} from 'vitest';

vi.mock('@/main/logger', () => ({log: {error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn()}}));

import {replay, type ReplayEvent} from '@/replay/replay';
import {readLogText} from '@/replay/log-source';
import {configureEngine} from '@/main/engine/configure-engine';
import {SqliteSessionStore} from '@/main/db/session-store';
import type {Engine} from '@/main/engine/engine';
import type {EventHandler} from '@/main/engine/types';
import {openMigratedNodeSqlite} from '@/test/sql/fresh-db';
import {GOLDEN_ITEMS} from '@/test/golden/items';
import {SYNTHETIC_FIXTURES} from '@/test/golden/synthetic';
import {OwnerWatcher} from '@/test/owner-invariant';
import {checkUnits, checkCheckpoints} from '@/test/unit-invariant';

const REAL = ['plain-map-cost', 'map-arcana-map', 'town-panel-then-map', 'sandlord-hub', 'sandlord-quench'];
const SYNTH = Object.keys(SYNTHETIC_FIXTURES) as Array<keyof typeof SYNTHETIC_FIXTURES>;
const ERROR_THROTTLE_MS = 10_000;

const text = (name: string): string =>
  (SYNTH as string[]).includes(name)
    ? SYNTHETIC_FIXTURES[name as keyof typeof SYNTHETIC_FIXTURES]
    : readFileSync(join(__dirname, '../../../test/golden/fixtures', `${name}.log`), 'utf8');

type Wrap = (handler: EventHandler) => void;

/** Real handle runs first, then it throws: state and events stay those of a clean run. */
const throwAfter: Wrap = (h) => {
  const real = h.handle.bind(h);
  h.handle = (...args) => { real(...args); throw new Error(`late-${h.name}`); };
};

async function run(name: string, wrap?: Wrap) {
  const store = new SqliteSessionStore(openMigratedNodeSqlite());
  const handlerCalls = new Map<string, number>();
  const result = await replay({
    source:      readLogText(text(name)),
    persistence: {store, readPrices: () => ({})},
    configure:   (engine: Engine) => {
      configureEngine(engine, {items: Object.values(GOLDEN_ITEMS), filterRules: null, settings: {}});
      if (!wrap) return;
      for (const hName of HANDLER_NAMES) {
        const h = engine.getHandler(hName);
        if (!h) continue;
        wrap(h);
        const throwing = h.handle;
        h.handle = (...a) => { handlerCalls.set(hName, (handlerCalls.get(hName) ?? 0) + 1); return throwing(...a); };
      }
    },
  });
  return {result, handlerCalls};
}

const HANDLER_NAMES = [
  'bag-init', 'sandlord', 'zone', 'dream', 'vorex', 'tartarus', 'overrealm', 'carjack', 'clockwork',
  'lunaria', 'arcana', 'sandlord-map', 'hunting', 'afterlight', 'item', 'map-material',
];

const nonError = (events: ReplayEvent[]) => events.map(e => e.event).filter(e => e.type !== 'error');

describe.each([...REAL, ...SYNTH])('every handler throws after its real work on every event: %s', (name) => {
  it('completes; non-error events equal the clean run; invariants hold; errors are throttled by virtual time', async () => {
    const clean = await run(name);
    const noisy = await run(name, throwAfter);

    expect(clean.result.events.some(e => e.event.type === 'error')).toBe(false);

    // The throw happens after the work: nothing else may differ.
    expect(JSON.stringify(nonError(noisy.result.events))).toBe(JSON.stringify(nonError(clean.result.events)));
    expect(noisy.result.sessions.map(s => s.session?.drops)).toEqual(clean.result.sessions.map(s => s.session?.drops));
    expect(noisy.result.anomalies.length).toBe(clean.result.anomalies.length);

    const stream = noisy.result.events.map(e => e.event);
    expect(checkUnits(stream)).toEqual([]);
    expect(checkCheckpoints(stream)).toEqual([]);
    const watcher = new OwnerWatcher();
    for (const ev of stream) watcher.onEmit(ev);
    expect(watcher.violations).toEqual([]);
    expect(stream.filter(e => e.type === 'engine_stopped')).toHaveLength(1);

    // Throttle: per (handler, hook) at most one report per 10 s of virtual time, plus the first.
    const errors = noisy.result.events.filter(e => e.event.type === 'error');
    const byKey = new Map<string, number[]>();
    for (const {event, at} of errors) {
      if (event.type !== 'error') continue;
      const k = `${event.source?.handler}:${event.source?.hook}`;
      byKey.set(k, [...(byKey.get(k) ?? []), at]);
      expect(event.message).not.toContain('\n');
    }
    for (const [key, ats] of byKey) {
      expect(key.endsWith(':handle'), key).toBe(true);
      for (let i = 1; i < ats.length; i++) expect(ats[i] - ats[i - 1], key).toBeGreaterThanOrEqual(ERROR_THROTTLE_MS);
    }
    // Every handler that was actually invoked reported at least once.
    for (const [hName, calls] of noisy.handlerCalls) {
      if (calls > 0) expect(byKey.has(`${hName}:handle`), hName).toBe(true);
    }
    // No more errors than handler:hook keys x (span / 10 s + 1).
    const span = (noisy.result.lastTs ?? 0) - (noisy.result.firstTs ?? 0) + 60_000;
    expect(errors.length).toBeLessThanOrEqual(HANDLER_NAMES.length * (Math.floor(span / ERROR_THROTTLE_MS) + 1));
    expect(errors.length).toBeLessThan(noisy.result.linesDelivered * HANDLER_NAMES.length + 1);
  }, 60_000);
});

describe('a handler that throws BEFORE doing its work (item handler) on every event', () => {
  it('the run still completes with exactly one engine_stopped and well-formed unit events', async () => {
    const wrap: Wrap = (h) => { if (h.name === 'item') h.handle = () => { throw new Error('early-item'); }; };
    const {result} = await run('plain-map-cost', wrap);
    const stream = result.events.map(e => e.event);
    expect(stream.filter(e => e.type === 'engine_stopped')).toHaveLength(1);
    expect(stream.filter(e => e.type === 'error').length).toBeGreaterThan(0);
    expect(checkUnits(stream)).toEqual([]);
    const watcher = new OwnerWatcher();
    for (const ev of stream) watcher.onEmit(ev);
    expect(watcher.violations).toEqual([]);
  });
});

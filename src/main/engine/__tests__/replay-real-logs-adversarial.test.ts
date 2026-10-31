/**
 * 4.2 adversarial: Engine.getState() replay equivalence over the committed
 * golden logs (real slices + synthetic scripts), line by line.
 *
 * Each log runs through the production dispatcher -> engine under virtual log
 * time (the replay clock), every event goes into a live engineStore, and after
 * EVERY clock advance and EVERY line a fresh store built from
 * `applySnapshot({seq, events: engine.getState()})` must equal the live one.
 * Pause/resume (and a reset) are injected mid-run. A second suite proves
 * getState() is pure: calling it at random points never changes what the
 * engine emits next.
 */
import {readFileSync} from 'fs';
import {join} from 'path';
import {describe, it, expect, afterEach} from 'vitest';
import type {EngineEvent, TrackerSnapshot} from '@/shared/contracts/engine';
import {createEngine} from '@/main/engine/create-engine';
import {configureEngine} from '@/main/engine/configure-engine';
import {createDispatcher} from '@/worker/create-dispatcher';
import {readLogText, type LogLine} from '@/replay/log-source';
import {installReplayClock, type ReplayClock} from '@/replay/clock';
import {useEngineStore, selectRunStatus} from '@/state/engineStore';
import {GOLDEN_ITEMS} from '@/test/golden/items';
import {SYNTHETIC_FIXTURES} from '@/test/golden/synthetic';

const REAL = ['plain-map-cost', 'map-arcana-map', 'town-panel-then-map', 'sandlord-hub', 'sandlord-quench'] as const;
const NAMES = [...REAL, ...Object.keys(SYNTHETIC_FIXTURES)] as string[];

function logLines(name: string): LogLine[] {
  const text = name in SYNTHETIC_FIXTURES
    ? SYNTHETIC_FIXTURES[name as keyof typeof SYNTHETIC_FIXTURES]
    : readFileSync(join(__dirname, '../../../test/golden/fixtures', `${name}.log`), 'utf8');
  return [...readLogText(text)];
}

// -- normalisation (same view as engine-replay.test.ts) ----------------------

const shown = (elapsed: number, receivedAt: number | null, running: boolean) =>
  running && receivedAt !== null ? elapsed + (Date.now() - receivedAt) : elapsed;

type StoreState = ReturnType<typeof useEngineStore.getState>;
function norm(s: StoreState) {
  const dismissed = s.dismissedMaterials;
  const running   = selectRunStatus(s) === 'running';
  const tracker   = (t: TrackerSnapshot | null, at: number | null) => t && {...t, elapsed: shown(t.elapsed, at, running && t.active)};
  return {
    phase: s.phase, runStatus: selectRunStatus(s), drops: s.drops, sessionSpent: s.sessionSpent,
    mapCount: s.mapCount, currentZone: s.currentZone,
    mapTracker: tracker(s.mapTracker, s.mapTrackerReceivedAt),
    mapStamped: s.mapTrackerReceivedAt !== null,
    seasonalTrackers: [...s.seasonalTrackers]
      .map(([k, v]) => [k, tracker(v, s.seasonalTrackersReceivedAt.get(k) ?? null)] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
    seasonalStamped: [...s.seasonalTrackersReceivedAt.keys()].sort(),
    sessionStatus: s.sessionStatus,
    sessionElapsed: shown(s.sessionElapsed, s.sessionReceivedAt, running),
    sessionStamped: s.sessionReceivedAt !== null,
    accumulatedMapTime: s.accumulatedMapTime, activeSessionId: s.activeSessionId, activeSessionName: s.activeSessionName,
    lowStockWarnings: s.lowStockWarnings.filter(w => !dismissed.has(w.itemId)),
    lootWindowDeadlines: [...s.lootWindowDeadlines].sort((a, b) => a[0].localeCompare(b[0])),
  };
}

/** Every event the renderer can receive. */
const onWire = (e: EngineEvent): e is Exclude<EngineEvent, {type: 'unit_finished'}> => e.type !== 'unit_finished';

function viaReplay(events: EngineEvent[]) {
  const saved = useEngineStore.getState();
  try {
    // Engine.getState() holds no unit_finished; the filter narrows to what the wire carries.
    useEngineStore.getState().applySnapshot({seq: 0, events: events.filter(onWire)});
    return norm(useEngineStore.getState());
  } finally {
    useEngineStore.setState(saved, true);
  }
}

// -- the driver --------------------------------------------------------------

type Op = 'pause' | 'resume' | 'reset';
type Eng = ReturnType<typeof createEngine>;
interface Drive {
  /** Ops to run immediately BEFORE the line with this 0-based index is delivered. */
  ops?:   Record<number, Op>;
  /** Called after every clock advance / line / op with a label. */
  step?:  (label: string, engine: Eng) => void;
  /** Live-store feed on or off (purity runs have no store). */
  store?: boolean;
}

let clock: ReplayClock | null = null;
const dispose = () => { clock?.dispose(); clock = null; };
afterEach(() => { dispose(); useEngineStore.getState().reset(); });

function drive(lines: LogLine[], d: Drive = {}) {
  const events: EngineEvent[] = [];
  const useStore = d.store ?? true;
  if (useStore) useEngineStore.getState().reset();
  clock = installReplayClock(lines[0].ts - 1);
  const dispatcher = createDispatcher();
  const engine = createEngine(ev => { events.push(ev); if (useStore && onWire(ev)) useEngineStore.getState().handleEvent(ev); });
  engine.start({sessionId: 'rl-1', name: 'rl-1'});
  configureEngine(engine, {items: Object.values(GOLDEN_ITEMS), filterRules: null, settings: {}});
  d.step?.('start', engine);
  lines.forEach((line, i) => {
    const op = d.ops?.[i];
    if (op) {
      if (op === 'pause') engine.pause();
      else if (op === 'resume') engine.resume();
      else engine.reset({sessionId: `rl-reset-${i}`, name: `rl-reset-${i}`});
      d.step?.(`${op} @${i}`, engine);
    }
    clock!.advanceTo(line.ts);
    d.step?.(`advance -> line ${line.lineNo}`, engine);
    for (const raw of dispatcher.dispatch(line.text)) {
      if (raw.type !== 'price_update') engine.onRawEvent(raw);
    }
    d.step?.(`line ${line.lineNo}`, engine);
  });
  // run on so every debounce / loot window closes, still checking
  for (let t = 0; t < 12; t++) {
    clock.advanceTo(lines[lines.length - 1].ts + (t + 1) * 5_000);
    d.step?.(`settle ${t}`, engine);
  }
  return {events, engine};
}

interface Seen { n: number; seasonal: boolean; deadline: boolean; paused: boolean; warning: boolean }
const fresh = (): Seen => ({n: 0, seasonal: false, deadline: false, paused: false, warning: false});

const equivalence = (label: string, engine: Eng, c: Seen) => {
  const live = norm(useEngineStore.getState());
  expect(viaReplay(engine.getState()), label).toEqual(live);
  c.n++;
  if (live.seasonalTrackers.length) c.seasonal = true;
  if (live.lootWindowDeadlines.length) c.deadline = true;
  if (live.runStatus === 'paused') c.paused = true;
  if (live.lowStockWarnings.length) c.warning = true;
};

/** Pauses spread across the log, deterministic: every `period` lines for `gap` lines; short logs get a tighter rhythm. */
function pauseOps(len: number): Record<number, Op> {
  const period = Math.min(37, Math.max(4, Math.floor(len / 3)));
  const gap    = Math.max(2, Math.min(9, Math.floor(period / 2)));
  const ops: Record<number, Op> = {};
  for (let i = Math.min(20, period); i + gap < len; i += period) { ops[i] = 'pause'; ops[i + gap] = 'resume'; }
  return ops;
}

describe('replay equals live — every golden log, after every advance and line', () => {
  it.each(NAMES)('%s: uninterrupted', (name) => {
    const lines = logLines(name);
    const c = fresh();
    drive(lines, {step: (label, e) => equivalence(`${name}: ${label}`, e, c)});
    expect(c.n).toBeGreaterThan(lines.length * 2);
  });

  it.each(NAMES)('%s: with pause/resume injected mid-run', (name) => {
    const lines = logLines(name);
    const c = fresh();
    drive(lines, {ops: pauseOps(lines.length), step: (label, e) => equivalence(`${name}: ${label}`, e, c)});
    expect(c.n).toBeGreaterThan(lines.length * 2);
    expect(c.paused).toBe(true);
  });

  it.each(NAMES)('%s: with a reset and a pause around it', (name) => {
    const lines = logLines(name);
    const at = Math.floor(lines.length * 0.6);
    const c = fresh();
    drive(lines, {ops: {[at - 3]: 'pause', [at]: 'reset', [at + 4]: 'resume'}, step: (label, e) => equivalence(`${name}: ${label}`, e, c)});
    expect(c.n).toBeGreaterThan(lines.length);
  });

  it('is not vacuous: seasonals, loot windows and paused states were all compared', () => {
    const c = fresh();
    for (const name of NAMES) {
      const lines = logLines(name);
      drive(lines, {ops: pauseOps(lines.length), step: (label, e) => equivalence(`${name}: ${label}`, e, c)});
      dispose();
    }
    expect(c.seasonal).toBe(true);
    expect(c.deadline).toBe(true);
    expect(c.paused).toBe(true);
  });
});

describe('Engine.getState() is pure — it never changes what the engine emits next', () => {
  // seeded LCG so the "random" call points are reproducible
  const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

  it.each(NAMES)('%s: event stream is identical with and without getState() calls', (name) => {
    const lines = logLines(name);
    const ops = pauseOps(lines.length);
    const plain = drive(lines, {ops, store: false});
    dispose();

    const r = rng(name.length * 7919);
    const probed = drive(lines, {ops, store: false, step: (_l, e) => {
      if (r() < 0.6) { e.getState(); if (r() < 0.3) e.getState(); }
    }});
    expect(probed.events).toEqual(plain.events);
  });

  it('two consecutive calls are equal at every step, and a returned snapshot does not alias engine state', () => {
    const lines = logLines('map-arcana-map');
    drive(lines, {store: false, step: (label, e) => {
      const a = e.getState();
      const b = e.getState();
      expect(b, label).toEqual(a);
      for (const ev of a) if (ev.type === 'tracker_started') { ev.tracker.drops['999999'] = 1; ev.tracker.elapsed = -1; }
      expect(e.getState(), label).toEqual(b);
    }});
  });
});

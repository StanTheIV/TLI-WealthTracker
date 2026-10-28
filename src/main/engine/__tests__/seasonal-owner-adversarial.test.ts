/**
 * Step 1.5 adversarial: the owner-publishing invariant, attacked through the
 * production chain under fake timers. Every emitted event is replayed into an
 * OwnerWatcher (src/test/owner-invariant.ts): the stamp equals writer()===type
 * at emit time, no redundant seasonal update, map/session never carry `owner`,
 * the renderer store agrees; and after every settled step the published
 * `{active, owner}` of every live seasonal equals the engine truth, with at
 * most one owner true, and it is writer().
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import type {EngineEvent} from '@/shared/contracts/engine';
import type {FilterRule} from '@/shared/item-filter';
import {OwnerWatcher} from '@/test/owner-invariant';
import {
  TEST_IDENTITY,
  ARCANA_FIGHT, boot, createDispatcher, createEngineWithEmit, ctx, feed, internalEmit, log, MAP, SANDLORD_HUB, TOWN,
} from './seasonal-fixtures';
import type {Engine} from '@/main/engine/engine';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const A = 9000;   // slot 1
const B = 9001;   // slot 2

type Zone = 'town' | 'map' | 'hub';

function rig() {
  const events: EngineEvent[] = [];
  let e!: Engine;
  const w = new OwnerWatcher({writer: () => ctx(e).registry.writer(), store: true});
  e = createEngineWithEmit(ev => { events.push(ev); w.onEmit(ev); });
  const d = createDispatcher();
  boot(d, e, [{slotId: 1, itemId: A, quantity: 0}, {slotId: 2, itemId: B, quantity: 0}]);
  const reg = () => ctx(e).registry;
  let zone: Zone = 'town';
  const totals: Record<number, number> = {1: 0, 2: 0};
  const scene = (z: Zone) => (z === 'town' ? TOWN : z === 'map' ? MAP : SANDLORD_HUB);

  const settle = (label: string) => {
    w.checkLive(label, {
      writer:    reg().writer(),
      seasonals: [...reg().seasonals()].map(t => ({type: t.seasonalType, active: t.active})),
    });
    expect(w.violations, label).toEqual([]);
  };
  const o = {
    events, e, w, reg, settle, d,
    emit: internalEmit(ev => { events.push(ev); w.onEmit(ev); }),
    line(l: string, label = l.slice(0, 60)) { feed(d, e, l); settle(label); },
    adv(ms: number)  { vi.advanceTimersByTime(ms); settle(`adv ${ms}`); },
    drop(slot: 1 | 2 = 1, n = 1) { totals[slot] += n; feed(d, e, log.bagUpdate(slot, slot === 1 ? A : B, totals[slot])); settle(`drop ${slot}`); },
    go(z: Zone) { if (z === zone) return; feed(d, e, log.zoneTransition(scene(zone), scene(z))); zone = z; settle(`go ${z}`); },
    pause()  { e.pause();  settle('pause'); },
    resume() { e.resume(); settle('resume'); },
    reset()  { e.reset(TEST_IDENTITY);  settle('reset'); },
    rules(r: FilterRule[] | null) { e.setFilterRules(r); },
  };
  o.go('map');
  return o;
}
type Rig = ReturnType<typeof rig>;

const live = (o: Rig) => [...o.reg().seasonals()].map(t => `${t.seasonalType}:${t.active ? 'on' : 'off'}`).sort();

describe('concurrent in-map seasonals: lunaria + carjack + sandlord-map', () => {
  it('interleaved arms, drops, dormancy and wakes keep the published set exact', () => {
    const o = rig();
    o.line(log.s14Strum);
    o.drop();
    o.line(log.s11Start);
    o.drop(2);
    o.line(log.s10Wave);
    expect(o.reg().writer()).toBe('sandlord');
    o.drop();
    o.adv(1_100);
    o.line(log.s14Strum);                    // lunaria re-armed -> owner
    expect(o.reg().writer()).toBe('lunaria');
    o.drop();
    o.line(log.s11Wave);                     // carjack re-armed -> owner
    o.drop(2);
    o.adv(5_100);                            // lunaria dormant
    o.drop();
    o.line(log.s10Land);                     // sandlord re-arm
    o.adv(10_100);                           // sandlord (and others) dormant
    o.drop();
    o.line(log.s10Land);                     // sandlord wakes
    o.line(log.s11Wave);                     // carjack wakes -> owner
    o.drop(1, 2);
    o.line(log.s14Strum);                    // lunaria wakes
    o.drop();
    o.adv(30_000);
    o.drop();
    o.go('town');
    expect(live(o)).toEqual([]);
    expect(o.w.published.size).toBe(0);
  });

  it('each hand-off republishes each side exactly once', () => {
    const o = rig();
    o.line(log.s14Strum);
    o.line(log.s11Start);
    o.line(log.s10Wave);
    o.events.length = 0;
    o.adv(1_100);
    o.line(log.s14Strum);                    // sandlord -> lunaria
    const ups = o.events.flatMap(ev => (ev.type === 'tracker_update' ? [`${ev.tracker.seasonalType}:${String(ev.tracker.owner)}`] : []));
    expect(ups.sort()).toEqual(['lunaria:true', 'sandlord:false']);
  });
});

describe('clockwork claims on/off with another seasonal live', () => {
  it('podium -> cogwheel -> end -> turn-in while afterlight and lunaria are live', () => {
    const o = rig();
    o.line(log.afterlightStart);
    o.line(log.s7Podium);                    // timing-only, never owner
    expect(o.reg().writer()).toBe('afterlight');
    o.drop();
    o.line(log.s14Strum);
    o.line(log.s7Cogwheel);                  // fight phase
    o.drop();
    o.line(log.s7CogwheelEnd);               // parks
    o.drop();
    o.line(log.s7Turnin);                    // claims -> owner of the set
    expect(o.reg().writer()).toBe('clockwork');
    o.drop(2);
    o.line(log.afterlightWave);              // takes it back
    o.drop();
    o.line(log.s7Cogwheel);
    o.line(log.s7CogwheelEnd);
    o.line(log.s7Fail);
    o.adv(10_100);
    o.drop();
    o.go('town');
  });

  it('claims flip during a live fight, then a session pause/resume', () => {
    const o = rig();
    o.line(log.s7Podium);
    o.line(log.s7Cogwheel);
    o.line(log.s11Start);
    o.line(log.s7Turnin);
    o.pause();
    o.resume();
    o.drop();
    o.line(log.s7CogwheelEnd);
    o.pause();
    o.line(log.s7Cogwheel);
    o.resume();
    o.drop();
  });
});

describe('session pause / resume with 0..3 live seasonals', () => {
  it('0 live', () => {
    const o = rig();
    o.pause(); o.resume(); o.drop();
  });

  it('1 live', () => {
    const o = rig();
    o.line(log.s10Wave);
    o.pause(); o.resume(); o.drop();
    o.pause(); o.pause(); o.resume(); o.resume();
  });

  it('2 live, one self-parked (lunaria after its expiry)', () => {
    const o = rig();
    o.line(log.s14Strum);
    o.line(log.afterlightStart);
    o.adv(5_100);                            // lunaria self-paused
    expect(o.reg().seasonal('lunaria')!.active).toBe(false);
    o.pause();
    o.resume();
    expect(o.reg().seasonal('lunaria')!.active).toBe(false);   // not woken by the resume
    o.drop();
    o.line(log.s14Strum);                    // woken by gameplay
    o.drop();
  });

  it('3 live: owner, self-parked and timing-only', () => {
    const o = rig();
    o.line(log.s14Strum);
    o.line(log.s7Podium);
    o.line(log.s7Cogwheel);                  // clockwork live, timing-only
    o.line(log.s11Start);
    o.adv(5_100);
    o.line(log.s11Wave);
    o.line(log.s7Cogwheel);
    o.pause();
    o.resume();
    o.drop();
    o.pause();
    o.line(log.s11Wave);                     // gameplay while paused
    o.resume();
    o.drop();
  });

  it('pause during a loot window: the frozen window resumes, nothing flickers', () => {
    const o = rig();
    o.line(log.s10Wave);
    o.line(log.afterlightStart);
    o.adv(2_000);
    o.line(log.s12Entry);
    o.line(log.s12Exit);                     // overrealm loot window armed
    o.pause();
    o.adv(60_000);                           // frozen: nothing may expire
    expect(o.reg().seasonal('overrealm')).not.toBeNull();
    o.resume();
    o.drop();
    o.adv(5_100);                            // window expires -> overrealm finishes while owning
    o.drop();
  });

  it('a seasonal started while paused is frozen, then resumed with the right owner', () => {
    const o = rig();
    o.line(log.s11Start);
    o.pause();
    o.line(log.s14Strum);
    o.line(log.afterlightStart);
    o.resume();
    o.drop();
  });
});

describe('bubble start evicts in-map seasonals', () => {
  it('hub transition with three live seasonals', () => {
    const o = rig();
    o.line(log.s14Strum);
    o.line(log.s11Start);
    o.line(log.afterlightStart);
    o.drop();
    o.go('hub');
    expect(live(o)).toEqual(['sandlord:on']);
    expect(o.reg().writer()).toBe('sandlord');
    o.drop();
    o.line(log.s14Strum);                    // ignored under the bubble
    o.pause(); o.resume();
    o.go('town');
  });

  it('hub transition while paused', () => {
    const o = rig();
    o.line(log.s14Strum);
    o.line(log.s7Podium);
    o.pause();
    o.go('hub');
    o.resume();
    o.drop();
    o.go('town');
  });
});

describe('a seasonal finishing while it owns', () => {
  it('ownership falls to the next newest, which republishes owner:true exactly once', () => {
    const o = rig();
    o.line(log.afterlightStart);
    o.reg().startSeasonal({type: 'carjack', lootDurationMs: 60_000}, o.emit);   // outlives overrealm's window
    o.settle('carjack started');
    o.line(log.s12Entry);                    // overrealm newest -> owns
    expect(o.reg().writer()).toBe('overrealm');
    o.drop();
    o.line(log.s12Exit);                     // loot window
    o.events.length = 0;
    o.adv(5_100);                            // overrealm finishes
    expect(o.reg().seasonal('overrealm')).toBeNull();
    expect(o.reg().writer()).toBe('carjack');
    const carjack = o.events.flatMap(ev => (ev.type === 'tracker_update' && ev.tracker.seasonalType === 'carjack' ? [ev.tracker.owner] : []));
    expect(carjack).toEqual([true]);
    o.drop();
  });

  it('the next newest is timing-only: ownership falls past it to the map (no seasonal owner)', () => {
    const o = rig();
    o.line(log.s7Podium);                    // timing-only
    o.line(log.s12Entry);
    o.line(log.s12Exit);
    o.adv(5_100);
    expect(o.reg().writer()).toBe('map');
    o.drop();
  });
});

describe('arcana interlude with an in-map seasonal live', () => {
  it('minigame pauses the map; backing out resumes it', () => {
    const o = rig();
    o.line(log.afterlightStart);
    o.line(log.s10Wave);
    o.line(log.s9Minigame);
    o.drop();
    o.line(log.s9Close);
    o.drop();
    o.line(log.s9Minigame);
    o.line(log.s9Fight);
    o.drop();
    o.pause(); o.resume();
    o.adv(10_000);
    o.drop();
  });

  it('into the arcana fight scene and back', () => {
    const o = rig();
    o.line(log.s14Strum);
    o.line(log.s10Wave);
    o.line(log.s9Minigame);
    feed(o.d, o.e, log.zoneTransition(MAP, ARCANA_FIGHT));
    o.settle('to fight');
    o.drop();
    feed(o.d, o.e, log.zoneTransition(ARCANA_FIGHT, MAP));
    o.settle('back');
    o.drop();
    o.adv(10_100);
    o.go('town');
  });
});

describe('Engine.reset mid-run', () => {
  it('with live seasonals, parked ones, and a pending loot window; the next run starts clean', () => {
    const o = rig();
    o.line(log.s14Strum);
    o.line(log.s10Wave);
    o.line(log.afterlightStart);
    o.line(log.s12Entry);
    o.line(log.s12Exit);
    o.adv(5_100);
    o.reset();
    expect(live(o)).toEqual([]);
    expect(o.w.published.size).toBe(0);
    o.adv(60_000);                           // no stale timer may publish
    o.line(log.s10Wave);
    o.drop();
    o.line(log.s11Start);
    o.drop();
  });

  it('while paused', () => {
    const o = rig();
    o.line(log.s14Strum);
    o.line(log.s11Start);
    o.pause();
    o.reset();
    o.resume();
    o.line(log.s11Start);
    o.drop();
  });

  it('reset in a hub', () => {
    const o = rig();
    o.go('hub');
    o.drop();
    o.reset();
    o.drop();
  });
});

describe('finishAll at town', () => {
  it('town entry with owner + parked + timing-only seasonals finishes each, nothing left published', () => {
    const o = rig();
    o.line(log.s14Strum);
    o.line(log.s7Podium);
    o.line(log.s11Start);
    o.line(log.s10Wave);
    o.adv(5_100);
    o.drop();
    o.go('town');
    expect(live(o)).toEqual([]);
    expect(o.w.published.size).toBe(0);
    o.go('map');
    o.line(log.s10Wave);
    o.drop();
  });
});

describe('a drop rejected by the item filter for one tracker but not another', () => {
  const hide = (itemId: number, scopes: FilterRule['scopes']): FilterRule =>
    ({id: `r${itemId}${scopes.join('')}`, action: 'hide', kind: {type: 'by-item', itemId: String(itemId)}, scopes});

  it('owner hides the item: no seasonal update, map still updates, a later hand-off is exact', () => {
    const o = rig();
    o.rules([hide(B, ['sandlord'])]);
    o.line(log.afterlightStart);
    o.line(log.s10Wave);
    o.events.length = 0;
    o.drop(2);
    expect(o.events.filter(ev => ev.type === 'tracker_update' && ev.tracker.seasonalType === 'sandlord')).toEqual([]);
    expect(o.events.some(ev => ev.type === 'tracker_update' && ev.tracker.kind === 'map')).toBe(true);
    o.adv(1_100);
    o.line(log.afterlightWave);
    o.drop(2);                               // afterlight owns, accepts it
    expect(o.events.some(ev => ev.type === 'tracker_update' && ev.tracker.seasonalType === 'afterlight')).toBe(true);
  });

  it('hidden for the session too, then rules cleared live', () => {
    const o = rig();
    o.rules([hide(B, ['session', 'sandlord', 'lunaria'])]);
    o.line(log.s14Strum);
    o.line(log.s10Wave);
    o.drop(2);
    o.drop(1);
    o.rules(null);
    o.drop(2);
    o.rules([hide(A, ['lunaria', 'carjack'])]);
    o.line(log.s11Start);
    o.drop(1);
    o.drop(2);
  });
});

// ---------------------------------------------------------------------------
// Seeded random walk over the whole menu
// ---------------------------------------------------------------------------

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LINES = [
  log.s14Strum, log.s11Start, log.s11Wave, log.s11End,
  log.s10Wave, log.s10Land, log.s10Quench, log.s10WaveResource,
  log.afterlightStart, log.afterlightWave, log.afterlightEnd, log.afterlightSpecialStart, log.afterlightSpecialEnd,
  log.s7Podium, log.s7Cogwheel, log.s7CogwheelEnd, log.s7Turnin, log.s7Fail,
  log.huntingStatue, log.huntingBossStart, log.huntingBossEnd,
  log.s12Entry, log.s12Exit, log.s9Minigame, log.s9Fight, log.s9Close,
  log.s13Start, log.s13WindowClose, log.s16BoardOpen, log.s16BoardClose, log.s16Ignore,
];
const FILTER_SCOPES = ['sandlord', 'carjack', 'lunaria', 'afterlight', 'session', 'map'] as const;

describe('seeded random walk', () => {
  const SEEDS = Array.from({length: 120}, (_, i) => i + 1);
  it.each(SEEDS)('seed %i', (seed) => {
    const rnd  = prng(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const o    = rig();
    const trail: string[] = [];
    try {
      for (let i = 0; i < 70; i++) {
        const r = rnd();
        if (r < 0.50)       { const l = pick(LINES); trail.push(l.slice(0, 50)); o.line(l); }
        else if (r < 0.68)  { const s = pick([1, 2] as const); trail.push(`drop${s}`); o.drop(s); }
        else if (r < 0.84)  { const ms = pick([400, 1_100, 3_000, 5_100, 10_100, 30_000]); trail.push(`adv${ms}`); o.adv(ms); }
        else if (r < 0.89)  { trail.push('pause');  o.pause(); }
        else if (r < 0.94)  { trail.push('resume'); o.resume(); }
        else if (r < 0.955) { trail.push('reset');  o.reset(); }
        else if (r < 0.97)  {
          trail.push('filter');
          o.rules(rnd() < 0.5 ? null : [{id: 'f', action: 'hide', kind: {type: 'by-item', itemId: String(pick([A, B]))}, scopes: [pick(FILTER_SCOPES)]}]);
        } else              { const z = pick(['town', 'map', 'hub'] as const); trail.push(`go ${z}`); o.go(z); }
      }
    } catch (err) {
      throw new Error(`seed ${seed} trail: ${trail.join(' | ')}\n${String(err)}`);
    }
  });
});

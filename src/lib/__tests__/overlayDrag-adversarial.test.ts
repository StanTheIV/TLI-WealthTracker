import {describe, it, expect} from 'vitest';
import {createOverlayDrag, type OverlayDrag} from '@/lib/overlayDrag';

type Call = ['moveBy', number, number] | ['dragEnd'];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function harness(onMove?: (d: OverlayDrag) => void, onEnd?: (d: OverlayDrag) => void) {
  const calls: Call[] = [];
  const ref: {d?: OverlayDrag} = {};
  ref.d = createOverlayDrag({
    moveBy: (dx, dy) => { calls.push(['moveBy', dx, dy]); onMove?.(ref.d!); },
    dragEnd: () => { calls.push(['dragEnd']); onEnd?.(ref.d!); },
  });
  return {drag: ref.d, calls};
}

describe('overlay drag: seeded random sequences', () => {
  it.each([1, 2, 3, 7, 42, 1234, 99999])('invariants hold for seed %i', seed => {
    const r = rng(seed);
    const {drag, calls} = harness();
    let active = false;
    let last = {x: 0, y: 0};
    let sumX = 0, sumY = 0, startX = 0, startY = 0, moved = false;
    let expectedEnds = 0;
    let idx = 0;
    const closeModel = () => {
      if (!active) return;
      active = false;
      if (moved) {
        expectedEnds++;
        expect(sumX).toBeCloseTo(last.x - startX, 6);
        expect(sumY).toBeCloseTo(last.y - startY, 6);
      }
    };
    const drain = () => {
      for (; idx < calls.length; idx++) {
        const c = calls[idx];
        if (c[0] === 'moveBy') { sumX += c[1]; sumY += c[2]; }
      }
    };
    for (let i = 0; i < 3000; i++) {
      const op = Math.floor(r() * 7);
      const x = Math.round(r() * 4000 - 2000) / (r() < 0.3 ? 4 : 1);
      const y = Math.round(r() * 4000 - 2000) / (r() < 0.3 ? 4 : 1);
      if (op === 0) {
        drag.start(x, y);
        drain();
        closeModel();
        active = true; moved = false; sumX = sumY = 0; startX = x; startY = y; last = {x, y};
      } else if (op <= 3) {
        drag.move(x, y, 1);
        if (active && !(x === last.x && y === last.y)) { moved = true; last = {x, y}; }
        drain();
      } else if (op === 4) {
        drag.move(x, y, 0);
        drain();
        closeModel();
      } else {
        drag.end();
        drain();
        closeModel();
      }
    }
    drag.end();
    drain();
    closeModel();
    // never a moveBy after dragEnd until a start: a dragEnd is always preceded by a moveBy
    let open = false, ends = 0;
    for (const c of calls) {
      if (c[0] === 'moveBy') open = true;
      else { expect(open).toBe(true); open = false; ends++; }
    }
    expect(open).toBe(false);
    expect(ends).toBe(expectedEnds);
  });
});

describe('overlay drag: re-entrancy', () => {
  it('a moveBy port that ends the drag synchronously yields exactly one dragEnd', () => {
    const {drag, calls} = harness(d => d.end());
    drag.start(0, 0);
    drag.move(5, 5, 1);
    drag.move(9, 9, 1);
    drag.end();
    expect(calls).toEqual([['moveBy', 5, 5], ['dragEnd']]);
  });

  it('a dragEnd port that starts a drag leaves the new drag usable', () => {
    let once = true;
    const {drag, calls} = harness(undefined, d => { if (once) { once = false; d.start(50, 50); } });
    drag.start(0, 0);
    drag.move(1, 1, 1);
    drag.end();
    drag.move(52, 50, 1);
    drag.end();
    expect(calls).toEqual([['moveBy', 1, 1], ['dragEnd'], ['moveBy', 2, 0], ['dragEnd']]);
  });

  it('a dragEnd port that calls end again is idempotent', () => {
    const {drag, calls} = harness(undefined, d => d.end());
    drag.start(0, 0);
    drag.move(1, 0, 1);
    drag.end();
    expect(calls).toEqual([['moveBy', 1, 0], ['dragEnd']]);
  });
});

describe('overlay drag: odd coordinates', () => {
  it('passes fractional deltas through unrounded (main rounds)', () => {
    const {drag, calls} = harness();
    drag.start(0.25, 0.5);
    drag.move(0.75, 1.0, 1);
    expect(calls).toEqual([['moveBy', 0.5, 0.5]]);
  });

  it('huge coordinates still give exact integer steps', () => {
    const {drag, calls} = harness();
    drag.start(1e9, -1e9);
    drag.move(1e9 + 3, -1e9 - 4, 1);
    expect(calls).toEqual([['moveBy', 3, -4]]);
  });

  it('negative multi-monitor coordinates stream normally', () => {
    const {drag, calls} = harness();
    drag.start(-1920, -10);
    drag.move(-1900, -5, 1);
    expect(calls).toEqual([['moveBy', 20, 5]]);
  });

  it('a NaN coordinate sends NaN deltas (main ignores); the stream recovers afterwards', () => {
    const {drag, calls} = harness();
    drag.start(0, 0);
    drag.move(NaN, 5, 1);
    drag.move(10, 10, 1);
    drag.move(12, 10, 1);
    const finite = calls.filter(c => c[0] === 'moveBy' && Number.isFinite(c[1]) && Number.isFinite(c[2]));
    // Questionable but acceptable: NaN only comes from a broken event source; the step after
    // a NaN is NaN too (one delta lost), then the stream is consistent again.
    expect(finite).toEqual([['moveBy', 2, 0]]);
    expect(calls.filter(c => c[0] === 'dragEnd')).toEqual([]);
    drag.end();
    expect(calls[calls.length - 1]).toEqual(['dragEnd']);
  });

  it('Infinity coordinates only ever produce non-finite deltas', () => {
    const {drag, calls} = harness();
    drag.start(0, 0);
    drag.move(Infinity, 0, 1);
    for (const c of calls) {
      if (c[0] === 'moveBy') expect(Number.isFinite(c[1])).toBe(false);
    }
  });
});

describe('overlay drag: lifecycle', () => {
  it('repeated buttons=0 moves end a moved drag exactly once', () => {
    const {drag, calls} = harness();
    drag.start(0, 0);
    drag.move(3, 0, 1);
    drag.move(3, 0, 0);
    drag.move(3, 0, 0);
    drag.end();
    expect(calls).toEqual([['moveBy', 3, 0], ['dragEnd']]);
  });

  it('start after a missed mouseup closes the previous moved drag first', () => {
    const {drag, calls} = harness();
    drag.start(0, 0);
    drag.move(2, 2, 1);
    drag.start(10, 10);
    drag.move(11, 10, 1);
    drag.end();
    expect(calls).toEqual([['moveBy', 2, 2], ['dragEnd'], ['moveBy', 1, 0], ['dragEnd']]);
  });

  it('a moved-then-returned drag (net zero) still ends once', () => {
    const {drag, calls} = harness();
    drag.start(0, 0);
    drag.move(5, 0, 1);
    drag.move(0, 0, 1);
    drag.end();
    expect(calls.filter(c => c[0] === 'dragEnd').length).toBe(1);
  });
});

import {describe, it, expect} from 'vitest';
import {OverlayPosition, readSavedOverlayPosition} from '@/main/overlay-position';

function harness(start: [number, number] = [100, 200]) {
  const state: {pos: [number, number]; alive: boolean} = {pos: start, alive: true};
  const writes: [string, string][] = [];
  const position = new OverlayPosition({
    getPosition: () => (state.alive ? state.pos : null),
    setPosition: (x, y) => { state.pos = [x, y]; },
    settingsSet: (k, v) => { writes.push([k, v]); },
  });
  return {state, writes, position};
}

describe('OverlayPosition adversarial', () => {
  it('window destroyed mid-drag: moves and persist become no-ops, no throw', () => {
    const {state, writes, position} = harness();
    position.moveBy(5, 5);
    state.alive = false;
    expect(() => { position.moveBy(5, 5); position.persist(); }).not.toThrow();
    expect(state.pos).toEqual([105, 205]);
    expect(writes).toEqual([]);
  });

  it('negative coordinates move and persist as plain signed strings', () => {
    const {state, writes, position} = harness([-1920, -50]);
    position.moveBy(-10, -10);
    expect(state.pos).toEqual([-1930, -60]);
    position.persist();
    expect(writes).toEqual([['tracker_window_x', '-1930'], ['tracker_window_y', '-60']]);
  });

  it('a stream of sub-half-pixel deltas never moves the window (rounding loses them)', () => {
    // Judged acceptable: real mouse screenX/Y deltas are integers; pinned so a change is noticed.
    const {state, position} = harness([100, 100]);
    for (let i = 0; i < 1000; i++) position.moveBy(0.4, -0.4);
    expect(state.pos).toEqual([100, 100]);
  });

  it('0.8px deltas (fractional DPI scaling) move 1px per event, drifting ahead of the mouse', () => {
    const {state, position} = harness([0, 0]);
    for (let i = 0; i < 100; i++) position.moveBy(0.8, 0);
    // The mouse travelled 80px; the window moved 100px. Questionable, bounded to fractional scaling.
    expect(state.pos[0]).toBe(100);
  });

  it('persist after many moves writes exactly the final position once per key', () => {
    const {state, writes, position} = harness([0, 0]);
    for (let i = 0; i < 500; i++) position.moveBy(3, -2);
    expect(writes).toEqual([]);
    position.persist();
    expect(state.pos).toEqual([1500, -1000]);
    expect(writes).toEqual([['tracker_window_x', '1500'], ['tracker_window_y', '-1000']]);
  });

  it('persist is repeatable with identical values', () => {
    const {writes, position} = harness();
    position.persist();
    position.persist();
    expect(writes.length).toBe(4);
    expect(writes.slice(0, 2)).toEqual(writes.slice(2));
  });

  it('a huge finite delta is applied unclamped (restore-time visibility check is the guard)', () => {
    const {state, writes, position} = harness([0, 0]);
    position.moveBy(1e12, -1e12);
    expect(state.pos).toEqual([1e12, -1e12]);
    position.persist();
    expect(writes[0]).toEqual(['tracker_window_x', '1000000000000']);
  });

  it('finite deltas whose sum overflows to Infinity still reach setPosition', () => {
    // Questionable, unreachable from real input.
    const {state, position} = harness([Number.MAX_VALUE, 0]);
    position.moveBy(Number.MAX_VALUE, 0);
    expect(state.pos[0]).toBe(Infinity);
  });

  it('a non-finite delta with the window gone does not throw', () => {
    const {state, position} = harness();
    state.alive = false;
    expect(() => position.moveBy(NaN, NaN)).not.toThrow();
  });
});

describe('readSavedOverlayPosition adversarial', () => {
  const yes = () => true;
  const read = (x?: string, y?: string, vis: (x: number, y: number) => boolean = yes) => {
    const s: Record<string, string> = {};
    if (x !== undefined) s.tracker_window_x = x;
    if (y !== undefined) s.tracker_window_y = y;
    return readSavedOverlayPosition(s, vis);
  };

  it('empty and missing values are null', () => {
    expect(read('', '')).toBeNull();
    expect(read('10')).toBeNull();
    expect(read(undefined, '10')).toBeNull();
    expect(read()).toBeNull();
    expect(read('10', '')).toBeNull();
  });

  it('parseInt leniency: trailing junk and surrounding whitespace are accepted', () => {
    // Questionable but acceptable: a hand-edited "12abc" restores as 12.
    expect(read('12abc', '7')).toEqual({x: 12, y: 7});
    expect(read(' 12', ' 7 ')).toEqual({x: 12, y: 7});
  });

  it('non-numeric is null', () => {
    expect(read('abc', '1')).toBeNull();
    expect(read('1', 'NaN')).toBeNull();
    expect(read('Infinity', '1')).toBeNull();
    expect(read('0x10', '1')).toEqual({x: 0, y: 1});
  });

  it('decimals truncate and exponent notation does not expand', () => {
    expect(read('12.9', '7.9')).toEqual({x: 12, y: 7});
    expect(read('1e3', '2e3')).toEqual({x: 1, y: 2});
    expect(Object.is(read('-0', '5')?.x, -0)).toBe(true);
  });

  it('negative values reach the visibility check unchanged', () => {
    const seen: [number, number][] = [];
    read('-1920', '-30', (x, y) => { seen.push([x, y]); return true; });
    expect(seen).toEqual([[-1920, -30]]);
  });

  it('huge values reach the visibility check and are rejected by it', () => {
    const vis = (x: number, y: number) => Math.abs(x) < 1e5 && Math.abs(y) < 1e5;
    expect(read('99999999999999999999', '1', vis)).toBeNull();
    expect(read('1', '5', vis)).toEqual({x: 1, y: 5});
  });

  it('not visible is null; unparseable input never reaches the visibility check', () => {
    let calls = 0;
    expect(read('5', '5', () => { calls++; return false; })).toBeNull();
    expect(calls).toBe(1);
    read('x', '5', () => { calls++; return true; });
    expect(calls).toBe(1);
  });

  it('only the tracker_window keys are read', () => {
    expect(readSavedOverlayPosition({main_window_x: '1', main_window_y: '2'}, yes)).toBeNull();
  });
});

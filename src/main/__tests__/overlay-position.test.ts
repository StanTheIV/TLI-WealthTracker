import {describe, it, expect} from 'vitest';
import {OverlayPosition, readSavedOverlayPosition} from '@/main/overlay-position';

/** A fake overlay window plus a recording settings store. `alive = false`
 *  stands in for "no overlay / destroyed" (getPosition → null). */
function harness(start: [number, number] = [100, 200]) {
  const state = {pos: start, alive: true};
  const writes: [string, string][] = [];
  const position = new OverlayPosition({
    getPosition: () => (state.alive ? state.pos : null),
    setPosition: (x, y) => { state.pos = [x, y]; },
    settingsSet: (key, value) => { writes.push([key, value]); },
  });
  return {state, writes, position};
}

describe('OverlayPosition.moveBy', () => {
  it('shifts by the delta from the current position, rounding to whole pixels', () => {
    const {state, position} = harness([100, 200]);
    position.moveBy(5, -3);
    expect(state.pos).toEqual([105, 197]);
    position.moveBy(0.4, 0.6);
    expect(state.pos).toEqual([105, 198]);
    position.moveBy(-1.5, 2.5);
    expect(state.pos).toEqual([104, 201]);
  });

  it('moves from the window position, not from a cached anchor', () => {
    const {state, position} = harness([0, 0]);
    position.moveBy(10, 10);
    state.pos = [500, 500]; // moved by something else (e.g. the OS) between events
    position.moveBy(1, 2);
    expect(state.pos).toEqual([501, 502]);
  });

  it('ignores a non-finite delta', () => {
    const {state, position} = harness([100, 200]);
    for (const [dx, dy] of [[NaN, 1], [1, NaN], [Infinity, 0], [0, -Infinity]]) {
      position.moveBy(dx, dy);
    }
    // Garbage over IPC: Number.isFinite doesn't coerce.
    position.moveBy('5' as unknown as number, 1);
    position.moveBy(1, null as unknown as number);
    position.moveBy(undefined as unknown as number, undefined as unknown as number);
    expect(state.pos).toEqual([100, 200]);
  });

  it('never writes settings', () => {
    const {writes, position} = harness();
    for (let i = 0; i < 50; i++) position.moveBy(1, 1);
    expect(writes).toEqual([]);
  });

  it('is a no-op without a live overlay', () => {
    const {state, position} = harness([100, 200]);
    state.alive = false;
    position.moveBy(5, 5);
    expect(state.pos).toEqual([100, 200]);
  });
});

describe('OverlayPosition.persist', () => {
  it('writes the CURRENT window position as strings', () => {
    const {state, writes, position} = harness([100, 200]);
    position.moveBy(7, 8);
    position.moveBy(-2, 1);
    position.persist();
    expect(writes).toEqual([['tracker_window_x', '105'], ['tracker_window_y', '209']]);

    state.pos = [-1920, 40]; // left-hand monitor: negative coordinates are legit
    writes.length = 0;
    position.persist();
    expect(writes).toEqual([['tracker_window_x', '-1920'], ['tracker_window_y', '40']]);
  });

  it('writes on every call (the close safety net may follow a drag-end)', () => {
    const {writes, position} = harness([1, 2]);
    position.persist();
    position.persist();
    expect(writes).toHaveLength(4);
  });

  it('writes nothing without a live overlay', () => {
    const {state, writes, position} = harness();
    state.alive = false;
    position.persist();
    expect(writes).toEqual([]);
  });

  it('round-trips through readSavedOverlayPosition', () => {
    const {writes, position} = harness([321, -45]);
    position.persist();
    expect(readSavedOverlayPosition(Object.fromEntries(writes), () => true)).toEqual({x: 321, y: -45});
  });
});

describe('readSavedOverlayPosition', () => {
  const visible = () => true;

  it('parses a saved position', () => {
    expect(readSavedOverlayPosition({tracker_window_x: '40', tracker_window_y: '80'}, visible))
      .toEqual({x: 40, y: 80});
    expect(readSavedOverlayPosition({tracker_window_x: '-1500', tracker_window_y: '0'}, visible))
      .toEqual({x: -1500, y: 0});
  });

  it('keeps parseInt semantics for legacy values', () => {
    expect(readSavedOverlayPosition({tracker_window_x: '12.7', tracker_window_y: ' 30px'}, visible))
      .toEqual({x: 12, y: 30});
  });

  it('returns null when either key is missing or unparseable', () => {
    expect(readSavedOverlayPosition({}, visible)).toBeNull();
    expect(readSavedOverlayPosition({tracker_window_x: '10'}, visible)).toBeNull();
    expect(readSavedOverlayPosition({tracker_window_y: '10'}, visible)).toBeNull();
    expect(readSavedOverlayPosition({tracker_window_x: '',    tracker_window_y: '10'}, visible)).toBeNull();
    expect(readSavedOverlayPosition({tracker_window_x: 'abc', tracker_window_y: '10'}, visible)).toBeNull();
    expect(readSavedOverlayPosition({tracker_window_x: '10',  tracker_window_y: 'NaN'}, visible)).toBeNull();
  });

  it('returns null when the position is on no display, checking the parsed values', () => {
    const seen: [number, number][] = [];
    const offscreen = (x: number, y: number) => { seen.push([x, y]); return false; };
    expect(readSavedOverlayPosition({tracker_window_x: '5000', tracker_window_y: '6000'}, offscreen)).toBeNull();
    expect(seen).toEqual([[5000, 6000]]);
  });

  it('skips the visibility check when nothing parses', () => {
    let called = false;
    readSavedOverlayPosition({tracker_window_x: 'x'}, () => { called = true; return true; });
    expect(called).toBe(false);
  });
});

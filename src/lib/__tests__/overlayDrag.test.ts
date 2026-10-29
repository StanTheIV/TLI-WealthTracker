import {describe, it, expect} from 'vitest';
import {createOverlayDrag} from '@/lib/overlayDrag';

function harness() {
  const calls: (['moveBy', number, number] | ['dragEnd'])[] = [];
  const drag = createOverlayDrag({
    moveBy:  (dx, dy) => { calls.push(['moveBy', dx, dy]); },
    dragEnd: () => { calls.push(['dragEnd']); },
  });
  const dragEnds = () => calls.filter(c => c[0] === 'dragEnd').length;
  return {drag, calls, dragEnds};
}

const PRESSED = 1;

describe('createOverlayDrag', () => {
  it('streams deltas between consecutive moves and ends once on mouseup', () => {
    const {drag, calls} = harness();
    drag.start(100, 100);
    drag.move(105, 98, PRESSED);
    drag.move(110, 100, PRESSED);
    drag.end();
    expect(calls).toEqual([['moveBy', 5, -2], ['moveBy', 5, 2], ['dragEnd']]);
  });

  it('ignores moves and ends outside a drag', () => {
    const {drag, calls} = harness();
    drag.move(10, 10, PRESSED);
    drag.move(20, 20, 0);
    drag.end();
    expect(calls).toEqual([]);
  });

  it('sends no dragEnd for a click that never moved', () => {
    const {drag, calls} = harness();
    drag.start(50, 50);
    drag.move(50, 50, PRESSED); // zero delta: no IPC, not a move
    drag.end();
    expect(calls).toEqual([]);
  });

  it('ends on a mousemove with no buttons pressed (the release was missed)', () => {
    const {drag, calls} = harness();
    drag.start(0, 0);
    drag.move(3, 4, PRESSED);
    drag.move(40, 40, 0);       // released outside the window: no further move
    drag.move(60, 60, PRESSED); // no drag open any more
    expect(calls).toEqual([['moveBy', 3, 4], ['dragEnd']]);
  });

  it('sends exactly one dragEnd when several end signals arrive (mouseup, blur, unmount)', () => {
    const {drag, dragEnds} = harness();
    drag.start(0, 0);
    drag.move(1, 1, PRESSED);
    drag.end();          // mouseup
    drag.end();          // window blur
    drag.end();          // handle unmount
    drag.move(5, 5, 0);  // stray buttons=0 move
    expect(dragEnds()).toBe(1);
  });

  it('ends a still-open drag before a new mousedown starts the next one', () => {
    const {drag, calls} = harness();
    drag.start(0, 0);
    drag.move(10, 0, PRESSED);
    drag.start(200, 200); // the previous mouseup never arrived
    drag.move(201, 202, PRESSED);
    drag.end();
    expect(calls).toEqual([['moveBy', 10, 0], ['dragEnd'], ['moveBy', 1, 2], ['dragEnd']]);
  });

  it('sends nothing for restarted drags that never moved', () => {
    const {drag, calls} = harness();
    drag.start(0, 0);
    drag.start(5, 5);
    drag.end();
    expect(calls).toEqual([]);
  });

  it('does not carry "moved" into the next drag', () => {
    const {drag, dragEnds} = harness();
    drag.start(0, 0);
    drag.move(1, 0, PRESSED);
    drag.end();
    drag.start(1, 0);
    drag.end();
    expect(dragEnds()).toBe(1);
  });

  it('counts a drag back to its start as moved', () => {
    const {drag, calls} = harness();
    drag.start(0, 0);
    drag.move(5, 0, PRESSED);
    drag.move(0, 0, PRESSED);
    drag.end();
    expect(calls).toEqual([['moveBy', 5, 0], ['moveBy', -5, 0], ['dragEnd']]);
  });
});

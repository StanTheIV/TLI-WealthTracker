/** 5.1b: runShutdownSteps — every step runs, each isolated, never throws. */
import {describe, it, expect, vi} from 'vitest';
import {runShutdownSteps as run} from '@/main/shutdown';
import {describeError} from '@/shared/describe-error';

describe('runShutdownSteps', () => {
  it('runs every step in order', () => {
    const calls: string[] = [];
    run([{name: 'a', run: () => { calls.push('a'); }}, {name: 'b', run: () => { calls.push('b'); }}], {error: vi.fn()});
    expect(calls).toEqual(['a', 'b']);
  });

  it('a throwing step is logged (app, step name, describeError text) and later steps still run', () => {
    const error = vi.fn();
    const boom = new Error('disk full');
    const after = vi.fn();
    run([{name: 'persist-bounds', run: () => { throw boom; }}, {name: 'overlay', run: after}], {error});
    expect(after).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe('app');
    expect(error.mock.calls[0][1]).toContain('persist-bounds');
    expect(error.mock.calls[0][1]).toContain(describeError(boom));
  });

  it.each<[string, unknown]>([
    ['string', 'oops'], ['null', null], ['symbol', Symbol('s')], ['null-prototype object', Object.create(null)], ['undefined', undefined],
  ])('never throws, even for a thrown %s', async (_n, thrown) => {
    const error = vi.fn();
    const last = vi.fn();
    expect(() => run([{name: 'x', run: () => { throw thrown; }}, {name: 'y', run: last}], {error})).not.toThrow();
    expect(last).toHaveBeenCalled();
    expect(error.mock.calls[0][1]).toContain(describeError(thrown));
  });

  it('every step failing logs one line each; an empty list is fine', () => {
    const error = vi.fn();
    run([{name: 'a', run: () => { throw new Error('1'); }}, {name: 'b', run: () => { throw new Error('2'); }}], {error});
    expect(error).toHaveBeenCalledTimes(2);
    expect(() => run([], {error})).not.toThrow();
  });
});

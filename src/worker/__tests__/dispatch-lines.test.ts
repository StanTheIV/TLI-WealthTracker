/** 5.1c — dispatchLines: a throwing line is reported and skipped; Dispatcher itself stays loud. */
import {describe, it, expect, vi} from 'vitest';
import {Dispatcher} from '../dispatcher';
import type {Processor, RawEvent} from '../processors/types';
import {dispatchLines} from '../dispatch-lines';
import {describeError} from '@/shared/describe-error';

const levelType = (n: number): RawEvent => ({type: 'level_type', levelType: n});

/** Emits one event per line (`ok:<n>`), none for `skip`, throws for lines starting with `bad`. */
function dispatcherWith(err: unknown = new Error('processor-boom')): Dispatcher {
  const d = new Dispatcher();
  const p: Processor = {
    name: 'test',
    test: () => true,
    process: (line) => {
      if (line.startsWith('bad')) throw err;
      if (line.startsWith('ok:')) return levelType(Number(line.slice(3)));
      return null;
    },
  };
  d.register(p);
  return d;
}

describe('dispatchLines', () => {
  it('posts every line\'s events in line order', () => {
    const post = vi.fn();
    dispatchLines(dispatcherWith(), ['ok:1', 'skip', 'ok:2', 'ok:3'], post, vi.fn());
    expect(post.mock.calls.map(c => c[0])).toEqual([levelType(1), levelType(2), levelType(3)]);
  });

  it('a throwing line posts nothing, reports describeError + the line cut to 200 chars, and later lines continue', () => {
    const err = new Error('processor-boom');
    const post = vi.fn();
    const report = vi.fn();
    const badLine = 'bad' + 'x'.repeat(300) + 'TAILMARK';

    dispatchLines(dispatcherWith(err), ['ok:1', badLine, 'ok:2'], post, report);

    expect(post.mock.calls.map(c => c[0])).toEqual([levelType(1), levelType(2)]);
    expect(report).toHaveBeenCalledTimes(1);
    const message = String(report.mock.calls[0][0]);
    expect(message).toContain(describeError(err));
    expect(message).toContain(badLine.slice(0, 200));
    expect(message).not.toContain(badLine.slice(0, 201));
    expect(message).not.toContain('TAILMARK');
  });

  it('a non-Error throw is reported without throwing', () => {
    const report = vi.fn();
    expect(() => dispatchLines(dispatcherWith(Object.create(null)), ['bad'], vi.fn(), report)).not.toThrow();
    expect(report).toHaveBeenCalledTimes(1);
  });

  // Decision: a failing report channel must not cost the batch, so the loop keeps going.
  it('a throwing report does not stop the loop', () => {
    const post = vi.fn();
    const report = vi.fn(() => { throw new Error('report-down'); });
    expect(() => dispatchLines(dispatcherWith(), ['bad1', 'ok:7', 'bad2', 'ok:8'], post, report)).not.toThrow();
    expect(post.mock.calls.map(c => c[0])).toEqual([levelType(7), levelType(8)]);
  });

});

describe('Dispatcher (unchanged)', () => {
  it('dispatch still throws on a throwing processor — replay and goldens must fail loudly', () => {
    const d = dispatcherWith(new Error('loud'));
    expect(() => d.dispatch('bad')).toThrow('loud');
  });
});

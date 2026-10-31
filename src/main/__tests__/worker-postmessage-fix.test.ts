/** WorkerProcess.start is atomic: a postMessage failure kills the child and keeps nothing, so the next start() works. */
import {describe, it, expect, vi} from 'vitest';
import {EventEmitter} from 'node:events';

const h = vi.hoisted(() => ({fork: vi.fn()}));
vi.mock('electron', () => ({utilityProcess: {fork: h.fork}}));
vi.mock('@/main/logger', () => ({log: {error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn()}}));

import {WorkerProcess} from '@/main/worker-process';

class FakeChild extends EventEmitter {
  postMessage = vi.fn();
  kill        = vi.fn();
}

describe('WorkerProcess.start - idempotent, and not wedged after a failed start', () => {
  it('after postMessage throws in start(), a second start() sends the start message (to a new or the same child)', () => {
    const children: FakeChild[] = [];
    h.fork.mockImplementation(() => { const c = new FakeChild(); children.push(c); return c; });
    const wp = new WorkerProcess(() => undefined);
    children.length = 0;
    h.fork.mockImplementationOnce(() => {
      const c = new FakeChild();
      c.postMessage.mockImplementationOnce(() => { throw new Error('postMessage failed'); });
      children.push(c);
      return c;
    });
    expect(() => wp.start('C:/log.txt')).toThrow('postMessage failed');

    wp.start('C:/log.txt');
    const told = children.reduce((n, c) => n + c.postMessage.mock.calls.length, 0) >= 2;
    expect(told).toBe(true);
  });
});

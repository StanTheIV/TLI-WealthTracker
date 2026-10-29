/** 5.1c — WorkerProcess: message validation, exit-code logging, stale-exit guard, error listener. */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {EventEmitter} from 'node:events';

const h = vi.hoisted(() => ({
  fork:  vi.fn(),
  error: vi.fn(),
  warn:  vi.fn(),
  info:  vi.fn(),
  debug: vi.fn(),
}));
vi.mock('electron', () => ({utilityProcess: {fork: h.fork}}));
vi.mock('@/main/logger', () => ({log: {error: h.error, warn: h.warn, info: h.info, debug: h.debug}}));

import {WorkerProcess} from '@/main/worker-process';
import type {RawEvent} from '@/worker/processors/types';

class FakeChild extends EventEmitter {
  postMessage = vi.fn();
  kill        = vi.fn();
}

let children: FakeChild[];

beforeEach(() => {
  vi.clearAllMocks();
  children = [];
  h.fork.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
});

function started() {
  const onEvent = vi.fn<(e: RawEvent) => void>();
  const wp = new WorkerProcess(onEvent);
  wp.start('C:/log.txt');
  return {wp, onEvent, child: children[0]};
}

const texts = (fn: typeof h.warn) => fn.mock.calls.map(c => `${c[0]}|${String(c[1])}`);

describe('message validation', () => {
  it.each<[string, unknown]>([
    ['null',                   null],
    ['a string',               'junk'],
    ['an array',               [1, 2]],
    ['a non-string type',      {type: 7}],
    ['an inherited logType',   {type: 'worker_log', logType: 'constructor', message: 'm'}],
    ['a reader_error w/o message', {type: 'reader_error'}],
  ])('%s is logged as a warning and dropped', (_n, raw) => {
    const {onEvent, child} = started();
    expect(() => child.emit('message', raw)).not.toThrow();

    expect(onEvent).not.toHaveBeenCalled();
    expect(h.warn.mock.calls.some(c => c[0] === 'worker')).toBe(true);
  });

  it('a valid raw event reaches onEvent', () => {
    const {onEvent, child} = started();
    const zone: RawEvent = {type: 'zone_transition', fromScene: 'a', toScene: 'b'};
    child.emit('message', zone);
    expect(onEvent).toHaveBeenCalledWith(zone);
  });

  it('worker_log / reader_ready / reader_error stay absorbed (not forwarded)', () => {
    const {onEvent, child} = started();
    child.emit('message', {type: 'worker_log', logType: 'info', message: 'hi'});
    child.emit('message', {type: 'reader_ready'});
    child.emit('message', {type: 'reader_error', message: 'bad'});
    expect(onEvent).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith('worker', 'hi');
    expect(texts(h.error).some(t => t.includes('bad'))).toBe(true);
  });
});

describe('exit', () => {
  it('after stop() the code is logged at info, not warn', () => {
    const {wp, child} = started();
    wp.stop();
    h.info.mockClear();
    child.emit('exit', 3);
    expect(texts(h.info).some(t => t.startsWith('worker|') && t.includes('3'))).toBe(true);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('an unexpected exit logs the code at warn', () => {
    const {child} = started();
    child.emit('exit', 139);
    expect(texts(h.warn).some(t => t.startsWith('worker|') && t.includes('139'))).toBe(true);
  });

  it('an unexpected exit clears the process so start() forks again', () => {
    const {wp, child} = started();
    child.emit('exit', 1);
    wp.start('C:/log.txt');
    expect(children).toHaveLength(2);
  });

  it('a stale exit from an old child after stop()+start() does not null the new child', () => {
    const {wp, child: old} = started();
    wp.stop();
    wp.start('C:/log.txt');
    const fresh = children[1];

    old.emit('exit', 0);

    wp.start('C:/log.txt');
    expect(children).toHaveLength(2);
    wp.stop();
    expect(fresh.kill).toHaveBeenCalledTimes(1);
  });
});

describe('error listener', () => {
  it("logs the fatal error's type and location", () => {
    const {child} = started();
    expect(() => child.emit('error', 'FatalError', 'v8-location-here', 'report-body')).not.toThrow();
    expect(texts(h.error).some(t => t.startsWith('worker|') && t.includes('FatalError') && t.includes('v8-location-here'))).toBe(true);
  });

  it('truncates a huge report', () => {
    const {child} = started();
    child.emit('error', 'FatalError', 'loc', 'R'.repeat(100_000));
    const logged = texts(h.error).find(t => t.includes('FatalError')) ?? '';
    expect(logged.length).toBeLessThan(20_000);
  });
});

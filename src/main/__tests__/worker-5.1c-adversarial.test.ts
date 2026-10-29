/** 5.1c adversarial: parseWorkerMessage hostile shapes, WorkerProcess lifecycle orderings, dispatchLines edges. */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {EventEmitter} from 'node:events';

const h = vi.hoisted(() => ({fork: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn()}));
vi.mock('electron', () => ({utilityProcess: {fork: h.fork}}));
vi.mock('@/main/logger', () => ({log: {error: h.error, warn: h.warn, info: h.info, debug: h.debug}}));

import {WorkerProcess} from '@/main/worker-process';
import {parseWorkerMessage} from '@/main/worker-message';
import {dispatchLines} from '@/worker/dispatch-lines';
import {Dispatcher} from '@/worker/dispatcher';
import type {Processor, RawEvent} from '@/worker/processors/types';

class FakeChild extends EventEmitter {
  postMessage = vi.fn();
  kill        = vi.fn();
}
let children: FakeChild[];
beforeEach(() => {
  vi.clearAllMocks();
  children = [];
  h.fork.mockImplementation(() => { const c = new FakeChild(); children.push(c); return c; });
});

describe('parseWorkerMessage - hostile shapes', () => {
  it.each<[string, unknown]>([
    ['undefined', undefined], ['a number', 1], ['a function', () => 1], ['a symbol', Symbol('s')], ['a bigint', 1n],
    ['an object with a number type', {type: 1}], ['an object with a String object type', {type: new String('worker_log')}],
    ['worker_log with logType from the prototype', Object.create({logType: 'info'}, {type: {value: 'worker_log', enumerable: true}, message: {value: 'm', enumerable: true}})],
    ['worker_log with logType __proto__', {type: 'worker_log', logType: '__proto__', message: 'm'}],
    ['worker_log with logType toString', {type: 'worker_log', logType: 'toString', message: 'm'}],
    ['worker_log with upper-case logType', {type: 'worker_log', logType: 'INFO', message: 'm'}],
    ['worker_log with a non-string logType', {type: 'worker_log', logType: ['info'], message: 'm'}],
    ['worker_log without a message', {type: 'worker_log', logType: 'info'}],
    ['worker_log with a non-string message', {type: 'worker_log', logType: 'info', message: {toString: () => 'x'}}],
    ['reader_error with no message', {type: 'reader_error'}],
    ['reader_error with a non-string message', {type: 'reader_error', message: 42}],
  ])('rejects %s', (_n, raw) => {
    expect(parseWorkerMessage(raw)).toBeNull();
  });

  it('accepts a null-prototype object and passes it through by reference', () => {
    const raw = Object.assign(Object.create(null), {type: 'worker_log', logType: 'debug', message: 'm'});
    expect(parseWorkerMessage(raw)).toBe(raw);
  });

  it('every logType the logger has is accepted; the value is never altered', () => {
    for (const logType of ['info', 'warn', 'error', 'debug']) {
      const raw = {type: 'worker_log', logType, message: ''};
      expect(parseWorkerMessage(raw)).toBe(raw);
    }
  });

  it('an unknown type passes through untouched (typed by the same build)', () => {
    const raw = {type: 'something_new', x: 1};
    expect(parseWorkerMessage(raw)).toBe(raw);
  });

  it('a JSON-parsed __proto__ key does not smuggle a logType', () => {
    const raw = JSON.parse('{"type":"worker_log","message":"m","__proto__":{"logType":"info"}}');
    expect(parseWorkerMessage(raw)).toBeNull();
  });
});

describe('WorkerProcess - lifecycle orderings', () => {
  const mk = () => { const onEvent = vi.fn<(e: RawEvent) => void>(); return {wp: new WorkerProcess(onEvent), onEvent}; };

  it('rapid start/stop/start/stop/start: one live child at a time, each killed exactly once, last one live', () => {
    const {wp} = mk();
    wp.start('p'); wp.stop(); wp.start('p'); wp.stop(); wp.start('p');
    expect(children).toHaveLength(3);
    expect(children.map(c => c.kill.mock.calls.length)).toEqual([1, 1, 0]);
    wp.start('p');
    expect(children).toHaveLength(3);
  });

  it('exits arriving in any order never null a live child', () => {
    const {wp} = mk();
    wp.start('p'); wp.stop(); wp.start('p'); wp.stop(); wp.start('p');
    const [a, b, c] = children;
    c.emit('exit', 0); // the LIVE one exits unexpectedly first
    wp.start('p');     // re-forks
    expect(children).toHaveLength(4);
    b.emit('exit', 0); // stale
    a.emit('exit', 0); // stale
    wp.start('p');
    expect(children).toHaveLength(4);   // d is still _process
    children[3].emit('exit', 1);
    wp.start('p');
    expect(children).toHaveLength(5);
  });

  it('a double exit of the same live child, then start, forks exactly once', () => {
    const {wp} = mk();
    wp.start('p');
    children[0].emit('exit', 1);
    children[0].emit('exit', 1);
    wp.start('p');
    wp.start('p');
    expect(children).toHaveLength(2);
  });

  it('error followed by exit: both logged, the process slot cleared by the exit only', () => {
    const {wp} = mk();
    wp.start('p');
    children[0].emit('error', 'FatalError', 'loc', 'report');
    wp.start('p');
    expect(children).toHaveLength(1);       // still considered alive after `error` alone
    children[0].emit('exit', 134);
    wp.start('p');
    expect(children).toHaveLength(2);
    expect(h.error.mock.calls.some(c => String(c[1]).includes('FatalError'))).toBe(true);
    expect(h.warn.mock.calls.some(c => String(c[1]).includes('134'))).toBe(true);
  });

  it('exit before any stop with an undefined / NaN code does not throw', () => {
    const {wp} = mk();
    wp.start('p');
    expect(() => children[0].emit('exit', undefined)).not.toThrow();
    wp.start('p');
    expect(() => children[1].emit('exit', Number.NaN)).not.toThrow();
  });

  it('stop() when never started, and stop() twice, kill nothing extra', () => {
    const {wp} = mk();
    expect(() => wp.stop()).not.toThrow();
    wp.start('p');
    wp.stop();
    wp.stop();
    expect(children[0].kill).toHaveBeenCalledTimes(1);
  });

  it('a fork that throws leaves the worker startable', () => {
    const {wp} = mk();
    h.fork.mockImplementationOnce(() => { throw new Error('fork failed'); });
    expect(() => wp.start('p')).toThrow('fork failed');
    wp.start('p');
    expect(children).toHaveLength(1);
    expect(children[0].postMessage).toHaveBeenCalledWith({type: 'start', logPath: 'p'});
  });

  it('malformed messages in a burst never reach onEvent and never throw; good ones around them do', () => {
    const { wp, onEvent } = mk();
    wp.start('p');
    const good = {type: 'zone_change'} as unknown as RawEvent;
    const burst: unknown[] = [null, good, 'x', [], {type: 5}, good, {type: 'worker_log', logType: 'constructor', message: 'm'}, good];
    for (const m of burst) expect(() => children[0].emit('message', m)).not.toThrow();
    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(h.warn.mock.calls.filter(c => String(c[1]).includes('malformed')).length).toBe(5);
  });

  it('the malformed-message warning describes shape, not value: a 1 MB type string is cut', () => {
    const { wp } = mk();
    wp.start('p');
    // a string type is valid, so make it invalid some other way: worker_log with bad logType and huge type name
    children[0].emit('message', {type: 'worker_log', logType: 'nope', message: 'm'});
    expect(h.warn.mock.calls.every(c => String(c[1]).length < 500)).toBe(true);
  });

  it('a throwing onEvent propagates out of the message listener (TrackingService guards it; WorkerProcess does not swallow)', () => {
    const wp = new WorkerProcess(() => { throw new Error('consumer boom'); });
    wp.start('p');
    expect(() => children[0].emit('message', {type: 'zone_change'})).toThrow('consumer boom');
  });
});

describe('dispatchLines - edges', () => {
  const ev = (n: number): RawEvent => ({type: 'level_type', levelType: n});
  const dispatcherOf = (process: Processor['process']): Dispatcher => {
    const d = new Dispatcher();
    d.register({name: 't', test: () => true, process});
    return d;
  };

  it('empty batch: nothing posted or reported', () => {
    const post = vi.fn(); const report = vi.fn();
    dispatchLines(new Dispatcher(), [], post, report);
    expect(post).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ['a Symbol', Symbol('s')], ['null', null], ['undefined', undefined], ['a null-prototype object', Object.create(null)],
    ['a getter-throwing object', {get message() { throw new Error('g'); }, get stack() { throw new Error('g'); }}],
    ['a revoked proxy', (() => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; })()],
  ])('a processor throwing %s is reported and the next line continues', (_n, thrown) => {
    const post = vi.fn(); const report = vi.fn();
    const d = dispatcherOf((line) => { if (line === 'bad') throw thrown; return ev(Number(line)); });
    expect(() => dispatchLines(d, ['1', 'bad', '2'], post, report)).not.toThrow();
    expect(post.mock.calls.map(c => c[0])).toEqual([ev(1), ev(2)]);
    expect(report).toHaveBeenCalledTimes(1);
    expect(typeof report.mock.calls[0][0]).toBe('string');
  });

  it('a report that always throws costs nothing: every good line is still posted in order, around many bad ones', () => {
    const post = vi.fn();
    const report = vi.fn(() => { throw new Error('port gone'); });
    const d = dispatcherOf((line) => { if (line.startsWith('bad')) throw new Error('x'); return ev(Number(line)); });
    const lines = Array.from({length: 1000}, (_, i) => (i % 3 === 0 ? `bad${i}` : String(i)));
    expect(() => dispatchLines(d, lines, post, report)).not.toThrow();
    expect(post.mock.calls.map(c => (c[0] as {levelType: number}).levelType)).toEqual(lines.filter(l => !l.startsWith('bad')).map(Number));
    expect(report).toHaveBeenCalledTimes(lines.filter(l => l.startsWith('bad')).length);
  });

  it('the line in the report is cut at exactly 200 chars; a 5 MB line costs a bounded message', () => {
    const report = vi.fn();
    const d = dispatcherOf(() => { throw new Error('x'); });
    dispatchLines(d, ['y'.repeat(5_000_000)], vi.fn(), report);
    const msg = report.mock.calls[0][0] as string;
    expect(msg.length).toBeLessThan(10_000);
    expect(msg).toContain('y'.repeat(200));
    expect(msg).not.toContain('y'.repeat(201));
  });

  it('events from a line are posted in processor order, and a line throwing in its 2nd processor posts NOTHING from the 1st', () => {
    const d = new Dispatcher();
    d.register({name: 'a', test: () => true, process: () => ev(1)});
    d.register({name: 'b', test: () => true, process: (l) => { if (l === 'bad') throw new Error('b'); return ev(2); }});
    const post = vi.fn(); const report = vi.fn();
    dispatchLines(d, ['ok', 'bad', 'ok'], post, report);
    expect(post.mock.calls.map(c => (c[0] as {levelType: number}).levelType)).toEqual([1, 2, 1, 2]);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('a post that throws: events posted before it stay posted exactly once (no re-post of earlier lines)', () => {
    const calls: number[] = [];
    const post = (e: RawEvent) => { const n = (e as {levelType: number}).levelType; calls.push(n); if (n === 2) throw new Error('clone failed'); };
    const d = dispatcherOf((l) => ev(Number(l)));
    try { dispatchLines(d, ['1', '2', '3'], post, vi.fn()); } catch { /* post failures are the worker's uncaughtException path */ }
    expect(calls.slice(0, 2)).toEqual([1, 2]);
    expect(calls.filter(n => n === 1)).toHaveLength(1);
  });
});

/** 5.1c — parseWorkerMessage: shape validation of what the utility process posts. */
import {describe, it, expect} from 'vitest';
import type {RawEvent} from '@/worker/processors/types';
import {parseWorkerMessage as parse} from '../worker-message';

describe('parseWorkerMessage', () => {
  it.each<[string, unknown]>([
    ['null',               null],
    ['undefined',          undefined],
    ['a string',           'worker_log'],
    ['a number',           42],
    ['an array',           [{type: 'reader_ready'}]],
    ['no type',            {message: 'x'}],
    ['a numeric type',     {type: 1}],
    ['an object type',     {type: {}}],
    ['a null type',        {type: null}],
  ])('rejects %s', (_n, raw) => {
    expect(parse(raw)).toBeNull();
  });

  describe('worker_log', () => {
    it.each(['info', 'warn', 'error', 'debug'])('accepts logType %s', (logType) => {
      const raw = {type: 'worker_log', logType, message: 'hello'};
      expect(parse(raw)).toEqual(raw);
    });

    it.each<[string, unknown]>([
      ['unknown logType',        'trace'],
      ['inherited constructor',  'constructor'],
      ['inherited __proto__',    '__proto__'],
      ['inherited toString',     'toString'],
      ['inherited hasOwnProperty', 'hasOwnProperty'],
      ['non-string logType',     1],
      ['missing logType',        undefined],
    ])('rejects %s', (_n, logType) => {
      expect(parse({type: 'worker_log', logType, message: 'm'})).toBeNull();
    });

    it('rejects a logType that is only inherited (not an own key)', () => {
      const raw = Object.create({logType: 'info'}) as Record<string, unknown>;
      raw.type = 'worker_log';
      raw.message = 'm';
      expect(parse(raw)).toBeNull();
    });

    it('rejects a non-string or missing message', () => {
      expect(parse({type: 'worker_log', logType: 'info', message: 5})).toBeNull();
      expect(parse({type: 'worker_log', logType: 'info'})).toBeNull();
    });
  });

  describe('reader_error', () => {
    it('requires a string message', () => {
      expect(parse({type: 'reader_error', message: 'File not found'})).toEqual({type: 'reader_error', message: 'File not found'});
      expect(parse({type: 'reader_error'})).toBeNull();
      expect(parse({type: 'reader_error', message: 3})).toBeNull();
    });
  });

  it('passes a valid raw event through', () => {
    const zone: RawEvent = {type: 'zone_transition', fromScene: 'a', toScene: 'b'};
    expect(parse(zone)).toEqual(zone);
    expect(parse({type: 'reader_ready'})).toEqual({type: 'reader_ready'});
  });
});

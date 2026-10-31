import {describe, it, expect} from 'vitest';
import {
  describeError, describeErrorBrief, MAX_CAUSE_DEPTH, MAX_ERROR_LENGTH, UNPRINTABLE_ERROR,
} from '@/shared/describe-error';

/** An object whose every listed key is a throwing getter. */
function throwingGetters<T extends object>(target: T, keys: (string | symbol)[]): T {
  for (const key of keys) {
    Object.defineProperty(target, key, {get: () => { throw new Error(`getter ${String(key)}`); }, configurable: true});
  }
  return target;
}

/** An Error with a fixed stack and an optional `cause` (ES2022 — the project lib is ES2020). */
function errorWith(message: string, cause?: unknown): Error {
  const err = new Error(message);
  err.stack = `Error: ${message}`;
  if (cause !== undefined) setCause(err, cause);
  return err;
}
function setCause(err: Error, cause: unknown): void {
  (err as {cause?: unknown}).cause = cause;
}

describe('describeError — Errors', () => {
  it('an Error yields its stack (head line + frames)', () => {
    const err = new Error('boom');
    const text = describeError(err);
    expect(text).toBe(err.stack);
    expect(text.startsWith('Error: boom\n')).toBe(true);
    expect(text).toMatch(/\n\s+at /);
  });

  it('an Error without a stack falls back to `name: message`', () => {
    const err = new TypeError('bad type');
    err.stack = undefined;
    expect(describeError(err)).toBe('TypeError: bad type');
  });

  it('an empty stack, an empty message and an empty name each fall back', () => {
    const err = new Error('');
    err.stack = '';
    expect(describeError(err)).toBe('Error');
    const unnamed = new Error('m');
    unnamed.stack = '';
    unnamed.name = '';
    expect(describeError(unnamed)).toBe('Error: m');
  });

  it('a subclass keeps its own name', () => {
    class ReaderError extends Error {
      constructor(message: string) { super(message); this.name = 'ReaderError'; }
    }
    const err = new ReaderError('cannot read');
    expect(describeError(err).startsWith('ReaderError: cannot read\n')).toBe(true);
    err.stack = undefined;
    expect(describeError(err)).toBe('ReaderError: cannot read');
  });

  it('a throwing `stack` getter falls back to name and message', () => {
    const err = throwingGetters(new Error('still here'), ['stack']);
    expect(describeError(err)).toBe('Error: still here');
  });

  it('throwing `stack`, `message` and `name` getters still yield a line', () => {
    const err = throwingGetters(new Error('x'), ['stack', 'message', 'name']);
    expect(describeError(err)).toBe('Error');
  });

  it('a non-string stack / message is ignored, not coerced', () => {
    const err = new Error('m');
    Object.defineProperty(err, 'stack', {value: {toString: () => { throw new Error('no'); }}});
    Object.defineProperty(err, 'message', {value: Symbol('s')});
    expect(describeError(err)).toBe('Error');
  });

  it('a cause chain is appended', () => {
    const err = errorWith('outer', errorWith('root'));
    expect(describeError(err)).toBe('Error: outer\nCaused by: Error: root');
  });

  it('a non-Error cause is described like any thrown value', () => {
    const err = errorWith('outer', Symbol('why'));
    expect(describeError(err)).toBe('Error: outer\nCaused by: Symbol(why)');
  });

  it('a cause cycle terminates', () => {
    const a = errorWith('a');
    const b = errorWith('b', a);
    setCause(a, b);
    expect(describeError(a)).toBe('Error: a\nCaused by: Error: b\nCaused by: [circular cause]');
    const self = errorWith('self');
    setCause(self, self);
    expect(describeError(self)).toBe('Error: self\nCaused by: [circular cause]');
  });

  it(`a cause chain deeper than ${MAX_CAUSE_DEPTH} is truncated`, () => {
    let err: Error | undefined;
    for (let i = 20; i >= 0; i--) {
      err = errorWith(`e${i}`, err);
    }
    const lines = describeError(err).split('\n');
    expect(lines).toHaveLength(MAX_CAUSE_DEPTH + 1);
    expect(lines[0]).toBe('Error: e0');
    expect(lines[MAX_CAUSE_DEPTH - 1]).toBe(`Caused by: Error: e${MAX_CAUSE_DEPTH - 1}`);
    expect(lines[MAX_CAUSE_DEPTH]).toBe('Caused by: [cause chain truncated]');
  });

  it('a throwing `cause` getter is skipped', () => {
    const err = throwingGetters(new Error('m'), ['cause']);
    err.stack = 'Error: m';
    expect(describeError(err)).toBe('Error: m');
  });
});

describe('describeError — non-Error values', () => {
  it.each<[string, unknown, string]>([
    ['string',    'plain string', 'plain string'],
    ['empty string', '', ''],
    ['number',    42, '42'],
    ['NaN',       Number.NaN, 'NaN'],
    ['boolean',   false, 'false'],
    ['BigInt',    10n ** 20n, '100000000000000000000n'],
    ['null',      null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['Symbol',    Symbol('s'), 'Symbol(s)'],
    ['Symbol without description', Symbol(), 'Symbol()'],
    ['plain object', {code: 'E1', n: 2}, '{"code":"E1","n":2}'],
    ['empty object', {}, '[object Object]'],
    ['array',     [1, 'two'], '[1,"two"]'],
    ['function',  function named() {}, '[object Function]'],
  ])('%s', (_name, value, expected) => {
    expect(describeError(value)).toBe(expected);
  });

  it('a null-prototype object', () => {
    expect(describeError(Object.create(null))).toBe('[object Object]');
    const withData = Object.assign(Object.create(null), {code: 7});
    expect(describeError(withData)).toBe('{"code":7}');
  });

  it('an object with a custom toString is not invoked', () => {
    let called = false;
    const value = {toString: () => { called = true; return 'custom'; }};
    expect(describeError(value)).toBe('[object Object]');
    expect(called).toBe(false);
  });

  it('throwing toString / valueOf / Symbol.toPrimitive / toJSON never reach the caller', () => {
    const value = throwingGetters({}, ['toString', 'valueOf', Symbol.toPrimitive, 'toJSON']);
    expect(describeError(value)).toBe('[object Object]');
    const methods = {
      toString: () => { throw new Error('ts'); },
      [Symbol.toPrimitive]: () => { throw new Error('tp'); },
      toJSON: () => { throw new Error('tj'); },
    };
    expect(describeError(methods)).toBe('[object Object]');
  });

  it('a throwing Symbol.toStringTag getter on an empty object → unprintable', () => {
    expect(describeError(throwingGetters({}, [Symbol.toStringTag]))).toBe(UNPRINTABLE_ERROR);
  });

  it('a cyclic plain object falls back to its tag', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(describeError(value)).toBe('[object Object]');
  });

  it('an object holding a BigInt (JSON throws) falls back to its tag', () => {
    expect(describeError({n: 1n})).toBe('[object Object]');
  });

  it('a revoked Proxy → unprintable', () => {
    const {proxy, revoke} = Proxy.revocable({}, {});
    revoke();
    expect(describeError(proxy)).toBe(UNPRINTABLE_ERROR);
  });

  it('a Proxy whose every trap throws → unprintable', () => {
    const boom = () => { throw new Error('trap'); };
    const proxy = new Proxy({}, {get: boom, getPrototypeOf: boom, ownKeys: boom, getOwnPropertyDescriptor: boom, has: boom});
    expect(describeError(proxy)).toBe(UNPRINTABLE_ERROR);
  });

  it('a revoked Proxy as a cause leaves the outer error readable', () => {
    const {proxy, revoke} = Proxy.revocable({}, {});
    revoke();
    const err = errorWith('outer', proxy);
    expect(describeError(err)).toBe(`Error: outer\nCaused by: ${UNPRINTABLE_ERROR}`);
  });
});

describe('describeError — length cap', () => {
  it(`a string up to ${MAX_ERROR_LENGTH} chars is kept whole`, () => {
    const s = 'x'.repeat(MAX_ERROR_LENGTH);
    expect(describeError(s)).toBe(s);
  });

  it('a huge string is cut with a marker naming the dropped length', () => {
    const s = 'y'.repeat(5_000_000);
    const text = describeError(s);
    expect(text.startsWith('y'.repeat(MAX_ERROR_LENGTH))).toBe(true);
    expect(text.slice(MAX_ERROR_LENGTH)).toBe(`… [truncated ${5_000_000 - MAX_ERROR_LENGTH} chars]`);
  });

  it('a huge stack and a huge JSON value are capped too', () => {
    const err = new Error('m');
    err.stack = 'z'.repeat(MAX_ERROR_LENGTH * 3);
    expect(describeError(err).length).toBeLessThan(MAX_ERROR_LENGTH + 64);
    expect(describeError({blob: 'q'.repeat(MAX_ERROR_LENGTH * 3)}).length).toBeLessThan(MAX_ERROR_LENGTH + 64);
  });

  it('the cut never splits a surrogate pair', () => {
    const s = 'a'.repeat(MAX_ERROR_LENGTH - 1) + '😀'.repeat(10);
    const text = describeError(s);
    expect(text.startsWith(`${'a'.repeat(MAX_ERROR_LENGTH - 1)}…`)).toBe(true);
  });
});

describe('describeErrorBrief', () => {
  it('an Error → its head line only', () => {
    const err = new Error('Download failed: 404');
    setCause(err, new Error('net'));
    expect(describeErrorBrief(err)).toBe('Error: Download failed: 404');
  });

  it('a single-line value is returned whole', () => {
    expect(describeErrorBrief('offline')).toBe('offline');
    expect(describeErrorBrief(Object.create(null))).toBe('[object Object]');
  });

  it('a revoked Proxy → unprintable', () => {
    const {proxy, revoke} = Proxy.revocable({}, {});
    revoke();
    expect(describeErrorBrief(proxy)).toBe(UNPRINTABLE_ERROR);
  });
});

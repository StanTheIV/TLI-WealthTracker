/** 5.1d: installProcessErrorHandlers — every error logged, the first of the run boxed, never throws. */
import {describe, it, expect, vi} from 'vitest';
import {ERROR_BOX_TITLE, errorBoxContent, installProcessErrorHandlers} from '@/main/process-errors';
import {describeError, describeErrorBrief} from '@/shared/describe-error';

type Listener = (err: unknown) => void;

function setup(over: {showErrorBox?: (t: string, c: string) => void; logPath?: () => string; error?: (f: string, m: string) => void} = {}) {
  const listeners = new Map<string, Listener>();
  const error = vi.fn(over.error ?? (() => undefined));
  const showErrorBox = vi.fn(over.showErrorBox ?? (() => undefined));
  installProcessErrorHandlers({
    on: (event, listener) => { listeners.set(event, listener); },
    log: {error},
    showErrorBox,
    logPath: over.logPath ?? (() => 'C:/logs/tli.log'),
  });
  const fire = (event: string, err: unknown) => listeners.get(event)!(err);
  return {listeners, error, showErrorBox, fire};
}

describe('installProcessErrorHandlers', () => {
  it('registers uncaughtException and unhandledRejection', () => {
    const {listeners} = setup();
    expect([...listeners.keys()].sort()).toEqual(['uncaughtException', 'unhandledRejection']);
  });

  it('the first error logs the full describeError and shows one box with the brief + log path', () => {
    const {error, showErrorBox, fire} = setup();
    const boom = new Error('boom');
    fire('uncaughtException', boom);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe('app');
    expect(error.mock.calls[0][1]).toContain(describeError(boom));
    expect(showErrorBox).toHaveBeenCalledTimes(1);
    const [title, content] = showErrorBox.mock.calls[0];
    expect(title).toBe(ERROR_BOX_TITLE);
    expect(content).toContain(describeErrorBrief(boom));
    expect(content).toContain('C:/logs/tli.log');
    expect(content).not.toContain('\n    at '); // no stack frames in the box
  });

  it('later errors (either kind) are only logged', () => {
    const {error, showErrorBox, fire} = setup();
    fire('unhandledRejection', new Error('first'));
    fire('uncaughtException', new Error('second'));
    fire('unhandledRejection', 'third');
    expect(error).toHaveBeenCalledTimes(3);
    expect(showErrorBox).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][1]).toMatch(/rejection/i);
    expect(error.mock.calls[1][1]).toMatch(/uncaught exception/i);
  });

  it('an unhandled rejection alone also shows the box', () => {
    const {showErrorBox, fire} = setup();
    fire('unhandledRejection', new Error('rejected'));
    expect(showErrorBox).toHaveBeenCalledTimes(1);
    expect(showErrorBox.mock.calls[0][1]).toContain('rejected');
  });

  it('a throwing showErrorBox never escapes, and the box is still not retried', () => {
    const {error, showErrorBox, fire} = setup({showErrorBox: () => { throw new Error('no GUI'); }});
    expect(() => fire('uncaughtException', new Error('a'))).not.toThrow();
    expect(() => fire('uncaughtException', new Error('b'))).not.toThrow();
    expect(showErrorBox).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(2);
  });

  it('a throwing logger or logPath never escapes; the box is still shown', () => {
    const {showErrorBox, fire} = setup({error: () => { throw new Error('log down'); }});
    expect(() => fire('uncaughtException', new Error('a'))).not.toThrow();
    expect(showErrorBox).toHaveBeenCalledTimes(1);

    const second = setup({logPath: () => { throw new Error('no path'); }});
    expect(() => second.fire('uncaughtException', new Error('a'))).not.toThrow();
  });

  it.each<[string, unknown]>([
    ['string', 'oops'], ['null', null], ['undefined', undefined], ['symbol', Symbol('s')],
    ['null-prototype object', Object.create(null)], ['number', 42],
  ])('a non-Error %s is logged and boxed without throwing', (_n, thrown) => {
    const {error, showErrorBox, fire} = setup();
    expect(() => fire('unhandledRejection', thrown)).not.toThrow();
    expect(error.mock.calls[0][1]).toContain(describeError(thrown));
    expect(showErrorBox.mock.calls[0][1]).toContain(describeErrorBrief(thrown));
  });

  it('before the logger is up (empty log path) the box names no log file', () => {
    const {showErrorBox, fire} = setup({logPath: () => ''});
    fire('uncaughtException', new Error('early'));
    expect(showErrorBox.mock.calls[0][1]).toBe(errorBoxContent('Uncaught exception: Error: early', ''));
    expect(showErrorBox.mock.calls[0][1]).not.toMatch(/log file/);
  });
});

describe('errorBoxContent', () => {
  it('appends the log path only when there is one', () => {
    expect(errorBoxContent('msg', '')).toBe('msg');
    expect(errorBoxContent('msg', 'C:/x.log')).toMatch(/^msg\n\n.*\nC:\/x\.log$/);
  });
});

describe('module boundary', () => {
  it('imports no electron', async () => {
    const {readFileSync} = await import('fs');
    const {join} = await import('path');
    expect(readFileSync(join(__dirname, '../process-errors.ts'), 'utf8')).not.toMatch(/from ['"]electron['"]/);
    expect(readFileSync(join(__dirname, '../crash-budget.ts'), 'utf8')).not.toMatch(/from ['"]electron['"]/);
  });
});

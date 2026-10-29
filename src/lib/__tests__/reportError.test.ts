/** 5.1e: renderer errors reach the main log through logging.report — formatted, never throwing. */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {installWindowErrorReporting, reportError} from '@/lib/reportError';
import {describeError} from '@/shared/describe-error';

let report: ReturnType<typeof vi.fn>;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.unstubAllGlobals();
  report = vi.fn();
  vi.stubGlobal('window', {electronAPI: {logging: {report}}});
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  consoleError.mockRestore();
  vi.unstubAllGlobals();
});

describe('reportError', () => {
  it('sends the tag and the describeError text over logging.report, and keeps console.error', () => {
    const err = new Error('boom');
    reportError('render', err);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('render', describeError(err));
    expect(report.mock.calls[0][1]).toContain('Error: boom');
    expect(consoleError).toHaveBeenCalledWith('render', err);
  });

  it('formats values a template literal would throw on (null-prototype object, Symbol)', () => {
    reportError('a', Object.create(null));
    reportError('b', Symbol('s'));
    expect(report).toHaveBeenNthCalledWith(1, 'a', describeError(Object.create(null)));
    expect(report).toHaveBeenNthCalledWith(2, 'b', 'Symbol(s)');
  });

  it('never throws: a throwing IPC bridge, a missing bridge, no window, a throwing console', () => {
    report.mockImplementation(() => { throw new Error('ipc down'); });
    expect(() => reportError('x', new Error('e'))).not.toThrow();

    vi.stubGlobal('window', {});
    expect(() => reportError('x', new Error('e'))).not.toThrow();

    vi.unstubAllGlobals();
    expect(() => reportError('x', new Error('e'))).not.toThrow();

    vi.stubGlobal('window', {electronAPI: {logging: {report}}});
    report.mockReset();
    consoleError.mockImplementation(() => { throw new Error('console gone'); });
    expect(() => reportError('x', 'still sent')).not.toThrow();
    expect(report).toHaveBeenCalledWith('x', 'still sent');
  });
});

describe('installWindowErrorReporting', () => {
  function fakeTarget() {
    const listeners = new Map<string, Array<(e: unknown) => void>>();
    return {
      addEventListener: vi.fn((type: string, fn: (e: unknown) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      }),
      fire(type: string, e: unknown) { (listeners.get(type) ?? []).forEach(fn => fn(e)); },
    };
  }

  it('reports window error and unhandledrejection events', () => {
    const target = fakeTarget();
    installWindowErrorReporting(target as unknown as Window);
    const err = new Error('click handler threw');
    target.fire('error', {error: err, message: 'Uncaught Error: click handler threw'});
    target.fire('unhandledrejection', {reason: 'rejected with a string'});
    expect(report).toHaveBeenNthCalledWith(1, 'window error', describeError(err));
    expect(report).toHaveBeenNthCalledWith(2, 'unhandled rejection', 'rejected with a string');
  });

  it('falls back to the event message when error is null (cross-origin script)', () => {
    const target = fakeTarget();
    installWindowErrorReporting(target as unknown as Window);
    target.fire('error', {error: null, message: 'Script error.'});
    expect(report).toHaveBeenCalledWith('window error', 'Script error.');
  });

  it('installs once per target', () => {
    const target = fakeTarget();
    installWindowErrorReporting(target as unknown as Window);
    installWindowErrorReporting(target as unknown as Window);
    expect(target.addEventListener).toHaveBeenCalledTimes(2); // error + unhandledrejection, once
    target.fire('error', {error: new Error('once')});
    expect(report).toHaveBeenCalledTimes(1);
  });
});

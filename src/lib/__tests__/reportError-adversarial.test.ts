/** Adversarial 5.1e: window error reporting with odd events and every rejection type. */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {installWindowErrorReporting} from '@/lib/reportError';

let report: ReturnType<typeof vi.fn>;
beforeEach(() => {
  report = vi.fn();
  vi.stubGlobal('window', {electronAPI: {logging: {report}}});
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function target() {
  const ls = new Map<string, (e: unknown) => void>();
  return {addEventListener: (t: string, f: (e: unknown) => void) => { ls.set(t, f); }, fire: (t: string, e: unknown) => ls.get(t)!(e)};
}

describe('installWindowErrorReporting adversarial', () => {
  it('ErrorEvent with error null/undefined and no message never throws', () => {
    const t = target(); installWindowErrorReporting(t as unknown as Window);
    for (const e of [{error: null}, {error: undefined}, {}, {error: null, message: undefined}]) {
      expect(() => t.fire('error', e)).not.toThrow();
    }
    expect(report).toHaveBeenCalledTimes(4);
    for (const c of report.mock.calls) expect(typeof c[1]).toBe('string');
  });

  it('every rejection reason type becomes a string and never throws', () => {
    const t = target(); installWindowErrorReporting(t as unknown as Window);
    const reasons: unknown[] = [undefined, null, 0, 1n, 'r', Symbol('s'), {}, Object.create(null), [], () => 1,
      new Error('e'), {get message() { throw new Error('g'); }}, 'z'.repeat(1e6)];
    for (const r of reasons) expect(() => t.fire('unhandledrejection', {reason: r})).not.toThrow();
    expect(report).toHaveBeenCalledTimes(reasons.length);
    for (const c of report.mock.calls) {
      expect(typeof c[1]).toBe('string');
      expect(c[1].length).toBeLessThan(9_000);
    }
  });

  it('a second, different target is still installed (guard is per target)', () => {
    const a = target(), b = target();
    installWindowErrorReporting(a as unknown as Window);
    installWindowErrorReporting(b as unknown as Window);
    b.fire('error', {error: new Error('b')});
    expect(report).toHaveBeenCalledTimes(1);
  });
});

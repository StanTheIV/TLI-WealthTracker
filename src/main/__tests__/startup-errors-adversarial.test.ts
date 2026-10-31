/** Adversarial 5.1d: process-error handlers, crash budget, renderer-report limiter under hostile input. */
import {describe, it, expect, vi} from 'vitest';
import {installProcessErrorHandlers} from '@/main/process-errors';
import {createCrashBudget} from '@/main/crash-budget';
import {createReportRateLimiter, formatRendererReport} from '@/main/renderer-report';
import {MAX_ERROR_LENGTH} from '@/shared/describe-error';

function handlers(over: {error?: () => void; showErrorBox?: () => void; logPath?: () => string} = {}) {
  const l = new Map<string, (e: unknown) => void>();
  const error = vi.fn(over.error ?? (() => undefined));
  const showErrorBox = vi.fn(over.showErrorBox ?? (() => undefined));
  installProcessErrorHandlers({
    on: (ev, fn) => { l.set(ev, fn); },
    log: {error}, showErrorBox, logPath: over.logPath ?? (() => 'p'),
  });
  return {error, showErrorBox, fire: (ev: string, e: unknown) => l.get(ev)!(e)};
}

describe('process-errors adversarial', () => {
  it('logger and showErrorBox both throwing: no escape, box attempted once', () => {
    const boom = () => { throw new Error('x'); };
    const h = handlers({error: boom, showErrorBox: boom});
    for (let i = 0; i < 5; i++) {
      expect(() => h.fire(i % 2 ? 'uncaughtException' : 'unhandledRejection', new Error('e'))).not.toThrow();
    }
    expect(h.showErrorBox).toHaveBeenCalledTimes(1);
    expect(h.error).toHaveBeenCalledTimes(5);
  });

  it('hostile thrown values: throwing getters, throwing toString, revoked proxy, huge string', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const hostile: unknown[] = [
      {get message() { throw new Error('getter'); }},
      {toString() { throw new Error('ts'); }, toJSON() { throw new Error('tj'); }},
      Object.defineProperty(new Error('e'), 'stack', {get() { throw new Error('stack'); }}),
      revoked.proxy, Symbol.for('s'), 10n, 'x'.repeat(5_000_000), () => 1,
    ];
    for (const v of hostile) {
      const h = handlers();
      expect(() => h.fire('unhandledRejection', v)).not.toThrow();
      expect(h.showErrorBox).toHaveBeenCalledTimes(1);
      expect((h.error.mock.calls[0] as unknown as string[])[1].length).toBeLessThan(MAX_ERROR_LENGTH + 200);
    }
  });

  it('one box across both event kinds, in either order', () => {
    for (const [a, b] of [['uncaughtException', 'unhandledRejection'], ['unhandledRejection', 'uncaughtException']]) {
      const h = handlers();
      h.fire(a, 1); h.fire(b, 2); h.fire(a, 3); h.fire(b, 4);
      expect(h.showErrorBox).toHaveBeenCalledTimes(1);
      expect(h.error).toHaveBeenCalledTimes(4);
    }
  });

  it('logPath is read per error: only the first error shows a box', () => {
    let p = '';
    const h = handlers({logPath: () => p});
    h.fire('uncaughtException', new Error('early'));
    p = '/late.log';
    h.fire('uncaughtException', new Error('later'));
    expect(h.showErrorBox).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.showErrorBox.mock.calls[0])).not.toContain('/late.log');
  });
});

describe('crash-budget adversarial', () => {
  function mk() {
    let t = 5_000;
    return {b: createCrashBudget({max: 3, windowMs: 60_000, now: () => t}), set: (n: number) => { t = n; }};
  }

  it('exact boundary: a reload 59 999 ms old still counts, 60 000 ms old is freed', () => {
    const c = mk();
    c.b.onGone('crashed');
    c.set(5_001); c.b.onGone('crashed');
    c.set(5_002); c.b.onGone('crashed');
    c.set(5_000 + 59_999);
    expect(c.b.onGone('crashed')).toBe('give-up');
    c.set(5_000 + 60_000);
    expect(c.b.onGone('crashed')).toBe('reload');
    expect(c.b.onGone('crashed')).toBe('give-up');
  });

  it('give-up does not record: after the window passes it reloads again', () => {
    const c = mk();
    for (let i = 0; i < 3; i++) c.b.onGone('crashed');
    for (let i = 0; i < 20; i++) expect(c.b.onGone('crashed')).toBe('give-up');
    c.set(5_000 + 60_000);
    expect(c.b.onGone('crashed')).toBe('reload');
  });

  it('clock going backwards never grants extra reloads and never throws', () => {
    const c = mk();
    c.set(1_000_000);
    for (let i = 0; i < 3; i++) c.b.onGone('crashed');
    c.set(10);
    for (let i = 0; i < 5; i++) expect(c.b.onGone('crashed')).toBe('give-up');
    c.set(1_000_000 + 60_000);
    expect(c.b.onGone('crashed')).toBe('reload');
  });

  it('empty, odd-case and unknown reasons count; only the exact two are ignored; ignores use no budget', () => {
    const c = mk();
    expect(c.b.onGone('')).toBe('reload');
    expect(c.b.onGone('Killed')).toBe('reload');
    for (let i = 0; i < 10; i++) { expect(c.b.onGone('clean-exit')).toBe('ignore'); expect(c.b.onGone('killed')).toBe('ignore'); }
    expect(c.b.onGone('whatever')).toBe('reload');
    expect(c.b.onGone('crashed')).toBe('give-up');
  });
});

describe('renderer-report adversarial', () => {
  it('limiter: exact 60 000 boundary and a 100-window flood stay independent', () => {
    let t = 0;
    const l = createReportRateLimiter({max: 2, windowMs: 60_000, now: () => t});
    expect([l.check('a'), l.check('a'), l.check('a'), l.check('a')]).toEqual(['log', 'log', 'suppress', 'drop']);
    t = 59_999; expect(l.check('a')).toBe('drop');
    t = 60_000; expect(l.check('a')).toBe('log');
    for (let i = 0; i < 100; i++) expect(l.check(`w${i}`)).toBe('log');
  });

  it('formats hostile tag/message safely and clipped', () => {
    const hostile = [{}, [], null, undefined, Symbol('s'), 5, Object.create(null), () => 1];
    for (const v of hostile) {
      expect(formatRendererReport('w', v, v)).toBe('w renderer error [[invalid tag]]: [invalid message]');
    }
    const big = formatRendererReport('w', 't'.repeat(1e6), 'm'.repeat(1e6));
    expect(big.length).toBeLessThan(MAX_ERROR_LENGTH + 400);
    expect(big).toContain('[truncated]');
  });
});

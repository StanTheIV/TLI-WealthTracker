/** 5.1e: the main-side rate limit and log line for renderer error reports. */
import {describe, it, expect} from 'vitest';
import {createReportRateLimiter, formatRendererReport, suppressedReportLine} from '@/main/renderer-report';
import {MAX_ERROR_LENGTH} from '@/shared/describe-error';

function limiter(max = 3, windowMs = 60_000) {
  let t = 1_000;
  const l = createReportRateLimiter({max, windowMs, now: () => t});
  return {l, advance: (ms: number) => { t += ms; }};
}

describe('createReportRateLimiter', () => {
  it('logs the first max reports, then one suppress, then drops until the window ends', () => {
    const {l, advance} = limiter(3);
    expect([1, 2, 3, 4, 5, 6].map(() => l.check('main window')))
      .toEqual(['log', 'log', 'log', 'suppress', 'drop', 'drop']);
    advance(59_999);
    expect(l.check('main window')).toBe('drop');
    advance(1);
    expect(l.check('main window')).toBe('log'); // a fresh window
    expect(l.check('main window')).toBe('log');
  });

  it('counts each window separately', () => {
    const {l} = limiter(1);
    expect(l.check('main window')).toBe('log');
    expect(l.check('main window')).toBe('suppress');
    expect(l.check('overlay')).toBe('log');
    expect(l.check('overlay')).toBe('suppress');
  });

  it('the window starts at its first report (fixed, not sliding)', () => {
    const {l, advance} = limiter(2, 1_000);
    expect(l.check('w')).toBe('log');
    advance(900);
    expect(l.check('w')).toBe('log');
    expect(l.check('w')).toBe('suppress');
    advance(100); // 1000 ms after the first
    expect(l.check('w')).toBe('log');
  });
});

describe('formatRendererReport', () => {
  it('names the window and the tag', () => {
    expect(formatRendererReport('overlay', 'render', 'Error: boom\n    at X'))
      .toBe('overlay renderer error [render]: Error: boom\n    at X');
  });

  it('names non-string fields instead of stringifying them', () => {
    const hostile = {toString() { throw new Error('no'); }};
    expect(formatRendererReport('main window', hostile, Object.create(null)))
      .toBe('main window renderer error [[invalid tag]]: [invalid message]');
  });

  it('caps the tag and the message', () => {
    const line = formatRendererReport('w', 't'.repeat(500), 'm'.repeat(MAX_ERROR_LENGTH * 3));
    expect(line.length).toBeLessThan(MAX_ERROR_LENGTH + 200);
    expect(line).toContain('… [truncated]');
  });

  it('the suppressed line says how many and for how long', () => {
    expect(suppressedReportLine('overlay', 10, 60_000)).toContain('overlay: more than 10 renderer errors within 60 s');
  });
});

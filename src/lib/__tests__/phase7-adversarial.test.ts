import {afterAll, describe, expect, it, vi} from 'vitest';
import {readFileSync} from 'fs';
import {join} from 'path';

const restoreIntl = vi.hoisted(() => {
  const {NumberFormat, DateTimeFormat} = Intl;
  class PinnedNumberFormat extends NumberFormat {
    constructor(_l?: string | string[], o?: Intl.NumberFormatOptions) { super('en-US', o); }
  }
  class PinnedDateTimeFormat extends DateTimeFormat {
    constructor(_l?: string | string[], o?: Intl.DateTimeFormatOptions) { super('en-US', {...o, timeZone: 'UTC'}); }
  }
  Intl.NumberFormat   = PinnedNumberFormat as typeof Intl.NumberFormat;
  Intl.DateTimeFormat = PinnedDateTimeFormat as typeof Intl.DateTimeFormat;
  return () => { Intl.NumberFormat = NumberFormat; Intl.DateTimeFormat = DateTimeFormat; };
});

import {formatDateTime, formatElapsed, formatFECompact, formatFEFull} from '../format';
import {createModalStack} from '@/components/ui/modalStack';
import {LootCollectionTimer} from '@/main/engine/loot-collection-timer';
import setupEN from '@/i18n/locales/en/setup.json';
import setupDE from '@/i18n/locales/de/setup.json';

afterAll(restoreIntl);

describe('formatFEFull edges', () => {
  it('non-finite values never throw; NaN never gets a plus', () => {
    expect(formatFEFull(NaN)).toBe('NaN');
    expect(formatFEFull(NaN, {plus: true})).toBe('NaN');
    expect(formatFEFull(Infinity)).toBe('∞');
    expect(formatFEFull(-Infinity)).toBe('-∞');
    expect(formatFEFull(Infinity, {plus: true, unit: true})).toBe('+∞ FE');
  });

  it('-0 is 0 under every option combination', () => {
    expect(formatFEFull(-0)).toBe('0.00');
    expect(formatFEFull(-0, {plus: true})).toBe('+0.00');
    expect(formatFEFull(-0, {unit: true})).toBe('0.00 FE');
    expect(formatFEFull(-0, {zeroAsDash: true})).toBe('—');
    expect(formatFEFull(0, {zeroAsDash: true, plus: true, unit: true})).toBe('—');
  });

  it('zeroAsDash only dashes exact zero; null dash ignores plus/unit', () => {
    expect(formatFEFull(0.004, {zeroAsDash: true})).toBe('0.00');
    expect(formatFEFull(null, {plus: true, unit: true})).toBe('—');
  });

  it('large values group correctly', () => {
    expect(formatFEFull(1e15)).toBe('1,000,000,000,000,000.00');
    expect(formatFEFull(-1234567.891)).toBe('-1,234,567.89');
  });
});

describe('formatFECompact edges', () => {
  it('band edges', () => {
    expect(formatFECompact(999)).toBe('999');
    expect(formatFECompact(999.4)).toBe('999');
    expect(formatFECompact(1000)).toBe('1.0k');
    expect(formatFECompact(-1000)).toBe('-1.0k');
    expect(formatFECompact(1_000_000)).toBe('1.00M');
    expect(formatFECompact(-1_000_000)).toBe('-1.00M');
    expect(formatFECompact(999_949)).toBe('999.9k');
  });

  it('huge and non-finite values do not throw', () => {
    expect(formatFECompact(1e15)).toBe('1000000000.00M');
    expect(() => formatFECompact(NaN)).not.toThrow();
    expect(() => formatFECompact(Infinity)).not.toThrow();
    expect(() => formatFECompact(-Infinity)).not.toThrow();
  });
});

describe('formatElapsed edges', () => {
  it('floors fractions and does not wrap hours', () => {
    expect(formatElapsed(0)).toBe('00:00:00');
    expect(formatElapsed(999.9)).toBe('00:00:00');
    expect(formatElapsed(1000)).toBe('00:00:01');
    expect(formatElapsed(3_599_999)).toBe('00:59:59');
    expect(formatElapsed(100 * 3_600_000)).toBe('100:00:00');
    expect(formatElapsed(1e12)).toBe('277777:46:40');
  });

  it('does not throw on negative / NaN / Infinity', () => {
    expect(() => formatElapsed(-1)).not.toThrow();
    expect(() => formatElapsed(NaN)).not.toThrow();
    expect(() => formatElapsed(Infinity)).not.toThrow();
  });
});

describe('formatDateTime edges', () => {
  it('epoch 0 and negative timestamps format', () => {
    expect(formatDateTime(0)).toBe('Jan 1, 12:00 AM');
    expect(formatDateTime(-86_400_000)).toBe('Dec 31, 12:00 AM');
  });
});

describe('modalStack edges', () => {
  it('empty stack: nothing is top; remove is a no-op', () => {
    const s = createModalStack();
    const a = Symbol('a');
    expect(s.isTop(a)).toBe(false);
    expect(() => s.remove(a)).not.toThrow();
  });

  it('removing an id twice does not disturb others', () => {
    const s = createModalStack();
    const a = Symbol('a'), b = Symbol('b');
    s.push(a); s.push(b);
    s.remove(b); s.remove(b);
    expect(s.isTop(a)).toBe(true);
    expect(s.isTop(b)).toBe(false);
  });

  it('removing a non-top id keeps the top and promotes correctly afterwards', () => {
    const s = createModalStack();
    const a = Symbol('a'), b = Symbol('b'), c = Symbol('c');
    s.push(a); s.push(b); s.push(c);
    s.remove(b);
    expect(s.isTop(c)).toBe(true);
    expect(s.isTop(a)).toBe(false);
    s.remove(c);
    expect(s.isTop(a)).toBe(true);
  });

  it('pushing the same id twice needs two removes', () => {
    const s = createModalStack();
    const a = Symbol('a'), b = Symbol('b');
    s.push(a); s.push(b); s.push(a);
    s.remove(a);
    expect(s.isTop(b)).toBe(true);
    s.remove(b);
    expect(s.isTop(a)).toBe(true);
    s.remove(a);
    expect(s.isTop(a)).toBe(false);
  });
});

describe('LootCollectionTimer frozen window', () => {
  it('refresh/reset while frozen do not re-arm: unfreeze resumes the pre-freeze remainder', () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const t = new LootCollectionTimer(5_000, onExpire);
      t.start();
      vi.advanceTimersByTime(3_000);
      t.freeze();
      vi.advanceTimersByTime(10_000);
      t.refresh(); t.reset(); t.refresh();
      expect(t.unfreeze()).toBe(true);
      vi.advanceTimersByTime(1_999);
      expect(onExpire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onExpire).toHaveBeenCalledTimes(1);
      expect(t.active).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('double freeze keeps the first remainder; stray unfreeze is false; cancel clears frozen', () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const t = new LootCollectionTimer(5_000, onExpire);
      expect(t.unfreeze()).toBe(false);
      t.freeze();
      expect(t.active).toBe(false);
      t.start();
      vi.advanceTimersByTime(1_000);
      t.freeze();
      vi.advanceTimersByTime(2_000);
      t.freeze();
      t.unfreeze();
      vi.advanceTimersByTime(3_999);
      expect(onExpire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onExpire).toHaveBeenCalledTimes(1);

      t.start(); t.freeze(); t.cancel();
      expect(t.frozen).toBe(false);
      expect(t.active).toBe(false);
      expect(t.unfreeze()).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('freezing at the last ms resumes and still fires', () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const t = new LootCollectionTimer(1_000, onExpire);
      t.start();
      vi.advanceTimersByTime(999);
      t.freeze();
      t.unfreeze();
      vi.advanceTimersByTime(1);
      expect(onExpire).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('SetupDialog i18n keys', () => {
  const src = readFileSync(join(__dirname, '../../components/Setup/SetupDialog.tsx'), 'utf8');
  const get = (o: unknown, path: string) =>
    path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], o);

  it('every static t() key exists, non-empty, in en and de', () => {
    const keys = [...src.matchAll(/\bt\('([\w.]+)'/g)].map(m => m[1]);
    expect(keys.length).toBeGreaterThanOrEqual(8);
    for (const k of keys) {
      for (const bundle of [setupEN, setupDE]) {
        const v = get(bundle, k);
        expect(typeof v, k).toBe('string');
        expect((v as string).trim(), k).not.toBe('');
      }
    }
  });

  it('dynamic error.* keys: every SetupError value resolves in en and de', () => {
    expect(src).toContain('t(`error.${error}`)');
    for (const bundle of [setupEN, setupDE]) {
      expect(Object.keys(bundle.error).sort()).toEqual(['logNotFound', 'noFolder']);
    }
  });
});

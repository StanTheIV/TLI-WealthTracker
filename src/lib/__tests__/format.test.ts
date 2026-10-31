import {afterAll, describe, expect, it, vi} from 'vitest';

// The formatters use the runtime default locale and time zone, and build their
// Intl instances at import. Pin both to en-US / UTC before the module loads so
// the outputs below are deterministic on any machine.
const restoreIntl = vi.hoisted(() => {
  const {NumberFormat, DateTimeFormat} = Intl;
  class PinnedNumberFormat extends NumberFormat {
    constructor(_locales?: string | string[], options?: Intl.NumberFormatOptions) {
      super('en-US', options);
    }
  }
  class PinnedDateTimeFormat extends DateTimeFormat {
    constructor(_locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
      super('en-US', {...options, timeZone: 'UTC'});
    }
  }
  Intl.NumberFormat   = PinnedNumberFormat as typeof Intl.NumberFormat;
  Intl.DateTimeFormat = PinnedDateTimeFormat as typeof Intl.DateTimeFormat;
  return () => {
    Intl.NumberFormat   = NumberFormat;
    Intl.DateTimeFormat = DateTimeFormat;
  };
});

import {formatDateTime, formatElapsed, formatFECompact, formatFEFull} from '../format';

afterAll(restoreIntl);

describe('formatFEFull', () => {
  it('always shows two decimals, grouped', () => {
    expect(formatFEFull(0)).toBe('0.00');
    expect(formatFEFull(5)).toBe('5.00');
    expect(formatFEFull(999.5)).toBe('999.50');
    expect(formatFEFull(1234.5)).toBe('1,234.50');
    expect(formatFEFull(2_500_000)).toBe('2,500,000.00');
  });

  it('rounds half away from zero at the second decimal', () => {
    expect(formatFEFull(1.005)).toBe('1.01'); // Intl rounds the shortest decimal form; toFixed gives 1.00
    expect(formatFEFull(0.004)).toBe('0.00');
    expect(formatFEFull(1234.567)).toBe('1,234.57');
  });

  it('renders negatives with a leading minus, and -0 or a rounded zero as plain zero', () => {
    expect(formatFEFull(-1234.5)).toBe('-1,234.50');
    expect(formatFEFull(-0.001)).toBe('0.00');
    expect(formatFEFull(-0)).toBe('0.00');
  });

  it('null is a dash, with or without options', () => {
    expect(formatFEFull(null)).toBe('—');
    expect(formatFEFull(null, {unit: true, plus: true})).toBe('—');
  });

  it('unit appends " FE"', () => {
    expect(formatFEFull(1234.5, {unit: true})).toBe('1,234.50 FE');
    expect(formatFEFull(-3, {unit: true})).toBe('-3.00 FE');
  });

  it('plus prefixes non-negative amounts only', () => {
    expect(formatFEFull(12, {plus: true})).toBe('+12.00');
    expect(formatFEFull(0, {plus: true})).toBe('+0.00');
    expect(formatFEFull(-0, {plus: true})).toBe('+0.00');
    expect(formatFEFull(-12, {plus: true})).toBe('-12.00');
  });

  it('zeroAsDash turns exactly zero into a bare dash (no unit)', () => {
    expect(formatFEFull(0, {zeroAsDash: true, unit: true})).toBe('—');
    expect(formatFEFull(-0, {zeroAsDash: true})).toBe('—');
    expect(formatFEFull(0.001, {zeroAsDash: true, unit: true})).toBe('0.00 FE');
    expect(formatFEFull(-50, {zeroAsDash: true, unit: true})).toBe('-50.00 FE');
  });
});

describe('formatFECompact', () => {
  it('below 1k: whole numbers, grouped rounding', () => {
    expect(formatFECompact(0)).toBe('0');
    expect(formatFECompact(640)).toBe('640');
    expect(formatFECompact(640.5)).toBe('641');
    expect(formatFECompact(999.4)).toBe('999');
    expect(formatFECompact(999.6)).toBe('1,000'); // rounds after the magnitude check
  });

  it('≥ 1k: one decimal and k', () => {
    expect(formatFECompact(1000)).toBe('1.0k');
    expect(formatFECompact(84_249)).toBe('84.2k');
    expect(formatFECompact(999_999)).toBe('1000.0k');
  });

  it('≥ 1M: two decimals and M', () => {
    expect(formatFECompact(1_000_000)).toBe('1.00M');
    expect(formatFECompact(1_234_567)).toBe('1.23M');
    expect(formatFECompact(2_500_000_000)).toBe('2500.00M');
  });

  it('negatives use the same magnitude bands', () => {
    expect(formatFECompact(-640)).toBe('-640');
    expect(formatFECompact(-5000)).toBe('-5.0k');
    expect(formatFECompact(-2_000_000)).toBe('-2.00M');
  });
});

describe('formatElapsed', () => {
  it('HH:MM:SS from whole, floored seconds', () => {
    expect(formatElapsed(0)).toBe('00:00:00');
    expect(formatElapsed(999)).toBe('00:00:00');
    expect(formatElapsed(1000)).toBe('00:00:01');
    expect(formatElapsed(59_999)).toBe('00:00:59');
    expect(formatElapsed(61_000)).toBe('00:01:01');
    expect(formatElapsed(3_725_000)).toBe('01:02:05');
  });

  it('does not wrap hours', () => {
    expect(formatElapsed(100 * 3_600_000)).toBe('100:00:00');
  });
});

describe('formatDateTime', () => {
  it('short month, day and 2-digit time', () => {
    expect(formatDateTime(Date.UTC(2026, 2, 5, 14, 7))).toBe('Mar 5, 02:07 PM');
    expect(formatDateTime(Date.UTC(2026, 11, 31, 0, 0))).toBe('Dec 31, 12:00 AM');
  });
});

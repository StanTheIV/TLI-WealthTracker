import {afterAll, describe, expect, it, vi} from 'vitest';

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

import {formatDateTime, formatFECompact, formatFEFull} from '../format';

afterAll(restoreIntl);

describe('phase 7 formatter fixes', () => {
  it('a negative value that rounds to zero carries no minus sign (float residue in net/cumulative)', () => {
    expect(formatFEFull(-0.004)).toBe('0.00');
    expect(formatFEFull(-1e-13, {plus: true})).toBe('+0.00');
  });

  it('formatFECompact renders a small negative as "0", not "-0"', () => {
    expect(formatFECompact(-0.4)).toBe('0');
  });

  it('formatDateTime(NaN) returns a dash instead of throwing inside a render', () => {
    expect(() => formatDateTime(NaN)).not.toThrow();
    expect(formatDateTime(NaN)).toBe('—');
    expect(formatDateTime(8.64e15 + 1)).toBe('—');
  });
});

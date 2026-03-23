import type {Processor, RawEvent} from './types';

export type CurrencyEvent = {type: 'currency_change'; currencyId: number; amount: number};

// ResourceMgr@:ChangeCurrency(4, 250)  → currency_change {currencyId: 4, amount: 250}
// ResourceMgr@:ChangeCurrency(4, -50)  → currency_change {currencyId: 4, amount: -50}
const RE_CURRENCY = /ResourceMgr@:ChangeCurrency\((\d+),\s*(-?\d+)\)/;

export class CurrencyProcessor implements Processor {
  readonly name = 'currency';

  test(line: string): boolean {
    return line.includes('ChangeCurrency');
  }

  process(line: string): RawEvent | null {
    const m = RE_CURRENCY.exec(line);
    if (m) return {type: 'currency_change', currencyId: +m[1], amount: +m[2]};
    return null;
  }
}

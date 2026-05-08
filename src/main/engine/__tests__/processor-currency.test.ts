/**
 * Currency processor — log line → RawEvent dispatch.
 *
 * Lives next to the seasonal-* tests because it shares the same dispatcher
 * fixture; if the processor surface grows, move to a sibling file.
 */
import {describe, it, expect} from 'vitest';
import {createDispatcher, log} from './seasonal-fixtures';

describe('Currency processor integration', () => {
  it('currency_change log line produces currency_change RawEvent via dispatcher', () => {
    const d = createDispatcher();
    const events = d.dispatch(log.currency(4, 250));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({type: 'currency_change', currencyId: 4, amount: 250});
  });

  it('handles negative amounts (spending currency)', () => {
    const d = createDispatcher();
    const events = d.dispatch(log.currency(4, -50));
    expect(events[0]).toEqual({type: 'currency_change', currencyId: 4, amount: -50});
  });
});

/**
 * End to end through the real engine: a paid map entry plus in-map negative
 * drops (consumption), valued by the overlay's rule and by analytics. The
 * invariants must hold, and the numbers must be the signed ones.
 */
import {describe, expect, it} from 'vitest';
import {AUCTION_TAX_RATE, NO_TAX} from '@/domain/valuation';
import {pipelineInvariants, runPipeline} from '../pipeline';
import {GOLDEN_ITEMS} from '../golden/items';
import {MATERIAL, MAP, Script, TOWN, TOWN_LEVEL, COMPASS, FE} from '../golden/synthetic';

/** Town, a paid entry (compass), loot, then a material consumed inside the map. */
const logWithNegativeDrop = () => Script.townToMap()
  .bag(32, MATERIAL, -3)
  .bag(40, FE, 8)
  .zone(60, MAP, TOWN, TOWN_LEVEL)
  .text();

describe('cost charged and negative in-map drops', () => {
  it('analytics and the overlay agree, mechanics re-add, and the negative reduces income', async () => {
    const result = await runPipeline(logWithNegativeDrop(), {items: GOLDEN_ITEMS, tax: NO_TAX});
    expect(result.sessions).toHaveLength(1);
    const {id, session, analytics} = result.sessions[0];
    expect(session!.drops[String(MATERIAL)]).toBe(-3);
    expect(session!.spent[String(COMPASS)]).toBeGreaterThan(0);

    const inv = pipelineInvariants(result)[id];
    expect(inv.liveMatchesAnalytics).toEqual({ok: true});
    expect(inv.mechanicsNetReconciles).toEqual({ok: true});
    expect(inv.netReconciles).toEqual({ok: true});

    // Signed: the consumed material is a loss (-3 x its price), not a clamped-away zero.
    const perItem = (k: string) => session!.drops[k] * GOLDEN_ITEMS[k].price;
    const income = Object.keys(session!.drops).reduce((s, k) => s + perItem(k), 0);
    expect(analytics!.totals.income.live).toBeCloseTo(income, 6);
    expect(perItem(String(MATERIAL))).toBeLessThan(0);
    expect(session!.drops[String(FE)]).toBe(20);
  });

  it('holds with the auction tax on too', async () => {
    const result = await runPipeline(logWithNegativeDrop(), {
      items: GOLDEN_ITEMS, tax: {enabled: true, rate: AUCTION_TAX_RATE},
    });
    const {id} = result.sessions[0];
    const inv = pipelineInvariants(result)[id];
    expect(inv.liveMatchesAnalytics).toEqual({ok: true});
    expect(inv.mechanicsNetReconciles).toEqual({ok: true});
  });
});

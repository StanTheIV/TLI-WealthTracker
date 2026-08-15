import {mapRawType, type ItemType} from '@/types/itemType';

/**
 * Auction-house tax — the single place a displayed FE value is discounted.
 *
 * The game takes a cut when an item sells on the auction house, so the raw
 * market price the worker scrapes (the median of live listings) overstates what
 * a haul is actually worth. Every FE figure the app SHOWS must therefore come
 * from `taxedValue` / `taxedUnitPrice`, directly or via a taxed `PriceLookup`.
 *
 * Persistence deliberately stores GROSS values (see `main/wealth-recorder.ts`):
 * gross is the raw truth, net is derived, and storing net would freeze the
 * policy into historical rows that could never be re-derived.
 *
 * `src/lib/__tests__/tax-coverage.test.ts` pins the list of files allowed to
 * multiply a quantity by a price. If you are adding an eighth valuation site,
 * that test is what will fail — route it through here rather than widening the
 * allowlist without thought.
 */

/** The auction house's cut. One constant: the checkbox toggles it on and off,
 *  the rate itself is not user-configurable. */
export const AUCTION_TAX_RATE = 0.15;

/** Types the auction house does not tax. Fuel is traded on the material
 *  exchange rather than the auction house, so it sells at face value. */
const UNTAXED_TYPES: ReadonlySet<ItemType> = new Set<ItemType>(['fuel']);

/** The tax policy for one valuation pass. Passed explicitly rather than read
 *  from the settings store: that keeps these functions pure, and it forces
 *  components to SUBSCRIBE to the setting so a toggle actually re-renders them.
 *  Use `useTaxConfig()` in the renderer to get a stable-identity instance. */
export interface TaxConfig {
  enabled: boolean;
  rate:    number;
}

export const NO_TAX: TaxConfig = {enabled: false, rate: 0};

/**
 * Whether this item's displayed value takes the auction-house cut.
 *
 * Takes the RAW `DbItem.type` string. That column is `TEXT NOT NULL DEFAULT ''`
 * and an API lookup or batch import can write an unmapped name such as
 * 'Corrosion Material', so comparing against 'fuel' directly would tax fuel
 * that arrived by that path. `mapRawType` normalises both spellings.
 */
export function isTaxable(rawType: string | undefined): boolean {
  return !UNTAXED_TYPES.has(mapRawType(rawType));
}

/**
 * The central multiplier: quantity x price, less the auction-house cut.
 *
 * `qty` is signed. A negative quantity is an auction-house conversion — the
 * item left the bag and paid out FE — and scaling it by (1 - rate) is correct:
 * that sale really did net 15% less. Nothing is clamped here; whether negatives
 * count as income stays the caller's policy.
 */
export function taxedValue(
  qty:     number,
  price:   number,
  rawType: string | undefined,
  cfg:     TaxConfig,
): number {
  const gross = qty * price;
  if (!cfg.enabled || !isTaxable(rawType)) return gross;
  return gross * (1 - cfg.rate);
}

/** Unit-price variant, for columns showing a per-unit figure. Tables render a
 *  unit price beside a total, so both must take the cut or the row reads as
 *  broken arithmetic (10 FE x 10 = 85 FE). */
export function taxedUnitPrice(price: number, rawType: string | undefined, cfg: TaxConfig): number {
  return taxedValue(1, price, rawType, cfg);
}

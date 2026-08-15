import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import {describe, it, expect} from 'vitest';

/**
 * Tripwire for the auction-house tax.
 *
 * Every FE figure the app displays must be valued through `@/lib/tax`. Nothing
 * in the type system enforces that — `makePriceLookup` has only three callers,
 * so the sites that multiply `qty * price` inline stay green while showing
 * untaxed values. This test is the guard that catches them.
 *
 * It is a tripwire, not a proof: a rewrite to `price * qty`, a destructured
 * intermediate or a helper function would slip past the regex. Its job is to
 * fail loudly when someone adds a valuation site the obvious way.
 */

const SRC = join(__dirname, '..', '..');

/** Files allowed to multiply a quantity by a price. Everything here except the
 *  main-process recorder must import from '@/lib/tax'. */
const VALUATION_SITES = [
  'lib/tax.ts',
  'components/Sessions/analytics/valuation.ts',
  'components/Sessions/analytics/items.ts',
  'components/Dashboard/TrackerPanel.tsx',
  'components/Dashboard/DropTable.tsx',
  'components/Sessions/SessionsTable.tsx',
  // Persists GROSS values on purpose — net is derived at read time, so that a
  // toggle rescales the whole wealth history instead of stepping it.
  'main/wealth-recorder.ts',
];

/** Sites that must apply the tax themselves. Excluded:
 *   - `lib/tax.ts` — it IS the module.
 *   - `main/wealth-recorder.ts` — persists gross on purpose.
 *   - `analytics/items.ts` — values through the `PriceLookup` it is handed, so
 *     the prices reach it already taxed and importing the module would be wrong. */
const MUST_IMPORT_TAX = VALUATION_SITES.filter(f => ![
  'lib/tax.ts',
  'main/wealth-recorder.ts',
  'components/Sessions/analytics/items.ts',
].includes(f));

/** Reads the stored wealth breakdown, which holds a pre-computed gross total.
 *  Those must be recomputed per item rather than scaled, since the stored
 *  aggregate is type-blind and cannot honour the fuel exemption. */
const WEALTH_READERS = [
  'components/Dashboard/ItemBreakdown.tsx',
  'state/wealthStore.ts',
];

const MULT = /\b(?:qty|quantity|amount)\b\s*\*|\*\s*\b(?:price|unitPrice|prices)\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === '__tests__' || entry === 'test' ? [] : sourceFiles(full);
    }
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/** Strips comments so prose mentioning "qty * price" isn't reported as code. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const rel = (f: string) => relative(SRC, f).split(sep).join('/');

describe('auction tax coverage', () => {
  it('has no price multiplication outside the known valuation sites', () => {
    const offenders = sourceFiles(SRC)
      .filter(f => MULT.test(stripComments(readFileSync(f, 'utf8'))))
      .map(rel)
      .filter(f => !VALUATION_SITES.includes(f))
      .sort();

    expect(
      offenders,
      'New FE valuation site(s). Route the value through @/lib/tax (taxedValue / '
      + 'taxedUnitPrice, or a taxed PriceLookup), then add the file to VALUATION_SITES.',
    ).toEqual([]);
  });

  it('every valuation site applies the tax', () => {
    for (const f of MUST_IMPORT_TAX) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src, `${f} multiplies qty by price but never imports @/lib/tax`)
        .toMatch(/from '@\/lib\/tax'/);
    }
  });

  // These read a pre-computed gross total out of the wealth breakdown rather
  // than multiplying, so the regex above cannot see them.
  it('the wealth read path taxes the stored gross totals', () => {
    for (const f of WEALTH_READERS) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src, `${f} renders stored wealth values but never imports @/lib/tax`)
        .toMatch(/from '@\/lib\/tax'/);
    }
  });
});

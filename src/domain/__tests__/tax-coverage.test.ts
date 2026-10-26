import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import {describe, it, expect} from 'vitest';

/**
 * Tripwire for the auction-house tax.
 *
 * Every FE figure the app displays must be valued through the tax module
 * (`domain/valuation/tax.ts`, imported via `@/domain/valuation`). Nothing
 * in the type system enforces that — a site that multiplies `qty * price`
 * inline stays green while showing untaxed values. This test is the guard that
 * catches them. Session and live loot alike are valued by `valueQty` /
 * `valueItem` / `liveValue` over a taxed `PriceLookup`, so the renderer has no
 * multiplication site of its own.
 *
 * It is a tripwire, not a proof: a rewrite to `price * qty`, a destructured
 * intermediate or a helper function would slip past the regex. Its job is to
 * fail loudly when someone adds a valuation site the obvious way.
 */

const SRC = join(__dirname, '..', '..');

const TAX_MODULE = 'domain/valuation/tax.ts';

/** Files allowed to multiply a quantity by a price. Everything here except the
 *  exclusions below must import the tax module. */
const VALUATION_SITES = [
  TAX_MODULE,
  // The one valuation rule — every analytics and overlay figure is built on it.
  'domain/valuation/value.ts',
  // Persists GROSS values on purpose — net is derived at read time, so that a
  // toggle rescales the whole wealth history instead of stepping it.
  'main/wealth-recorder.ts',
  // Replay CLI diagnostics — gross FE beside a debugging report, never shown in the app.
  'replay/report.ts',
];

/** Sites that must apply the tax themselves. Excluded:
 *   - `domain/valuation/tax.ts` — it IS the module.
 *   - `main/wealth-recorder.ts` — persists gross on purpose.
 *   - `replay/report.ts` — gross diagnostics for the replay CLI. */
const MUST_IMPORT_TAX = VALUATION_SITES.filter(f => ![
  TAX_MODULE,
  'main/wealth-recorder.ts',
  'replay/report.ts',
].includes(f));

/** Reads the stored wealth breakdown, which holds a pre-computed gross total.
 *  Those must be recomputed per item rather than scaled, since the stored
 *  aggregate is type-blind and cannot honour the fuel exemption. */
const WEALTH_READERS = [
  'components/Dashboard/ItemBreakdown.tsx',
  'state/wealthStore.ts',
];

const MULT = /\b(?:qty|quantity|amount)\b\s*\*|\*\s*\b(?:price|unitPrice|prices)\b/;

/** The tax module's own exports. The `@/domain/valuation` barrel also carries the
 *  Valuation arithmetic, so an import from it only counts when it names one of these. */
const TAX_EXPORTS = [...readFileSync(join(SRC, TAX_MODULE), 'utf8')
  .matchAll(/^export\s+(?:const|function|interface|type)\s+(\w+)/gm)].map(m => m[1]);

/** Whether `file` imports a tax-module export: via the barrel from outside the
 *  module, or from `./tax` for a sibling inside it. */
function importsTax(file: string, src: string): boolean {
  const importRe = file.startsWith('domain/valuation/')
    ? /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'\.\/tax'/g
    : /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'@\/domain\/valuation'/g;
  return [...src.matchAll(importRe)].some(m => m[1].split(',')
    .map(s => s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0])
    .some(name => TAX_EXPORTS.includes(name)));
}

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
  // A stale path would silently allowlist nothing and exempt nothing.
  it('lists only files that exist, and reads the tax module exports', () => {
    for (const f of [...VALUATION_SITES, ...WEALTH_READERS]) {
      expect(existsSync(join(SRC, f)), `${f} is listed but does not exist`).toBe(true);
    }
    expect(TAX_EXPORTS).toEqual(expect.arrayContaining(['taxedValue', 'taxedUnitPrice', 'TaxConfig']));
  });

  it('has no price multiplication outside the known valuation sites', () => {
    const offenders = sourceFiles(SRC)
      .filter(f => MULT.test(stripComments(readFileSync(f, 'utf8'))))
      .map(rel)
      .filter(f => !VALUATION_SITES.includes(f))
      .sort();

    expect(
      offenders,
      'New FE valuation site(s). Route the value through @/domain/valuation (taxedValue / '
      + 'taxedUnitPrice, or a taxed PriceLookup), then add the file to VALUATION_SITES.',
    ).toEqual([]);
  });

  it('every valuation site applies the tax', () => {
    for (const f of MUST_IMPORT_TAX) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(importsTax(f, src), `${f} multiplies qty by price but never imports the tax module`)
        .toBe(true);
    }
  });

  // These read a pre-computed gross total out of the wealth breakdown rather
  // than multiplying, so the regex above cannot see them.
  it('the wealth read path taxes the stored gross totals', () => {
    for (const f of WEALTH_READERS) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(importsTax(f, src), `${f} renders stored wealth values but never imports the tax module`)
        .toBe(true);
    }
  });
});

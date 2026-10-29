/**
 * Renderer display formatters: FE amounts, elapsed time, dates. Locale is the
 * runtime default (`undefined`), fixed for the renderer's lifetime, so each
 * Intl formatter is built once.
 */

const DASH = '—';

const fe2 = new Intl.NumberFormat(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
const fe0 = new Intl.NumberFormat(undefined, {maximumFractionDigits: 0});
const shortDateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit',
});

export interface FormatFEOptions {
  /** Append `" FE"`. Placeholders never carry it. */
  unit?:       boolean;
  /** Prefix `"+"` on non-negative amounts, for signed income / net figures. */
  plus?:       boolean;
  /** Render exactly 0 as `"—"` (nothing earned / no price yet). */
  zeroAsDash?: boolean;
}

/**
 * Full-precision FE amount (2 decimals, grouped): `1,234.50`. `null` → `"—"`.
 * Negative zero renders as `0.00` — a zero-priced spent row is not a loss.
 */
export function formatFEFull(value: number | null, opts: FormatFEOptions = {}): string {
  if (value === null || (opts.zeroAsDash && value === 0)) return DASH;
  const v    = value === 0 ? 0 : value; // -0 → 0
  const text = `${opts.plus && v >= 0 ? '+' : ''}${fe2.format(v)}`;
  return opts.unit ? `${text} FE` : text;
}

/** Compact FE for axis ticks and dense cells, by magnitude: `1.20M` / `84.2k` / `640`. */
export function formatFECompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)     return `${(value / 1_000).toFixed(1)}k`;
  return fe0.format(value);
}

/** Stopwatch time `HH:MM:SS` (whole seconds, floored; hours not wrapped). */
export function formatElapsed(ms: number): string {
  const s   = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Short date + time of a timestamp (ms): `Mar 5, 02:07 PM` in en-US. */
export function formatDateTime(ts: number): string {
  return shortDateTime.format(new Date(ts));
}

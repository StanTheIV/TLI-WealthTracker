import type {TFunction} from 'i18next';
import type {SeasonalPhase} from '@/types/electron';
import type {MechanicKey, Valuation} from '../analytics';

/** Row label for a mechanic. Sandlord's two phases share one bucket, so only
 *  the in-map coin tile is qualified — 'hub' and legacy null both read plain. */
export function mechanicLabel(
  t: TFunction<'sessions'>,
  mechanic: MechanicKey,
  phase: SeasonalPhase | null = null,
): string {
  if (mechanic === 'sandlord' && phase === 'map') return t('details.source.sandlordMap');
  return t(`details.source.${mechanic}` as never);
}

/** Compact FE for axis ticks and dense cells: 1.2M / 84.2k / 640. */
export function formatFE(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)     return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString(undefined, {maximumFractionDigits: 0});
}

/** Full precision for tooltips and totals. */
export function formatFEFull(value: number): string {
  return value.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

export function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatFE(value)}`;
}

/** h/m/s, dropping empty leading units. */
export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function formatPct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

/** Which leg of a Valuation the page is currently showing. */
export type ValueMode = 'snapshot' | 'live';

export function pick(v: Valuation, mode: ValueMode): number {
  return mode === 'snapshot' ? v.snapshot : v.live;
}

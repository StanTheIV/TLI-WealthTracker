import type {TFunction} from 'i18next';
import type {SeasonalPhase} from '@/shared/contracts/engine';
import type {MechanicKey, Valuation} from '@/domain/session-analytics';

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

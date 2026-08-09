import type {ReactNode} from 'react';
import {useTranslation} from 'react-i18next';
import {useTheme} from '@/theme/ThemeContext';
import type {SessionAnalytics} from '../analytics';
import {mechanicColors} from './colors';
import {formatFEFull, formatSeconds, pick, type ValueMode} from './format';

function Tile({label, value, sub, tone, hero, meter}: {
  label: string;
  value: ReactNode;
  sub?:  ReactNode;
  tone?: 'pos' | 'neg' | 'gold' | 'accent';
  hero?: boolean;
  meter?: {pct: number};
}) {
  const toneClass =
    tone === 'pos'    ? 'text-success'
    : tone === 'neg'  ? 'text-danger'
    : tone === 'gold' ? 'text-gold'
    : tone === 'accent' ? 'text-accent'
    : 'text-text-primary';

  return (
    <div className={`flex flex-col gap-1 px-4 py-3.5 ${hero ? 'bg-surface-elevated' : 'bg-surface'}`}>
      <span className="text-[10px] font-semibold uppercase tracking-widest text-text-disabled">
        {label}
      </span>
      <span className={`text-2xl font-bold leading-tight tabular-nums ${toneClass}`}>
        {value}
      </span>
      {sub && <span className="text-[11px] text-text-secondary tabular-nums">{sub}</span>}
      {meter && (
        <div className="h-1 rounded-sm bg-border overflow-hidden flex mt-1">
          <span className="block h-full bg-success" style={{width: `${meter.pct}%`}} />
          <span className="block h-full bg-text-disabled" style={{width: `${100 - meter.pct}%`}} />
        </div>
      )}
    </div>
  );
}

export default function StatTiles({analytics, mode}: {analytics: SessionAnalytics; mode: ValueMode}) {
  const {t}  = useTranslation('sessions');
  const theme = useTheme();
  const colors = mechanicColors(theme);
  const {totals, mechanics} = analytics;

  const fe = (v: {snapshot: number; live: number}) => formatFEFull(pick(v, mode));

  // Best paying mechanic, town excluded — it has no rate to compare.
  const best = mechanics
    .filter(m => m.key !== 'town' && m.seconds > 0)
    .reduce<typeof mechanics[number] | null>(
      (top, m) => (top === null || pick(m.fePerHour, mode) > pick(top.fePerHour, mode) ? m : top),
      null,
    );

  const contentPct = totals.totalSeconds > 0
    ? ((totals.totalSeconds - totals.townSeconds) / totals.totalSeconds) * 100
    : 0;
  const townPct = totals.totalSeconds > 0 ? (totals.townSeconds / totals.totalSeconds) * 100 : 0;
  const costShare = totals.income.live > 0 ? (pick(totals.cost, mode) / pick(totals.income, mode)) * 100 : 0;
  const townTrips = Math.max(1, totals.mapCount);

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-border border border-border rounded-lg overflow-hidden">
      <Tile
        hero
        label={t('details.netFE')}
        value={`${pick(totals.net, mode) >= 0 ? '+' : ''}${fe(totals.net)}`}
        tone={pick(totals.net, mode) >= 0 ? 'pos' : 'neg'}
        sub={t('details.incomeMinusCost', {income: fe(totals.income), cost: fe(totals.cost)})}
      />
      <Tile
        hero
        label={t('details.netPerHour')}
        value={fe(totals.netPerHour)}
        tone="accent"
        sub={t('details.grossPerHour', {value: fe(totals.incomePerHour)})}
      />
      <Tile
        label={t('details.totalFE')}
        value={fe(totals.income)}
        tone="gold"
        sub={t('details.itemsCount', {qty: totals.totalQty.toLocaleString(), unique: totals.uniqueItems})}
      />
      <Tile
        label={t('details.totalCost')}
        value={fe(totals.cost)}
        tone={pick(totals.cost, mode) > 0 ? 'neg' : undefined}
        sub={t('details.shareOfIncome', {
          pct: costShare.toFixed(1),
          perMap: totals.costPerMap ? fe(totals.costPerMap) : '—',
        })}
      />

      <Tile
        label={t('details.mapsRun')}
        value={String(totals.mapCount)}
        sub={t('details.avgPerMap', {
          duration: formatSeconds(totals.mapCount > 0 ? totals.mapSeconds / totals.mapCount : 0),
          net:      fe({
            snapshot: totals.mapCount > 0 ? totals.net.snapshot / totals.mapCount : 0,
            live:     totals.mapCount > 0 ? totals.net.live / totals.mapCount : 0,
          }),
        })}
      />
      <Tile
        label={t('details.timeInContent')}
        value={formatSeconds(totals.totalSeconds - totals.townSeconds)}
        sub={t('details.pctOfSession', {pct: contentPct.toFixed(1)})}
        meter={{pct: contentPct}}
      />
      <Tile
        label={t('details.townTime')}
        value={formatSeconds(totals.townSeconds)}
        sub={t('details.perTrip', {
          pct: townPct.toFixed(1),
          avg: formatSeconds(totals.townSeconds / townTrips),
        })}
      />
      <Tile
        label={t('details.bestMechanic')}
        value={
          best
            ? <span style={{color: colors[best.key]}}>{t(`details.source.${best.key}` as never)}</span>
            : '—'
        }
        sub={best
          ? t('details.rateAndShare', {
              rate: formatFEFull(pick(best.fePerHour, mode)),
              pct:  best.timePct.toFixed(1),
            })
          : undefined}
      />
    </div>
  );
}

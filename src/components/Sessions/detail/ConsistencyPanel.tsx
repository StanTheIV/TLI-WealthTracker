import {useTranslation} from 'react-i18next';
import type {SessionAnalytics} from '../analytics';
import {formatFEFull, formatFE, pick, type ValueMode} from './format';

function Row({label, value, tone}: {label: string; value: string; tone?: 'pos' | 'neg'}) {
  const cls = tone === 'pos' ? 'text-success' : tone === 'neg' ? 'text-danger' : 'text-text-primary';
  return (
    <div className="flex justify-between items-baseline py-1.5 border-b border-border/50 last:border-0">
      <span className="text-xs text-text-secondary">{label}</span>
      <strong className={`tabular-nums text-[13px] ${cls}`}>{value}</strong>
    </div>
  );
}

export function ConsistencyPanel({analytics, mode}: {analytics: SessionAnalytics; mode: ValueMode}) {
  const {t} = useTranslation('sessions');
  const {mapNetStats: stats} = analytics;

  if (stats.histogram.length === 0) return null;

  const maxCount = Math.max(...stats.histogram.map(b => b.count), 1);
  const median   = pick(stats.median, mode);
  const mean     = pick(stats.mean, mode);
  const skew     = median > 0 ? ((mean - median) / median) * 100 : null;

  return (
    <div className="bg-surface border border-border rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-end gap-[3px] h-[90px]">
        {stats.histogram.map((b, i) => (
          <div
            key={i}
            title={`${formatFE(b.from)} – ${formatFE(b.to)}: ${b.count}`}
            className={`flex-1 rounded-t-sm min-h-[2px] ${b.from < 0 ? 'bg-danger' : 'bg-accent'}`}
            style={{height: `${(b.count / maxCount) * 100}%`}}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-text-disabled tabular-nums">
        <span>{formatFE(stats.histogram[0].from)}</span>
        <span>{formatFE(stats.histogram[stats.histogram.length - 1].to)}</span>
      </div>

      <div className="flex flex-col">
        <Row label={t('details.median')} value={formatFEFull(median)} />
        <Row label={t('details.mean')} value={formatFEFull(mean)} />
        {stats.best && (
          <Row
            label={t('details.bestMap')}
            value={`#${stats.best.mapIndex} · ${formatFEFull(pick(stats.best.net, mode))}`}
            tone="pos"
          />
        )}
        {stats.worst && (
          <Row
            label={t('details.worstMap')}
            value={`#${stats.worst.mapIndex} · ${formatFEFull(pick(stats.worst.net, mode))}`}
            tone={pick(stats.worst.net, mode) < 0 ? 'neg' : undefined}
          />
        )}
      </div>

      {skew !== null && skew > 15 && (
        <p className="text-[11px] text-text-secondary bg-gold/10 border-l-2 border-gold rounded-r px-3 py-2 leading-relaxed">
          {t('details.skewNote', {pct: skew.toFixed(0)})}
        </p>
      )}
    </div>
  );
}

export function CostPanel({analytics, mode}: {analytics: SessionAnalytics; mode: ValueMode}) {
  const {t} = useTranslation('sessions');
  const {totals} = analytics;

  const roi = mode === 'snapshot' ? totals.roiMultiple.snapshot : totals.roiMultiple.live;
  const costShare = pick(totals.income, mode) > 0
    ? (pick(totals.cost, mode) / pick(totals.income, mode)) * 100
    : 0;

  return (
    <div className="bg-surface border border-border rounded-lg p-4 flex flex-col">
      <Row label={t('details.roi')} value={roi === null ? '—' : `${roi.toFixed(2)}×`} tone={roi !== null && roi >= 1 ? 'pos' : undefined} />
      <Row
        label={t('details.costPerMap')}
        value={totals.costPerMap ? formatFEFull(pick(totals.costPerMap, mode)) : '—'}
      />
      <Row
        label={t('details.breakEven')}
        value={totals.breakEvenYield ? formatFEFull(pick(totals.breakEvenYield, mode)) : '—'}
      />
      <Row
        label={t('details.unprofitable')}
        value={`${totals.mapsUnprofitable} / ${analytics.perMap.length}`}
        tone={totals.mapsUnprofitable > 0 ? 'neg' : undefined}
      />
      <Row label={t('details.costShare')} value={`${costShare.toFixed(1)}%`} />
    </div>
  );
}

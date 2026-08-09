import {useTranslation} from 'react-i18next';
import {useTheme} from '@/theme/ThemeContext';
import type {SessionAnalytics} from '../analytics';
import {mechanicColors} from './colors';
import {Swatch} from './primitives';
import {formatFEFull, formatSeconds, pick, type ValueMode} from './format';

/** Below this share a segment gets no inline label — the text would overflow. */
const LABEL_THRESHOLD = 7;

export default function TimeValueBars({analytics, mode}: {analytics: SessionAnalytics; mode: ValueMode}) {
  const {t}    = useTranslation('sessions');
  const theme  = useTheme();
  const colors = mechanicColors(theme);

  const byTime  = [...analytics.mechanics].filter(m => m.timePct > 0).sort((a, b) => b.timePct - a.timePct);
  const byValue = [...analytics.mechanics]
    .filter(m => pick(m.valuePct, mode) > 0)
    .sort((a, b) => pick(b.valuePct, mode) - pick(a.valuePct, mode));

  if (byTime.length === 0) return null;

  const legend = [...new Set([...byTime, ...byValue].map(m => m.key))];

  return (
    <div className="bg-surface border border-border rounded-lg p-4 flex flex-col gap-4">
      <Bar
        label={t('details.shareOfTime')}
        total={formatSeconds(analytics.totals.totalSeconds)}
        segments={byTime.map(m => ({key: m.key, pct: m.timePct, color: colors[m.key]}))}
      />
      <Bar
        label={t('details.shareOfValue')}
        total={`${formatFEFull(pick(analytics.totals.income, mode))} FE`}
        segments={byValue.map(m => ({key: m.key, pct: pick(m.valuePct, mode), color: colors[m.key]}))}
      />

      <div className="flex flex-wrap gap-x-3 gap-y-1.5 pt-1 text-[11px] text-text-secondary">
        {legend.map(key => (
          <span key={key} className="inline-flex items-center gap-1.5">
            <Swatch color={colors[key]} />
            {t(`details.source.${key}` as never)}
          </span>
        ))}
      </div>
    </div>
  );
}

function Bar({label, total, segments}: {
  label:    string;
  total:    string;
  segments: {key: string; pct: number; color: string}[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-[10px] font-semibold uppercase tracking-widest text-text-disabled">
        <span>{label}</span>
        <span className="tabular-nums">{total}</span>
      </div>
      <div className="flex h-[22px] rounded gap-px overflow-hidden">
        {segments.map(s => (
          <span
            key={s.key}
            title={`${s.pct.toFixed(1)}%`}
            className="flex items-center justify-center text-[10px] font-bold overflow-hidden"
            style={{width: `${s.pct}%`, backgroundColor: s.color, color: 'var(--color-bg)'}}
          >
            {s.pct >= LABEL_THRESHOLD ? `${Math.round(s.pct)}%` : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

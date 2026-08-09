import {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useTheme} from '@/theme/ThemeContext';
import type {SessionAnalytics, TimelineSegment} from '../analytics';
import {mechanicColors} from './colors';
import {Swatch} from './primitives';
import {formatFEFull, formatSeconds, pick, type ValueMode} from './format';

const COLLAPSED_RUNS = 12;

/** Flatten parents with their nested mechanics so children render directly
 *  beneath the run they happened in, indented. */
function flatten(timeline: TimelineSegment[]): {seg: TimelineSegment; child: boolean}[] {
  return timeline.flatMap(seg => [
    {seg, child: false},
    ...seg.children.map(c => ({seg: c, child: true})),
  ]);
}

export default function RunLog({analytics, mode}: {analytics: SessionAnalytics; mode: ValueMode}) {
  const {t}    = useTranslation('sessions');
  const theme  = useTheme();
  const colors = mechanicColors(theme);
  const [expanded, setExpanded] = useState(false);

  const all = flatten(analytics.timeline);
  if (all.length === 0) {
    return <p className="text-xs text-text-disabled py-8 text-center">{t('details.timelineEmpty')}</p>;
  }

  const visible = expanded ? all : all.slice(0, COLLAPSED_RUNS);
  const bestIndex = analytics.mapNetStats.best?.mapIndex;

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr className="text-[10px] font-semibold uppercase tracking-widest text-text-disabled">
              <th className="pb-2 px-2.5 border-b border-border text-left">{t('details.runIndex')}</th>
              <th className="pb-2 px-2.5 border-b border-border text-left">{t('details.content')}</th>
              <th className="pb-2 px-2.5 border-b border-border text-right">{t('details.duration')}</th>
              <th className="pb-2 px-2.5 border-b border-border text-right">{t('details.totalFEShort')}</th>
              <th className="pb-2 px-2.5 border-b border-border text-right">{t('details.cost')}</th>
              <th className="pb-2 px-2.5 border-b border-border text-right">{t('details.net')}</th>
              <th className="pb-2 px-2.5 border-b border-border text-right">{t('details.fePerHour')}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({seg, child}) => {
              const income = pick(seg.income, mode);
              const cost   = pick(seg.cost, mode);
              const net    = income - cost;
              const rate   = seg.seconds > 0 ? net * (3600 / seg.seconds) : 0;
              return (
                <tr key={seg.key} className="border-b border-border/50 hover:bg-accent/5 transition-colors">
                  <td className="py-2 px-2.5 text-left tabular-nums text-text-secondary">
                    {child ? '' : seg.mapIndex}
                  </td>
                  <td className={`py-2 px-2.5 text-left whitespace-nowrap ${child ? 'pl-7' : ''}`}>
                    <span className={`inline-flex items-center gap-2 ${child ? 'text-text-secondary' : 'font-semibold'}`}>
                      <Swatch color={colors[seg.mechanic]} />
                      {child && '↳ '}{t(`details.source.${seg.mechanic}` as never)}
                    </span>
                    {!child && seg.mapIndex === bestIndex && (
                      <span className="ml-1.5 text-[9px] font-bold uppercase tracking-wider text-gold border border-gold/40 bg-gold/10 rounded px-1.5 py-px">
                        {t('details.bestMap')}
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-2.5 text-right tabular-nums">{formatSeconds(seg.seconds)}</td>
                  <td className="py-2 px-2.5 text-right tabular-nums text-gold">{formatFEFull(income)}</td>
                  <td className="py-2 px-2.5 text-right tabular-nums text-danger">
                    {cost > 0 ? formatFEFull(cost) : '—'}
                  </td>
                  <td className={`py-2 px-2.5 text-right tabular-nums ${net < 0 ? 'text-danger' : 'text-success'}`}>
                    {net >= 0 ? '+' : ''}{formatFEFull(net)}
                  </td>
                  <td className="py-2 px-2.5 text-right tabular-nums text-text-secondary">
                    {formatFEFull(rate)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {all.length > COLLAPSED_RUNS && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="w-full pt-3 text-center text-xs text-accent hover:opacity-80 transition-opacity"
        >
          {expanded ? t('details.showLess') : t('details.showAll', {count: all.length})}
        </button>
      )}
    </div>
  );
}

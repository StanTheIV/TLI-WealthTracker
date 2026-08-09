import {useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useTheme} from '@/theme/ThemeContext';
import type {MechanicStats, SessionAnalytics} from '../analytics';
import {mechanicColors} from './colors';
import {ColHeader, Swatch} from './primitives';
import {formatFEFull, formatPct, formatSeconds, pick, type ValueMode} from './format';

type Field = 'mechanic' | 'runs' | 'seconds' | 'timePct' | 'net' | 'valuePct' | 'fePerHour' | 'avgPerRun' | 'avgSeconds';

export default function MechanicTable({analytics, mode}: {analytics: SessionAnalytics; mode: ValueMode}) {
  const {t}    = useTranslation('sessions');
  const theme  = useTheme();
  const colors = mechanicColors(theme);

  const [sortField, setSortField] = useState<Field>('fePerHour');
  const [sortDir, setSortDir]     = useState<'asc' | 'desc'>('desc');

  function handleSort(field: Field) {
    if (field === sortField) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDir('desc'); }
  }

  const {rows, bestRate} = useMemo(() => {
    const value = (m: MechanicStats): number | string => {
      switch (sortField) {
        case 'mechanic':  return m.key;
        case 'runs':      return m.runs;
        case 'seconds':   return m.seconds;
        case 'timePct':   return m.timePct;
        case 'net':       return pick(m.net, mode);
        case 'valuePct':  return pick(m.valuePct, mode);
        case 'avgPerRun': return pick(m.avgPerRun, mode);
        case 'avgSeconds': return m.avgSeconds;
        default:          return pick(m.fePerHour, mode);
      }
    };

    const sorted = [...analytics.mechanics].sort((a, b) => {
      const av = value(a); const bv = value(b);
      const cmp = typeof av === 'string' ? String(av).localeCompare(String(bv)) : (av as number) - (bv as number);
      return sortDir === 'asc' ? cmp : -cmp;
    });

    // Rate bars are normalised against the best paying mechanic; town is a
    // residual with no rate to compare and never wins the badge.
    const rated = analytics.mechanics.filter(m => m.key !== 'town' && m.seconds > 0);
    const best  = rated.length > 0 ? Math.max(...rated.map(m => pick(m.fePerHour, mode))) : 0;
    return {rows: sorted, bestRate: best};
  }, [analytics.mechanics, sortField, sortDir, mode]);

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 rounded-lg border border-border bg-surface text-xs text-text-disabled px-6 text-center">
        {t('details.mechanicsEmpty')}
      </div>
    );
  }

  const totals = analytics.totals;

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr>
              {([
                ['mechanic',   t('details.mechanic'),  'left'],
                ['runs',       t('details.runs'),      'right'],
                ['seconds',    t('details.time'),      'right'],
                ['timePct',    t('details.pctTime'),   'right'],
                ['net',        t('details.net'),       'right'],
                ['valuePct',   t('details.pctValue'),  'right'],
                ['fePerHour',  t('details.fePerHour'), 'right'],
                ['avgPerRun',  t('details.avgRun'),    'right'],
                ['avgSeconds', t('details.avgDur'),    'right'],
              ] as [Field, string, 'left' | 'right'][]).map(([field, label, align]) => (
                <th key={field} className="pb-2 px-2.5 border-b border-border whitespace-nowrap">
                  <ColHeader
                    label={label} field={field} sortField={sortField}
                    sortDir={sortDir} onSort={handleSort} align={align}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(m => {
              const rate    = pick(m.fePerHour, mode);
              const net     = pick(m.net, mode);
              const isTown  = m.key === 'town';
              const isTop   = !isTown && bestRate > 0 && rate === bestRate;
              return (
                <tr key={m.key} className="border-b border-border/50 hover:bg-accent/5 transition-colors">
                  <td className="py-2 px-2.5 text-left whitespace-nowrap">
                    <span className="inline-flex items-center gap-2 font-semibold">
                      <Swatch color={colors[m.key]} />
                      {t(`details.source.${m.key}` as never)}
                    </span>
                    {isTop && (
                      <span className="ml-1.5 text-[9px] font-bold uppercase tracking-wider text-gold border border-gold/40 bg-gold/10 rounded px-1.5 py-px">
                        {t('details.topRate')}
                      </span>
                    )}
                    {m.nestedInMap && (
                      <span className="ml-1.5 text-[10px] text-text-disabled" title={t('details.nested')}>↳</span>
                    )}
                  </td>
                  <td className="py-2 px-2.5 text-right tabular-nums">{isTown ? '—' : m.runs}</td>
                  <td className="py-2 px-2.5 text-right tabular-nums whitespace-nowrap">{formatSeconds(m.seconds)}</td>
                  <td className="py-2 px-2.5 text-right tabular-nums">{formatPct(m.timePct)}</td>
                  <td className={`py-2 px-2.5 text-right tabular-nums ${net < 0 ? 'text-danger' : 'text-success'}`}>
                    {formatFEFull(net)}
                  </td>
                  <td className="py-2 px-2.5 text-right tabular-nums">
                    {isTown ? '—' : formatPct(pick(m.valuePct, mode))}
                  </td>
                  <td className="py-2 px-2.5 text-right tabular-nums whitespace-nowrap">
                    <span className={rate < 0 ? 'text-danger' : isTop ? 'text-gold' : ''}>
                      {formatFEFull(rate)}
                    </span>
                    <i className="inline-block align-middle w-[54px] h-[5px] rounded-sm bg-border ml-2 overflow-hidden">
                      <span
                        className="block h-full bg-accent"
                        style={{width: `${bestRate > 0 ? Math.max(0, Math.min(100, (rate / bestRate) * 100)) : 0}%`}}
                      />
                    </i>
                  </td>
                  <td className="py-2 px-2.5 text-right tabular-nums">
                    {isTown ? '—' : formatFEFull(pick(m.avgPerRun, mode))}
                  </td>
                  <td className="py-2 px-2.5 text-right tabular-nums whitespace-nowrap">
                    {isTown ? '—' : formatSeconds(m.avgSeconds)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="font-bold">
              <td className="py-2.5 px-2.5 text-left border-t border-border">{t('details.sessionTotal')}</td>
              {/* mapCount, not the sum above: standalone seasonal runs are runs
                  but not maps, so the two legitimately differ. */}
              <td
                className="py-2.5 px-2.5 text-right tabular-nums border-t border-border whitespace-nowrap"
                title={t('details.mapsRun')}
              >
                {totals.mapCount}
                <span className="ml-1 font-normal text-[10px] text-text-disabled">
                  {t('details.mapsRun').toLowerCase()}
                </span>
              </td>
              <td className="py-2.5 px-2.5 text-right tabular-nums border-t border-border">{formatSeconds(totals.totalSeconds)}</td>
              <td className="py-2.5 px-2.5 text-right tabular-nums border-t border-border">100.0%</td>
              <td className={`py-2.5 px-2.5 text-right tabular-nums border-t border-border ${pick(totals.net, mode) < 0 ? 'text-danger' : 'text-success'}`}>
                {formatFEFull(pick(totals.net, mode))}
              </td>
              <td className="py-2.5 px-2.5 text-right tabular-nums border-t border-border">100.0%</td>
              <td className="py-2.5 px-2.5 text-right tabular-nums border-t border-border text-accent">
                {formatFEFull(pick(totals.netPerHour, mode))}
              </td>
              <td className="py-2.5 px-2.5 text-right border-t border-border" />
              <td className="py-2.5 px-2.5 text-right border-t border-border" />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

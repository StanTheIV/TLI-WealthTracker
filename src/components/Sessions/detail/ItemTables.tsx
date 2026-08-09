import {useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useTheme} from '@/theme/ThemeContext';
import type {ConsumedItemRow, DroppedItemRow, SessionAnalytics} from '../analytics';
import {typeColors} from './colors';
import {ColHeader, Pill} from './primitives';
import {formatFEFull, formatPct, pick, type ValueMode} from './format';

/** Rows shown before the table is expanded. */
const COLLAPSED_ROWS = 10;

type DropField = 'name' | 'qty' | 'unitPrice' | 'total' | 'pct' | 'perHour' | 'mapsPerDrop';
type CostField = 'name' | 'qty' | 'unitPrice' | 'total' | 'pct' | 'perMap' | 'runsUsing';

function useSort<F extends string>(initial: F) {
  const [field, setField] = useState<F>(initial);
  const [dir, setDir]     = useState<'asc' | 'desc'>('desc');
  const onSort = (f: F) => {
    if (f === field) setDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setField(f); setDir('desc'); }
  };
  return {field, dir, onSort};
}

function ExpandToggle({total, expanded, onToggle}: {total: number; expanded: boolean; onToggle: () => void}) {
  const {t} = useTranslation('sessions');
  if (total <= COLLAPSED_ROWS) return null;
  return (
    <button
      onClick={onToggle}
      className="w-full pt-3 text-center text-xs text-accent hover:opacity-80 transition-opacity"
    >
      {expanded ? t('details.showLess') : t('details.showAll', {count: total})}
    </button>
  );
}

export function DroppedTable({analytics, mode, showBoth}: {
  analytics: SessionAnalytics;
  mode:      ValueMode;
  showBoth:  boolean;
}) {
  const {t}   = useTranslation('sessions');
  const theme = useTheme();
  const colors = typeColors(theme);
  const {field, dir, onSort} = useSort<DropField>('total');
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(() => {
    // With both legs shown, the price columns render the snapshot leg — sort by
    // what is on screen, or the column looks unsorted.
    const shown: ValueMode = showBoth ? 'snapshot' : mode;
    const value = (r: DroppedItemRow): number | string => {
      switch (field) {
        case 'name':        return r.name;
        case 'qty':         return r.qty;
        case 'unitPrice':   return pick(r.unitPrice, shown);
        case 'pct':         return pick(r.pct, mode);
        case 'perHour':     return pick(r.perHour, mode);
        case 'mapsPerDrop': return r.mapsPerDrop ?? Number.POSITIVE_INFINITY;
        default:            return pick(r.total, shown);
      }
    };
    return [...analytics.dropped].sort((a, b) => {
      const av = value(a); const bv = value(b);
      const cmp = typeof av === 'string' ? av.localeCompare(String(bv)) : (av as number) - (bv as number);
      return dir === 'asc' ? cmp : -cmp;
    });
  }, [analytics.dropped, field, dir, mode, showBoth]);

  if (rows.length === 0) {
    return <p className="text-xs text-text-disabled py-8 text-center">{t('details.droppedEmpty')}</p>;
  }

  const visible = expanded ? rows : rows.slice(0, COLLAPSED_ROWS);

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr>
              <th className="pb-2 px-2.5 border-b border-border">
                <ColHeader label={t('details.item')} field="name" sortField={field} sortDir={dir} onSort={onSort} align="left" />
              </th>
              <th className="pb-2 px-2.5 border-b border-border text-right text-[10px] font-semibold uppercase tracking-widest text-text-disabled">
                {t('details.type')}
              </th>
              <th className="pb-2 px-2.5 border-b border-border">
                <ColHeader label={t('details.qty')} field="qty" sortField={field} sortDir={dir} onSort={onSort} />
              </th>
              <th className="pb-2 px-2.5 border-b border-border">
                <ColHeader label={showBoth ? t('details.unitAtSave') : t('details.unitPrice')} field="unitPrice" sortField={field} sortDir={dir} onSort={onSort} />
              </th>
              <th className="pb-2 px-2.5 border-b border-border">
                <ColHeader label={showBoth ? t('details.atSave') : t('details.totalFEShort')} field="total" sortField={field} sortDir={dir} onSort={onSort} />
              </th>
              {showBoth && (
                <th className="pb-2 px-2.5 border-b border-border text-right text-[10px] font-semibold uppercase tracking-widest text-text-disabled">
                  {t('details.now')}
                </th>
              )}
              <th className="pb-2 px-2.5 border-b border-border">
                <ColHeader label={t('details.pctValue')} field="pct" sortField={field} sortDir={dir} onSort={onSort} />
              </th>
              <th className="pb-2 px-2.5 border-b border-border">
                <ColHeader label={t('details.perHour')} field="perHour" sortField={field} sortDir={dir} onSort={onSort} />
              </th>
              <th className="pb-2 px-2.5 border-b border-border">
                <ColHeader label={t('details.mapsPerDrop')} field="mapsPerDrop" sortField={field} sortDir={dir} onSort={onSort} />
              </th>
              <th className="pb-2 px-2.5 border-b border-border text-right text-[10px] font-semibold uppercase tracking-widest text-text-disabled">
                {t('details.topSource')}
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map(r => (
              <tr key={r.itemId} className="border-b border-border/50 hover:bg-accent/5 transition-colors">
                <td className={`py-2 px-2.5 text-left ${r.known ? '' : 'text-text-disabled italic'}`}>{r.name}</td>
                <td className="py-2 px-2.5 text-right">
                  <Pill color={colors[r.type]}>{r.type}</Pill>
                </td>
                <td className={`py-2 px-2.5 text-right tabular-nums ${r.qty < 0 ? 'text-danger' : ''}`}>
                  {r.qty.toLocaleString()}
                </td>
                <td className="py-2 px-2.5 text-right tabular-nums text-text-secondary">
                  {formatFEFull(showBoth ? r.unitPrice.snapshot : pick(r.unitPrice, mode))}
                </td>
                <td className={`py-2 px-2.5 text-right tabular-nums ${r.total.live < 0 ? 'text-danger' : 'text-gold'}`}>
                  {formatFEFull(showBoth ? r.total.snapshot : pick(r.total, mode))}
                </td>
                {showBoth && <DriftCell row={r} />}
                <td className="py-2 px-2.5 text-right tabular-nums">{formatPct(pick(r.pct, mode))}</td>
                <td className="py-2 px-2.5 text-right tabular-nums">{formatFEFull(pick(r.perHour, mode))}</td>
                <td className="py-2 px-2.5 text-right tabular-nums">
                  {r.mapsPerDrop === null ? '—' : r.mapsPerDrop < 0.1 ? '<0.1' : r.mapsPerDrop.toFixed(1)}
                </td>
                <td className="py-2 px-2.5 text-right text-text-secondary">
                  {r.topSource ? t(`details.source.${r.topSource}` as never) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ExpandToggle total={rows.length} expanded={expanded} onToggle={() => setExpanded(e => !e)} />
    </>
  );
}

/** Live value plus its change from the frozen price. Items with no snapshot
 *  price show the value but no drift — their snapshot leg is the live price. */
function DriftCell({row}: {row: DroppedItemRow}) {
  const delta = row.total.snapshot === 0 || row.snapshotMissing
    ? null
    : ((row.total.live - row.total.snapshot) / row.total.snapshot) * 100;

  return (
    <td className="py-2 px-2.5 text-right tabular-nums whitespace-nowrap">
      <span className={row.total.live < 0 ? 'text-danger' : ''}>{formatFEFull(row.total.live)}</span>
      {delta !== null && Math.abs(delta) >= 0.05 && (
        <span className={`ml-1.5 text-[10px] ${delta >= 0 ? 'text-success' : 'text-danger'}`}>
          {delta >= 0 ? '+' : ''}{delta.toFixed(1)}%
        </span>
      )}
    </td>
  );
}

export function ConsumedTable({analytics, mode, showBoth}: {
  analytics: SessionAnalytics;
  mode:      ValueMode;
  showBoth:  boolean;
}) {
  const {t}   = useTranslation('sessions');
  const theme = useTheme();
  const colors = typeColors(theme);
  const {field, dir, onSort} = useSort<CostField>('total');
  const [expanded, setExpanded] = useState(false);

  const rows = useMemo(() => {
    const shown: ValueMode = showBoth ? 'snapshot' : mode;
    const value = (r: ConsumedItemRow): number | string => {
      switch (field) {
        case 'name':      return r.name;
        case 'qty':       return r.qty;
        case 'unitPrice': return pick(r.unitPrice, shown);
        case 'pct':       return pick(r.pct, mode);
        case 'perMap':    return r.perMap ?? 0;
        case 'runsUsing': return r.runsUsing;
        default:          return pick(r.total, mode);
      }
    };
    return [...analytics.consumed].sort((a, b) => {
      const av = value(a); const bv = value(b);
      const cmp = typeof av === 'string' ? av.localeCompare(String(bv)) : (av as number) - (bv as number);
      return dir === 'asc' ? cmp : -cmp;
    });
  }, [analytics.consumed, field, dir, mode, showBoth]);

  if (rows.length === 0) {
    return <p className="text-xs text-text-disabled py-8 text-center">{t('details.consumedEmpty')}</p>;
  }

  const visible = expanded ? rows : rows.slice(0, COLLAPSED_ROWS);

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr>
              <th className="pb-2 px-2.5 border-b border-border">
                <ColHeader label={t('details.material')} field="name" sortField={field} sortDir={dir} onSort={onSort} align="left" />
              </th>
              <th className="pb-2 px-2.5 border-b border-border text-right text-[10px] font-semibold uppercase tracking-widest text-text-disabled">
                {t('details.type')}
              </th>
              <th className="pb-2 px-2.5 border-b border-border">
                <ColHeader label={t('details.qty')} field="qty" sortField={field} sortDir={dir} onSort={onSort} />
              </th>
              <th className="pb-2 px-2.5 border-b border-border">
                <ColHeader label={showBoth ? t('details.unitAtSave') : t('details.unitPrice')} field="unitPrice" sortField={field} sortDir={dir} onSort={onSort} />
              </th>
              <th className="pb-2 px-2.5 border-b border-border">
                <ColHeader label={t('details.cost')} field="total" sortField={field} sortDir={dir} onSort={onSort} />
              </th>
              <th className="pb-2 px-2.5 border-b border-border">
                <ColHeader label={t('details.pctCost')} field="pct" sortField={field} sortDir={dir} onSort={onSort} />
              </th>
              <th className="pb-2 px-2.5 border-b border-border">
                <ColHeader label={t('details.perMapCol')} field="perMap" sortField={field} sortDir={dir} onSort={onSort} />
              </th>
              <th className="pb-2 px-2.5 border-b border-border">
                <ColHeader label={t('details.runsUsing')} field="runsUsing" sortField={field} sortDir={dir} onSort={onSort} />
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map(r => (
              <tr key={r.itemId} className="border-b border-border/50 hover:bg-accent/5 transition-colors">
                <td className={`py-2 px-2.5 text-left ${r.known ? '' : 'text-text-disabled italic'}`}>{r.name}</td>
                <td className="py-2 px-2.5 text-right">
                  <Pill color={colors[r.type]}>{r.type}</Pill>
                </td>
                <td className="py-2 px-2.5 text-right tabular-nums">{r.qty.toLocaleString()}</td>
                <td className="py-2 px-2.5 text-right tabular-nums text-text-secondary">
                  {formatFEFull(showBoth ? r.unitPrice.snapshot : pick(r.unitPrice, mode))}
                </td>
                <td className="py-2 px-2.5 text-right tabular-nums text-danger">
                  {formatFEFull(pick(r.total, mode))}
                </td>
                <td className="py-2 px-2.5 text-right tabular-nums">{formatPct(pick(r.pct, mode))}</td>
                <td className="py-2 px-2.5 text-right tabular-nums">
                  {r.perMap === null ? '—' : r.perMap.toFixed(2)}
                </td>
                <td className="py-2 px-2.5 text-right tabular-nums text-text-secondary">{r.runsUsing}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ExpandToggle total={rows.length} expanded={expanded} onToggle={() => setExpanded(e => !e)} />
    </>
  );
}

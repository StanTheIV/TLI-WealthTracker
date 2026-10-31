import {useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ChevronUp, ChevronDown, ArrowUpRight} from 'lucide-react';
import {useWealthStore} from '@/state/wealthStore';
import {useItemsStore} from '@/state/itemsStore';
import {formatDateTime, formatFEFull} from '@/lib/format';
import {breakdownChipTypes, keepShownChips} from './breakdownChips';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BreakdownRow {
  id:        string;
  name:      string;
  type:      string;
  qty:       number;
  unitPrice: number;
  total:     number;
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

type SortKey = 'name' | 'type' | 'qty' | 'unitPrice' | 'total';
type SortDir = 'asc' | 'desc';

function sortRows(rows: BreakdownRow[], key: SortKey, dir: SortDir): BreakdownRow[] {
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const cmp = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ---------------------------------------------------------------------------
// Filter button
// ---------------------------------------------------------------------------

function FilterButton({label, active, onClick}: {label: string; active: boolean; onClick: () => void}) {
  return (
    <button
      onClick={onClick}
      className={[
        'text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors',
        active
          ? 'bg-accent/20 text-accent'
          : 'bg-surface-elevated text-text-secondary hover:text-text-primary',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ItemBreakdownProps {
  onRequestItemFocus: (id: string) => void;
}

export default function ItemBreakdown({onRequestItemFocus}: ItemBreakdownProps) {
  const {t}               = useTranslation('dashboard');
  const {t: tItems}       = useTranslation('items');
  const latest            = useWealthStore(s => s.latest);
  const items             = useItemsStore(s => s.items);
  const [filters, setFilters] = useState<ReadonlySet<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const latestTimestamp   = latest?.ts ?? null;

  // Main's rows are already filtered and taxed; only the display name and the
  // type the chips match on come from the items table.
  const rows = useMemo<BreakdownRow[]>(() => (latest?.rows ?? []).map(row => {
    const item = items[row.id];
    return {
      ...row,
      name: item?.name || `#${row.id}`,
      type: item?.type ?? '',
    };
  }), [latest, items]);

  // A selected chip whose type vanished is dropped during render, never filtered on.
  const chipTypes = useMemo(() => breakdownChipTypes(rows.map(r => r.type)), [rows]);
  const selection = keepShownChips(filters, chipTypes);
  if (selection !== filters) setFilters(selection);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  function toggleFilter(type: string) {
    setFilters(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }

  const filtered   = sortRows(selection.size > 0 ? rows.filter(r => selection.has(r.type)) : rows, sortKey, sortDir);
  const grandTotal = filtered.reduce((sum, r) => sum + r.total, 0);

  return (
    <div className="flex flex-col gap-3 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
          {t('breakdown.title')}
        </h2>
        <div className="flex items-center gap-3">
          {rows.length > 0 && (
            <span className="font-mono text-sm font-bold text-gold tabular-nums">
              {formatFEFull(grandTotal, {unit: true})}
            </span>
          )}
          {latestTimestamp !== null && (
            <span className="text-[11px] text-text-disabled">
              {t('breakdown.lastUpdated')}: {formatDateTime(latestTimestamp)}
            </span>
          )}
        </div>
      </div>

      {/* Filter bar */}
      {rows.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <FilterButton
            label={t('breakdown.filterAll')}
            active={selection.size === 0}
            onClick={() => setFilters(new Set())}
          />
          {chipTypes.map(type => (
            <FilterButton
              key={type}
              label={tItems(`types.${type}` as never)}
              active={selection.has(type)}
              onClick={() => toggleFilter(type)}
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {rows.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-xs text-text-disabled">
          {t('breakdown.empty')}
        </div>
      ) : (
        <div className="flex flex-col min-h-0">
          {/* Table header — stays fixed */}
          <div className="flex items-center gap-2 px-1 pb-1.5 border-b border-border shrink-0">
            {([ ['name', t('breakdown.name'), 'flex-1 text-left'], ['type', t('breakdown.type'), 'w-36 shrink-0 hidden sm:flex text-left'], ['qty', t('breakdown.qty'), 'w-10 shrink-0 text-right'], ['unitPrice', t('breakdown.price'), 'w-20 shrink-0 text-right'], ['total', t('breakdown.total'), 'w-24 shrink-0 text-right'] ] as [SortKey, string, string][]).map(([key, label, cls]) => (
              <button
                key={key}
                onClick={() => toggleSort(key)}
                className={`flex items-center gap-0.5 text-[11px] font-semibold uppercase tracking-widest whitespace-nowrap transition-colors ${cls} ${sortKey === key ? 'text-accent' : 'text-text-disabled hover:text-text-secondary'} ${key === 'qty' || key === 'unitPrice' || key === 'total' ? 'justify-end' : ''}`}
              >
                {label}
                {sortKey === key
                  ? (sortDir === 'asc' ? <ChevronUp className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />)
                  : <ChevronDown className="w-3 h-3 shrink-0 opacity-0" />}
              </button>
            ))}
          </div>

          {/* Rows — scrollable */}
          <div className="overflow-y-auto min-h-0 space-y-0.5 pt-1">
            {filtered.map(row => (
              <div key={row.id} className="group flex items-center gap-2 px-1 py-0.5 rounded hover:bg-white/3">
                <span className="text-sm truncate flex-1 flex items-center gap-1 min-w-0">
                  <span className="truncate">
                    {row.name.startsWith('#')
                      ? <span className="text-text-disabled italic">{row.name}</span>
                      : <span className="text-text-primary">{row.name}</span>}
                  </span>
                  <button
                    onClick={() => onRequestItemFocus(row.id)}
                    title={t('breakdown.openInItems')}
                    className="shrink-0 p-0.5 rounded text-text-disabled opacity-0 group-hover:opacity-100 hover:text-accent transition-opacity"
                  >
                    <ArrowUpRight className="w-3 h-3" />
                  </button>
                </span>
                <span className="text-xs text-text-disabled w-36 shrink-0 truncate hidden sm:block">{tItems(`types.${row.type}` as never)}</span>
                <span className="font-mono text-xs text-text-secondary w-10 text-right shrink-0 tabular-nums">
                  {row.qty.toLocaleString()}
                </span>
                <span className="font-mono text-xs text-text-secondary w-20 text-right shrink-0 tabular-nums">
                  {formatFEFull(row.unitPrice)}
                </span>
                <span className="font-mono text-xs text-gold w-24 text-right shrink-0 tabular-nums">
                  {formatFEFull(row.total)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

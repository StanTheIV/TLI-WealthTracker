import {useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ChevronUp, ChevronDown} from 'lucide-react';
import {useWealthStore} from '@/state/wealthStore';
import {useItemsStore} from '@/state/itemsStore';
import {ITEM_TYPES} from '@/types/itemType';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFE(value: number): string {
  return value.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts));
}

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

export default function ItemBreakdown() {
  const {t}               = useTranslation('dashboard');
  const {t: tItems}       = useTranslation('items');
  const latestBreakdown   = useWealthStore(s => s.latestBreakdown);
  const latestTimestamp   = useWealthStore(s => s.latestTimestamp);
  const items             = useItemsStore(s => s.items);
  const [filters, setFilters] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const rows = useMemo(() => {
    return Object.entries(latestBreakdown)
      .map(([id, entry]) => {
        const item = items[id];
        return {
          id,
          name:      item?.name || `#${id}`,
          type:      item?.type  ?? '',
          qty:       entry.qty,
          unitPrice: entry.price,
          total:     entry.total,
        };
      })
      .filter(r => r.qty > 0);
  }, [latestBreakdown, items]);

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

  const filtered   = sortRows(filters.size > 0 ? rows.filter(r => filters.has(r.type)) : rows, sortKey, sortDir);
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
              {formatFE(grandTotal)} FE
            </span>
          )}
          {latestTimestamp !== null && (
            <span className="text-[11px] text-text-disabled">
              {t('breakdown.lastUpdated')}: {formatDate(latestTimestamp)}
            </span>
          )}
        </div>
      </div>

      {/* Filter bar */}
      {rows.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <FilterButton
            label={t('breakdown.filterAll')}
            active={filters.size === 0}
            onClick={() => setFilters(new Set())}
          />
          {ITEM_TYPES.filter(type => type !== 'other').map(type => (
            <FilterButton
              key={type}
              label={tItems(`types.${type}` as never)}
              active={filters.has(type)}
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
              <div key={row.id} className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-white/3">
                <span className="text-sm truncate flex-1">
                  {row.name.startsWith('#')
                    ? <span className="text-text-disabled italic">{row.name}</span>
                    : <span className="text-text-primary">{row.name}</span>}
                </span>
                <span className="text-xs text-text-disabled w-36 shrink-0 truncate hidden sm:block">{tItems(`types.${row.type}` as never)}</span>
                <span className="font-mono text-xs text-text-secondary w-10 text-right shrink-0 tabular-nums">
                  {row.qty.toLocaleString()}
                </span>
                <span className="font-mono text-xs text-text-secondary w-20 text-right shrink-0 tabular-nums">
                  {formatFE(row.unitPrice)}
                </span>
                <span className="font-mono text-xs text-gold w-24 text-right shrink-0 tabular-nums">
                  {formatFE(row.total)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

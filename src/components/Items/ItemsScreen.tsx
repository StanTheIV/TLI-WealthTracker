import {useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Search} from 'lucide-react';
import {useItemsStore} from '@/state/itemsStore';
import ItemsTable from './ItemsTable';

// ---------------------------------------------------------------------------
// Filter pill
// ---------------------------------------------------------------------------

function FilterButton({label, count, active, onClick}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors',
        active
          ? 'bg-accent/20 text-accent'
          : 'bg-surface-elevated text-text-secondary hover:text-text-primary',
      ].join(' ')}
    >
      {label}
      {count !== undefined && (
        <span className={[
          'text-[9px] font-bold px-1 py-px rounded-full',
          active ? 'bg-accent/30' : 'bg-white/10',
        ].join(' ')}>
          {count}
        </span>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type Filter = 'all' | 'unknown' | 'noPrice';

export default function ItemsScreen() {
  const {t}           = useTranslation('items');
  const items         = useItemsStore(s => s.items);
  const lookupsToday  = useItemsStore(s => s.lookupsToday);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const {rows, unknownCount, noPriceCount} = useMemo(() => {
    const all = Object.values(items);
    const unknownCount = all.filter(i => !i.name || i.name === i.id).length;
    const noPriceCount = all.filter(i => i.price === 0).length;
    return {rows: all, unknownCount, noPriceCount};
  }, [items]);

  const filtered = useMemo(() => {
    let result = rows;
    if (filter === 'unknown') result = result.filter(i => !i.name || i.name === i.id);
    if (filter === 'noPrice') result = result.filter(i => i.price === 0);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(i => i.id.includes(q) || i.name.toLowerCase().includes(q));
    }
    return result;
  }, [rows, filter, search]);

  return (
    <div className="flex flex-col h-full p-6 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <h1 className="text-2xl font-bold text-text-primary">{t('title')}</h1>
        <div className="flex items-center gap-3">
          <span className={[
            'text-xs tabular-nums',
            lookupsToday >= 500 ? 'text-red-400' : lookupsToday >= 450 ? 'text-yellow-400' : 'text-text-disabled',
          ].join(' ')}>
            {t('lookup.counter', {used: lookupsToday, max: 500})}
          </span>
          <span className="text-xs text-text-disabled">{rows.length} items</span>
        </div>
      </div>

      {/* Filter bar + search */}
      <div className="flex items-center gap-2 mb-4 shrink-0">
        <div className="flex flex-wrap gap-1.5">
          <FilterButton
            label={t('filters.all')}
            active={filter === 'all'}
            onClick={() => setFilter('all')}
          />
          <FilterButton
            label={t('filters.unknown')}
            count={unknownCount}
            active={filter === 'unknown'}
            onClick={() => setFilter('unknown')}
          />
          <FilterButton
            label={t('filters.noPrice')}
            count={noPriceCount}
            active={filter === 'noPrice'}
            onClick={() => setFilter('noPrice')}
          />
        </div>

        <div className="relative ml-auto">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-disabled pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search ID or name…"
            className="bg-surface-elevated border border-border rounded-full pl-6 pr-3 py-1 text-[11px] text-text-primary placeholder:text-text-disabled outline-none focus:border-accent/50 transition-colors w-48"
          />
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-xs text-text-disabled">
            {t('empty')}
          </div>
        ) : (
          <ItemsTable rows={filtered} />
        )}
      </div>
    </div>
  );
}

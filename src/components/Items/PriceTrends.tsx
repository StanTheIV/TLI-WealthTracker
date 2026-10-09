import {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {Download, Search} from 'lucide-react';
import type {PriceMover} from '@/types/electron';
import {useLeaguesStore} from '@/state/leaguesStore';
import {defaultPreset, resolvePriceRange, type PricePreset} from '@/lib/priceRange';
import {formatPrice, toCsv} from '@/lib/priceChart';
import PriceRangeControl from './PriceRangeControl';
import PriceHistoryModal from './PriceHistoryModal';

type SortField = 'name' | 'first' | 'last' | 'min' | 'max' | 'count' | 'pctChange';
type SortDir   = 'asc' | 'desc';

const COLUMNS: {field: SortField; width: string; numeric: boolean}[] = [
  {field: 'name',      width: 'flex-1 min-w-0', numeric: false},
  {field: 'first',     width: 'w-20 shrink-0',  numeric: true},
  {field: 'last',      width: 'w-20 shrink-0',  numeric: true},
  {field: 'min',       width: 'w-20 shrink-0',  numeric: true},
  {field: 'max',       width: 'w-20 shrink-0',  numeric: true},
  {field: 'count',     width: 'w-14 shrink-0',  numeric: true},
  {field: 'pctChange', width: 'w-20 shrink-0',  numeric: true},
];

function sortMovers(rows: PriceMover[], field: SortField, dir: SortDir): PriceMover[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (field === 'name') return sign * a.name.localeCompare(b.name);
    if (field === 'pctChange') {
      // Default view ranks by magnitude; rows without a % change (first = 0) sink.
      const av = a.pctChange === null ? null : Math.abs(a.pctChange);
      const bv = b.pctChange === null ? null : Math.abs(b.pctChange);
      if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1;
      return sign * (av - bv);
    }
    return sign * (a[field] - b[field]);
  });
}

function formatPct(p: number | null): string {
  if (p === null) return '—';
  return p.toLocaleString(undefined, {style: 'percent', signDisplay: 'exceptZero', maximumFractionDigits: 1});
}

export default function PriceTrends() {
  const {t}    = useTranslation('items');
  const ranges = useLeaguesStore(s => s.ranges);

  const [preset, setPreset]     = useState<PricePreset>(() => defaultPreset(ranges, Date.now()));
  const [movers, setMovers]     = useState<PriceMover[] | null>(null);
  const [search, setSearch]     = useState('');
  const [showSingle, setSingle] = useState(false);
  const [sortField, setField]   = useState<SortField>('pctChange');
  const [sortDir, setDir]       = useState<SortDir>('desc');
  const [selected, setSelected] = useState<PriceMover | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const range = resolvePriceRange(preset, ranges, Date.now()) ?? resolvePriceRange('all', ranges, Date.now())!;
    setMovers(null);
    void window.electronAPI.db.prices.movers(range.from, range.to).then(m => {
      if (!cancelled) setMovers(m);
    });
    return () => { cancelled = true; };
  }, [preset, ranges]);

  const rows = useMemo(() => {
    if (!movers) return [];
    const q = search.trim().toLowerCase();
    const visible = movers.filter(m =>
      (showSingle || m.count >= 2) && (!q || m.itemId.includes(q) || m.name.toLowerCase().includes(q)),
    );
    return sortMovers(visible, sortField, sortDir);
  }, [movers, search, showSingle, sortField, sortDir]);

  function handleSort(field: SortField) {
    if (field === sortField) setDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setField(field); setDir(field === 'name' ? 'asc' : 'desc'); }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const range = resolvePriceRange(preset, ranges, Date.now()) ?? resolvePriceRange('all', ranges, Date.now())!;
      const data  = await window.electronAPI.db.prices.export(range.from, range.to);
      const blob  = new Blob([toCsv(data)], {type: 'text/csv;charset=utf-8'});
      const url   = URL.createObjectURL(blob);
      const a     = document.createElement('a');
      a.href      = url;
      a.download  = `price-history-${preset}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex flex-wrap items-center gap-3 mb-4 shrink-0">
        <PriceRangeControl value={preset} onChange={setPreset} />
        <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer">
          <input type="checkbox" checked={showSingle} onChange={e => setSingle(e.target.checked)} className="accent-accent" />
          {t('trends.showSingle')}
        </label>
        <div className="flex items-center gap-2 ml-auto">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-disabled pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={t('search.placeholder')}
              className="bg-surface-elevated border border-border rounded-full pl-6 pr-3 py-1 text-[11px] text-text-primary placeholder:text-text-disabled outline-none focus:border-accent/50 transition-colors w-48"
            />
          </div>
          <button
            onClick={handleExport}
            disabled={exporting}
            className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-surface-elevated text-text-secondary hover:text-accent disabled:opacity-40 transition-colors"
          >
            <Download className="w-3 h-3" />
            {t('trends.exportCsv')}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {movers === null ? (
          <div className="flex items-center justify-center py-8 text-xs text-text-disabled">{t('history.loading')}</div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-xs text-text-disabled">{t('trends.empty')}</div>
        ) : (
          <div className="w-full">
            <div className="flex items-center gap-2 px-1 pb-1.5 border-b border-border">
              {COLUMNS.map(c => (
                <div key={c.field} className={[c.width, c.numeric ? 'text-right' : ''].join(' ')}>
                  <button
                    onClick={() => handleSort(c.field)}
                    className="text-[11px] font-semibold uppercase tracking-widest text-text-disabled hover:text-text-secondary transition-colors"
                  >
                    {t(`trends.columns.${c.field}`)}
                    {sortField === c.field && <span className="text-[9px] ml-0.5">{sortDir === 'asc' ? '▲' : '▼'}</span>}
                  </button>
                </div>
              ))}
            </div>
            <div className="space-y-0.5 pt-1">
              {rows.map(m => (
                <button
                  key={m.itemId}
                  onClick={() => setSelected(m)}
                  className="w-full flex items-center gap-2 px-1 py-0.5 rounded text-left hover:bg-white/3 transition-colors"
                >
                  <span className="flex-1 min-w-0 text-sm text-text-primary truncate">
                    {m.name || <span className="text-text-disabled italic">#{m.itemId}</span>}
                  </span>
                  {[m.first, m.last, m.min, m.max].map((v, i) => (
                    <span key={i} className="w-20 shrink-0 text-right font-mono text-xs tabular-nums text-text-secondary">
                      {formatPrice(v)}
                    </span>
                  ))}
                  <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-text-disabled">{m.count}</span>
                  <span className={[
                    'w-20 shrink-0 text-right font-mono text-xs tabular-nums',
                    m.pctChange === null || m.pctChange === 0 ? 'text-text-disabled'
                      : m.pctChange > 0 ? 'text-success' : 'text-danger',
                  ].join(' ')}>
                    {formatPct(m.pctChange)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {selected && (
        <PriceHistoryModal itemId={selected.itemId} name={selected.name} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

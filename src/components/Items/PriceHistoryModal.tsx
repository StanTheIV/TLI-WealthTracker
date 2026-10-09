import {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {X} from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import type {PriceBucket} from '@/main/prices/history';
import {useLeaguesStore} from '@/state/leaguesStore';
import {useTheme} from '@/theme/ThemeContext';
import {defaultPreset, resolvePriceRange, type PricePreset} from '@/lib/priceRange';
import {buildChartRows, formatPrice, type ChartRow} from '@/lib/priceChart';
import PriceRangeControl from './PriceRangeControl';

const DAY_MS = 24 * 3_600_000;

function tickFormatterFor(span: number): (ts: number) => string {
  const opts: Intl.DateTimeFormatOptions =
    span <= 2 * DAY_MS     ? {hour: '2-digit', minute: '2-digit'}
    : span <= 120 * DAY_MS ? {month: 'short', day: 'numeric'}
    :                        {month: 'short', year: '2-digit'};
  const fmt = new Intl.DateTimeFormat(undefined, opts);
  return ts => fmt.format(new Date(ts));
}

const fullDate = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function CustomTooltip({active, payload}: {active?: boolean; payload?: {payload?: ChartRow}[]}) {
  const {t} = useTranslation('items');
  const row = payload?.[0]?.payload;
  if (!active || !row || row.gap || row.median === null) return null;
  const range = (lo: number | null, hi: number | null) =>
    lo !== null && hi !== null ? `${formatPrice(lo)} – ${formatPrice(hi)}` : '—';
  return (
    <div className="bg-surface border border-border rounded px-3 py-2 text-xs shadow-lg space-y-0.5">
      <p className="text-text-secondary mb-1">{fullDate.format(new Date(row.t))}</p>
      <p className="font-mono font-semibold text-gold">{t('history.median')}: {formatPrice(row.median)} FE</p>
      {/* Backfill/manual-only points have no order book: skip the empty band lines. */}
      {row.n > 0 && (
        <>
          <p className="font-mono text-text-secondary">{t('history.iqr')}: {range(row.p25, row.p75)}</p>
          <p className="font-mono text-text-secondary">{t('history.p1090')}: {range(row.p10, row.p90)}</p>
          <p className="text-text-disabled">
            {t('history.listings', {count: row.n})} · {t('history.searches', {count: row.searches})}
          </p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

interface Props {
  itemId:  string;
  name:    string;
  onClose: () => void;
}

export default function PriceHistoryModal({itemId, name, onClose}: Props) {
  const {t}    = useTranslation('items');
  const theme  = useTheme();
  const ranges = useLeaguesStore(s => s.ranges);

  const [preset, setPreset]   = useState<PricePreset>(() => defaultPreset(ranges, Date.now()));
  const [log, setLog]         = useState(false);
  const [outer, setOuter]     = useState(false);
  const [buckets, setBuckets] = useState<PriceBucket[] | null>(null);

  // Resolved per preset change so the fetch and the axis domain agree.
  const range = useMemo(
    () => resolvePriceRange(preset, ranges, Date.now()) ?? resolvePriceRange('all', ranges, Date.now())!,
    [preset, ranges],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setBuckets(null);
    void window.electronAPI.db.prices.history(itemId, range.from, range.to).then(b => {
      if (!cancelled) setBuckets(b);
    });
    return () => { cancelled = true; };
  }, [itemId, range]);

  const rows   = useMemo(
    () => (buckets ? buildChartRows(buckets, ranges, range.from, range.to, log) : []),
    [buckets, ranges, range, log],
  );
  const hasData = rows.some(r => !r.gap);

  // 'all' starts at epoch 0, so fit the axis to the data instead.
  const isAll = preset === 'all';
  const times = rows.map(r => r.t);
  const first = times.length ? Math.min(...times) : range.to;
  const domain: [number | 'dataMin', number | 'dataMax'] = isAll ? ['dataMin', 'dataMax'] : [range.from, range.to];
  const tick  = tickFormatterFor(range.to - (isAll ? first : range.from));
  const leagueStarts = ranges.filter(r => r.from > (isAll ? first : range.from) && r.from < range.to);

  const axisTick = {fill: theme.textDisabled, fontSize: 11};

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-4xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-text-primary truncate">
              {t('history.title', {name: name || `#${itemId}`})}
            </h2>
            <p className="text-xs text-text-disabled font-mono">#{itemId}</p>
          </div>
          <button onClick={onClose} className="text-text-disabled hover:text-text-primary transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <PriceRangeControl value={preset} onChange={setPreset} />
            <div className="flex items-center gap-4 text-xs text-text-secondary">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={outer} onChange={e => setOuter(e.target.checked)} className="accent-accent" />
                {t('history.showOuter')}
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={log} onChange={e => setLog(e.target.checked)} className="accent-accent" />
                {t('history.logScale')}
              </label>
            </div>
          </div>

          {buckets === null ? (
            <div className="flex items-center justify-center h-80 text-xs text-text-disabled">{t('history.loading')}</div>
          ) : !hasData ? (
            <div className="flex items-center justify-center h-80 rounded-lg border border-border text-xs text-text-disabled">
              {t('history.empty')}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={rows} margin={{top: 8, right: 8, bottom: 0, left: 0}}>
                <CartesianGrid strokeDasharray="3 3" stroke={theme.border} vertical={false} />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={domain}
                  tickFormatter={tick}
                  tick={axisTick}
                  axisLine={{stroke: theme.border}}
                  tickLine={false}
                  minTickGap={60}
                />
                <YAxis
                  scale={log ? 'log' : 'linear'}
                  domain={log ? ['auto', 'auto'] : [0, 'auto']}
                  allowDataOverflow={log}
                  tickFormatter={formatPrice}
                  tick={axisTick}
                  axisLine={false}
                  tickLine={false}
                  width={56}
                />
                <Tooltip content={<CustomTooltip />} />
                {leagueStarts.map(r => (
                  <ReferenceLine
                    key={r.id}
                    x={r.from}
                    stroke={theme.textDisabled}
                    strokeDasharray="4 4"
                    label={{value: r.name, position: 'insideTopLeft', fill: theme.textSecondary, fontSize: 10}}
                  />
                ))}
                {outer && (
                  <Area
                    dataKey="outer"
                    type="monotone"
                    stroke="none"
                    fill={theme.accent}
                    fillOpacity={0.1}
                    isAnimationActive={false}
                    activeDot={false}
                    legendType="none"
                  />
                )}
                <Area
                  dataKey="iqr"
                  type="monotone"
                  stroke="none"
                  fill={theme.accent}
                  fillOpacity={0.25}
                  isAnimationActive={false}
                  activeDot={false}
                  legendType="none"
                />
                <Line
                  dataKey="median"
                  type="monotone"
                  stroke={theme.gold}
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                  activeDot={{r: 4, fill: theme.gold, stroke: theme.surface, strokeWidth: 2}}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}

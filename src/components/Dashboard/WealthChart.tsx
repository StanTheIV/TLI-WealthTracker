import {useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts';
import {useWealthStore, type WealthRange} from '@/state/wealthStore';
import {useTheme} from '@/theme/ThemeContext';
import SegmentedControl from '@/components/ui/SegmentedControl';

const RANGE_OPTIONS: WealthRange[] = ['1d', '3d', '7d', '1m', 'all'];

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'}).format(new Date(ts));
}

function formatHour(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {hour: '2-digit', minute: '2-digit'}).format(new Date(ts));
}

function formatDayHour(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {weekday: 'short', hour: '2-digit'}).format(new Date(ts));
}

function tickFormatterFor(range: WealthRange): (ts: number) => string {
  if (range === '1d') return formatHour;
  if (range === '3d') return formatDayHour;
  return formatDate;
}

function formatDateFull(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts));
}

function formatFE(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000)     return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

// ---------------------------------------------------------------------------
// Custom tooltip
// ---------------------------------------------------------------------------

interface TooltipEntry {
  value?: number;
  payload?: {time: number; value: number};
}

function CustomTooltip({active, payload}: {active?: boolean; payload?: TooltipEntry[]}) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  if (!entry.payload) return null;
  return (
    <div className="bg-surface border border-border rounded px-3 py-2 text-xs shadow-lg">
      <p className="text-text-secondary mb-1">{formatDateFull(entry.payload.time)}</p>
      <p className="font-mono font-semibold text-gold">{(entry.value ?? 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} FE</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WealthChart() {
  const {t}         = useTranslation('dashboard');
  const theme       = useTheme();
  const datapoints  = useWealthStore(s => s.datapoints);
  const range       = useWealthStore(s => s.range);
  const setRange    = useWealthStore(s => s.setRange);

  const data = useMemo(
    () => datapoints.map(dp => ({time: dp.timestamp, value: dp.value})),
    [datapoints],
  );

  const rangeSegments = RANGE_OPTIONS.map(r => ({value: r, label: t(`chart.range.${r}`)}));

  const header = (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
        {t('chart.title')}
      </h2>
      <SegmentedControl segments={rangeSegments} value={range} onChange={setRange} />
    </div>
  );

  if (data.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {header}
        <div className="flex items-center justify-center h-48 rounded-lg border border-border bg-surface text-xs text-text-disabled">
          {t('chart.empty')}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {header}
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{top: 4, right: 4, bottom: 0, left: 0}}>
          <defs>
            <linearGradient id="wealthGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={theme.gold} stopOpacity={0.25} />
              <stop offset="95%" stopColor={theme.gold} stopOpacity={0}    />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke={theme.border}
            vertical={false}
          />
          <XAxis
            dataKey="time"
            tickFormatter={tickFormatterFor(range)}
            tick={{fill: theme.textDisabled, fontSize: 11}}
            axisLine={{stroke: theme.border}}
            tickLine={false}
            minTickGap={60}
          />
          <YAxis
            tickFormatter={formatFE}
            tick={{fill: theme.textDisabled, fontSize: 11}}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area
            type="monotone"
            dataKey="value"
            stroke={theme.gold}
            strokeWidth={2}
            fill="url(#wealthGradient)"
            dot={false}
            activeDot={{r: 4, fill: theme.gold, stroke: theme.surface, strokeWidth: 2}}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

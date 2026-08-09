import {useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {
  Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {useTheme} from '@/theme/ThemeContext';
import type {MechanicKey, SessionAnalytics} from '../analytics';
import {mechanicColors, typeColors} from './colors';
import {formatFE, formatFEFull, pick, type ValueMode} from './format';

/** Beyond this, adjacent runs are bucketed so bars stay readable. */
const MAX_BARS = 50;

interface Datum {
  xLabel:         string;
  firstIndex:     number;
  lastIndex:      number;
  mapIncome:      number;
  seasonalIncome: number;
  bySeasonal:     Partial<Record<MechanicKey, number>>;
  cost:           number;
  cumulative:     number;
}

function PerMapTooltip({active, payload}: {active?: boolean; payload?: {payload: Datum}[]}) {
  const {t} = useTranslation('sessions');
  if (!active || !payload?.length) return null;
  const d   = payload[0].payload;
  const net = d.mapIncome + d.seasonalIncome - Math.abs(d.cost);
  return (
    <div className="bg-surface border border-border rounded px-3 py-2 text-xs shadow-lg space-y-1">
      <p className="text-text-secondary">
        {d.firstIndex === d.lastIndex
          ? t('details.tooltipMap', {n: d.firstIndex})
          : t('details.tooltipMapRange', {from: d.firstIndex, to: d.lastIndex})}
      </p>
      {d.mapIncome > 0 && (
        <p className="font-mono text-success">{t('details.tooltipIncome')}: +{formatFEFull(d.mapIncome)}</p>
      )}
      {Object.entries(d.bySeasonal)
        .sort((a, b) => b[1] - a[1])
        .map(([key, value]) => (
          <p key={key} className="font-mono text-gold">
            {t(`details.source.${key}` as never)}: +{formatFEFull(value)}
          </p>
        ))}
      <p className="font-mono text-danger">{t('details.tooltipCost')}: {formatFEFull(d.cost)}</p>
      <p className={`font-mono font-semibold ${net >= 0 ? 'text-gold' : 'text-danger'}`}>
        {t('details.tooltipNet')}: {net >= 0 ? '+' : ''}{formatFEFull(net)}
      </p>
      <p className="font-mono text-text-secondary text-[10px]">
        {t('details.tooltipCumulative')}: {d.cumulative >= 0 ? '+' : ''}{formatFEFull(d.cumulative)}
      </p>
    </div>
  );
}

export function PerMapChart({analytics, mode}: {analytics: SessionAnalytics; mode: ValueMode}) {
  const {t}   = useTranslation('sessions');
  const theme = useTheme();

  const data = useMemo<Datum[]>(() => {
    const points = analytics.perMap;
    if (points.length === 0) return [];

    const size = Math.max(1, Math.ceil(points.length / MAX_BARS));
    const out: Datum[] = [];
    for (let i = 0; i < points.length; i += size) {
      const slice = points.slice(i, i + size);
      const bySeasonal: Partial<Record<MechanicKey, number>> = {};
      let mapIncome = 0, seasonalIncome = 0, cost = 0;

      for (const p of slice) {
        mapIncome      += pick(p.mapIncome, mode);
        seasonalIncome += pick(p.seasonalIncome, mode);
        cost           += pick(p.cost, mode);
        for (const [key, value] of Object.entries(p.bySeasonal)) {
          const k = key as MechanicKey;
          bySeasonal[k] = (bySeasonal[k] ?? 0) + pick(value, mode);
        }
      }

      const first = slice[0].mapIndex;
      const last  = slice[slice.length - 1].mapIndex;
      out.push({
        firstIndex: first,
        lastIndex:  last,
        xLabel:     first === last ? `${first}` : `${first}–${last}`,
        mapIncome, seasonalIncome, bySeasonal,
        cost:       -cost,
        cumulative: pick(slice[slice.length - 1].cumulative, mode),
      });
    }
    return out;
  }, [analytics.perMap, mode]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px] rounded-lg border border-border bg-surface text-xs text-text-disabled px-6 text-center">
        {t('details.perMapEmpty')}
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{top: 8, right: 8, bottom: 0, left: 0}}>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.border} vertical={false} />
        <XAxis
          dataKey="xLabel" tick={{fill: theme.textDisabled, fontSize: 11}}
          axisLine={{stroke: theme.border}} tickLine={false} interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={formatFE} tick={{fill: theme.textDisabled, fontSize: 11}}
          axisLine={false} tickLine={false} width={56}
        />
        <ReferenceLine y={0} stroke={theme.border} strokeWidth={1.5} />
        <Tooltip content={<PerMapTooltip />} cursor={{fill: theme.border, opacity: 0.3}} />
        <Bar dataKey="mapIncome"      stackId="a" fill={theme.success} radius={[2, 2, 0, 0]} />
        <Bar dataKey="seasonalIncome" stackId="a" fill={theme.gold}    radius={[2, 2, 0, 0]} />
        <Bar dataKey="cost"           stackId="a" fill={theme.danger}  radius={[0, 0, 2, 2]} />
        <Line
          type="monotone" dataKey="cumulative" stroke={theme.accent} strokeWidth={2} dot={false}
          activeDot={{r: 4, fill: theme.accent, stroke: theme.surface, strokeWidth: 2}}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

interface Slice {
  label: string;
  value: number;
  pct:   number;
  color: string;
}

function SliceTooltip({active, payload}: {active?: boolean; payload?: {payload: Slice}[]}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-surface border border-border rounded px-3 py-2 text-xs shadow-lg">
      <p className="text-text-primary font-semibold mb-1">{d.label}</p>
      <p className="font-mono text-gold">{formatFEFull(d.value)} FE</p>
      <p className="text-text-secondary">{d.pct.toFixed(1)}%</p>
    </div>
  );
}

function Donut({data, empty}: {data: Slice[]; empty: string}) {
  const theme = useTheme();
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[280px] text-xs text-text-disabled px-6 text-center">
        {empty}
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie
          data={data} dataKey="value" nameKey="label" cx="50%" cy="50%"
          innerRadius={50} outerRadius={90} paddingAngle={2}
          stroke={theme.surface} strokeWidth={2}
        >
          {data.map(d => <Cell key={d.label} fill={d.color} />)}
        </Pie>
        <Tooltip content={<SliceTooltip />} />
        <Legend verticalAlign="bottom" iconType="circle" wrapperStyle={{fontSize: 11, color: theme.textSecondary}} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function ByTypeDonut({analytics, mode}: {analytics: SessionAnalytics; mode: ValueMode}) {
  const {t}         = useTranslation('sessions');
  const {t: tItems} = useTranslation('items');
  const theme       = useTheme();
  const colors      = typeColors(theme);

  const data = analytics.byType.map(s => ({
    label: tItems(`types.${s.type}` as never),
    value: pick(s.value, mode),
    pct:   pick(s.pct, mode),
    color: colors[s.type],
  }));

  return <Donut data={data} empty={t('details.byTypeEmpty')} />;
}

export function BySourceDonut({analytics, mode}: {analytics: SessionAnalytics; mode: ValueMode}) {
  const {t}  = useTranslation('sessions');
  const theme = useTheme();
  const colors = mechanicColors(theme);

  const data = analytics.bySource.map(s => ({
    label: t(`details.source.${s.source}` as never),
    value: pick(s.value, mode),
    pct:   pick(s.pct, mode),
    color: colors[s.source as MechanicKey] ?? theme.textDisabled,
  }));

  return <Donut data={data} empty={t('details.bySourceEmpty')} />;
}

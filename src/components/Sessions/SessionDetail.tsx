import {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ArrowLeft} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import {useSessionsStore} from '@/state/sessionsStore';
import {useItemsStore} from '@/state/itemsStore';
import {useTracking} from '@/state/TrackingContext';
import {useTheme} from '@/theme/ThemeContext';
import {ITEM_TYPES, type ItemType} from '@/types/itemType';
import type {DbSessionMap} from '@/types/electron';
import type {NavItemId} from '@/components/Sidebar/Sidebar';
import {formatDate, formatDuration} from './SessionsTable';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatFE(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000)     return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString(undefined, {maximumFractionDigits: 0});
}

function formatFEFull(value: number): string {
  return value.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
}

// Distinct color per item type — derived from theme tokens.
function typeColors(theme: ReturnType<typeof useTheme>): Record<ItemType, string> {
  return {
    ember:       theme.typeEmber,
    fuel:        theme.typeFuel,
    compass:     theme.accent,
    dream:       theme.typeDream,
    cube:        theme.typeCube,
    card:        theme.typeCard,
    skill:       theme.typeSkill,
    equipment:   theme.success,
    mapMaterial: theme.gold,
    other:       theme.textDisabled,
  };
}

// ---------------------------------------------------------------------------
// Per-map cost vs income chart
// ---------------------------------------------------------------------------

/** Maximum bars shown in the per-map chart. Beyond this we bucket adjacent
 *  maps together so the bars stay readable on a fixed-width chart. */
const MAX_BARS = 50;

interface PerMapDatum {
  /** First map index in this bucket (1-based). Equals lastIndex for size=1. */
  firstIndex: number;
  lastIndex:  number;
  /** Display label for the X axis: "42" or "41–50". */
  xLabel:     string;
  income:     number; // positive
  cost:       number; // negative — so it stacks below 0 on the same y-axis
  net:        number; // income + cost
}

interface PerMapTooltipPayload {
  payload: PerMapDatum;
}

function PerMapTooltip({active, payload}: {active?: boolean; payload?: PerMapTooltipPayload[]}) {
  const {t} = useTranslation('sessions');
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const heading = d.firstIndex === d.lastIndex
    ? t('details.tooltipMap', {n: d.firstIndex})
    : t('details.tooltipMapRange', {from: d.firstIndex, to: d.lastIndex});
  return (
    <div className="bg-surface border border-border rounded px-3 py-2 text-xs shadow-lg space-y-1">
      <p className="text-text-secondary">{heading}</p>
      <p className="font-mono text-success">{t('details.tooltipIncome')}: +{formatFEFull(d.income)}</p>
      <p className="font-mono text-danger">{t('details.tooltipCost')}: {formatFEFull(d.cost)}</p>
      <p className={`font-mono font-semibold ${d.net >= 0 ? 'text-gold' : 'text-danger'}`}>
        {t('details.tooltipNet')}: {d.net >= 0 ? '+' : ''}{formatFEFull(d.net)}
      </p>
    </div>
  );
}

function PerMapBarChart({maps, prices}: {maps: DbSessionMap[]; prices: Record<string, number>}) {
  const {t}   = useTranslation('sessions');
  const theme = useTheme();

  const data = useMemo<PerMapDatum[]>(() => {
    if (maps.length === 0) return [];
    const bucketSize = Math.max(1, Math.ceil(maps.length / MAX_BARS));
    const out: PerMapDatum[] = [];
    for (let i = 0; i < maps.length; i += bucketSize) {
      const slice = maps.slice(i, i + bucketSize);
      let income = 0;
      let cost   = 0;
      for (const m of slice) {
        for (const [id, qty] of Object.entries(m.drops)) income += qty * (prices[id] ?? 0);
        for (const [id, qty] of Object.entries(m.spent)) cost   += qty * (prices[id] ?? 0);
      }
      const firstIndex = slice[0].mapIndex;
      const lastIndex  = slice[slice.length - 1].mapIndex;
      out.push({
        firstIndex,
        lastIndex,
        xLabel: firstIndex === lastIndex ? `${firstIndex}` : `${firstIndex}–${lastIndex}`,
        income,
        cost: -cost,
        net:  income - cost,
      });
    }
    return out;
  }, [maps, prices]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 rounded-lg border border-border bg-surface text-xs text-text-disabled px-6 text-center">
        {t('details.perMapEmpty')}
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{top: 8, right: 8, bottom: 0, left: 0}}>
        <CartesianGrid strokeDasharray="3 3" stroke={theme.border} vertical={false} />
        <XAxis
          dataKey="xLabel"
          tick={{fill: theme.textDisabled, fontSize: 11}}
          axisLine={{stroke: theme.border}}
          tickLine={false}
          interval="preserveStartEnd"
        />
        <YAxis
          tickFormatter={formatFE}
          tick={{fill: theme.textDisabled, fontSize: 11}}
          axisLine={false}
          tickLine={false}
          width={56}
        />
        <ReferenceLine y={0} stroke={theme.border} strokeWidth={1.5} />
        <Tooltip content={<PerMapTooltip />} cursor={{fill: theme.border, opacity: 0.3}} />
        <Bar dataKey="income" stackId="a" fill={theme.success} radius={[2, 2, 0, 0]} />
        <Bar dataKey="cost"   stackId="a" fill={theme.danger}  radius={[0, 0, 2, 2]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Pie: value by item type
// ---------------------------------------------------------------------------

interface ByTypeDatum {
  type:  ItemType;
  label: string;
  value: number;
  pct:   number;
}

function ByTypeTooltip({active, payload}: {active?: boolean; payload?: {payload: ByTypeDatum}[]}) {
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

function ByTypePieChart({drops, prices, itemTypes}: {
  drops:     Record<string, number>;
  prices:    Record<string, number>;
  itemTypes: Record<string, ItemType>;
}) {
  const {t}        = useTranslation('sessions');
  const {t: tItems} = useTranslation('items');
  const theme      = useTheme();
  const colors     = useMemo(() => typeColors(theme), [theme]);

  const data = useMemo<ByTypeDatum[]>(() => {
    const totals: Record<ItemType, number> = {} as Record<ItemType, number>;
    for (const type of ITEM_TYPES) totals[type] = 0;
    for (const [id, qty] of Object.entries(drops)) {
      const type  = itemTypes[id] ?? 'other';
      const price = prices[id] ?? 0;
      totals[type] += qty * price;
    }
    const grand = Object.values(totals).reduce((s, v) => s + v, 0);
    if (grand <= 0) return [];
    return ITEM_TYPES
      .filter(type => totals[type] > 0)
      .map(type => ({
        type,
        label: tItems(`types.${type}` as never),
        value: totals[type],
        pct:   (totals[type] / grand) * 100,
      }))
      .sort((a, b) => b.value - a.value);
  }, [drops, prices, itemTypes, tItems]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 rounded-lg border border-border bg-surface text-xs text-text-disabled px-6 text-center">
        {t('details.byTypeEmpty')}
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="label"
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={95}
          paddingAngle={2}
          stroke={theme.surface}
          strokeWidth={2}
        >
          {data.map(entry => (
            <Cell key={entry.type} fill={colors[entry.type]} />
          ))}
        </Pie>
        <Tooltip content={<ByTypeTooltip />} />
        <Legend
          verticalAlign="bottom"
          iconType="circle"
          wrapperStyle={{fontSize: 11, color: theme.textSecondary}}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Stat strip
// ---------------------------------------------------------------------------

function StatBlock({label, value, sub}: {label: string; value: string; sub?: string}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-text-disabled">
        {label}
      </span>
      <span className="text-2xl font-bold text-text-primary tabular-nums">
        {value}
      </span>
      {sub && <span className="text-xs text-text-secondary tabular-nums">{sub}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main detail page
// ---------------------------------------------------------------------------

interface Props {
  sessionId:   string;
  onBack:      () => void;
  onNavChange: (id: NavItemId) => void;
}

export default function SessionDetail({sessionId, onBack, onNavChange}: Props) {
  const {t}             = useTranslation('sessions');
  const sessions        = useSessionsStore(s => s.sessions);
  const deleteSession   = useSessionsStore(s => s.deleteSession);
  const renameSession   = useSessionsStore(s => s.renameSession);
  const items           = useItemsStore(s => s.items);
  const {continueSession, status} = useTracking();

  const [maps, setMaps] = useState<DbSessionMap[]>([]);
  const [mapsLoaded, setMapsLoaded] = useState(false);

  const session = sessions.find(s => s.id === sessionId);

  // Load per-map breakdown on mount / session change.
  useEffect(() => {
    let cancelled = false;
    setMapsLoaded(false);
    window.electronAPI.db.sessionMaps.getForSession(sessionId).then(rows => {
      if (cancelled) return;
      setMaps(rows);
      setMapsLoaded(true);
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  const prices = useMemo(
    () => Object.fromEntries(Object.entries(items).map(([id, item]) => [id, item.price])),
    [items],
  );
  const itemTypes = useMemo(
    () => Object.fromEntries(Object.entries(items).map(([id, item]) => [id, item.type as ItemType])),
    [items],
  );

  const totalFE = useMemo(() => {
    if (!session) return 0;
    return Object.entries(session.drops).reduce((sum, [id, qty]) => sum + qty * (prices[id] ?? 0), 0);
  }, [session, prices]);

  const fePerHour = useMemo(() => {
    if (!session || session.totalTime <= 0) return 0;
    return totalFE / (session.totalTime / 3600);
  }, [session, totalFE]);

  if (!session) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-6 py-4 border-b border-border shrink-0">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('details.back')}
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center text-sm text-text-disabled">
          {t('details.selectPrompt')}
        </div>
      </div>
    );
  }

  const isTracking = status !== 'idle';

  function handleContinue() {
    continueSession(session!.id);
    onNavChange('dashboard');
  }

  function handleRename() {
    const newName = window.prompt(t('actions.renamePrompt'), session!.name);
    if (newName && newName.trim() && newName.trim() !== session!.name) {
      renameSession(session!.id, newName.trim());
    }
  }

  function handleDelete() {
    const msg = t('actions.confirmDelete', {name: session!.name});
    if (window.confirm(msg)) {
      deleteSession(session!.id);
      onBack();
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header strip */}
      <div className="px-6 py-4 border-b border-border shrink-0 flex items-center justify-between gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors shrink-0"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('details.back')}
        </button>
        <h1 className="text-lg font-bold text-text-primary truncate" title={session.name}>
          {session.name}
        </h1>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={handleContinue}
            disabled={isTracking}
            className="px-3 py-1.5 rounded-md text-xs font-semibold bg-accent text-bg hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('actions.continue')}
          </button>
          <button
            onClick={handleRename}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-surface-elevated text-text-primary hover:bg-white/10 transition-colors"
          >
            {t('actions.rename')}
          </button>
          <button
            onClick={handleDelete}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-danger/15 text-danger hover:bg-danger/25 transition-colors"
          >
            {t('actions.delete')}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
        {/* Big stat strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 pb-6 border-b border-border">
          <StatBlock
            label={t('details.totalFE')}
            value={`${formatFEFull(totalFE)} FE`}
            sub={formatDate(session.savedAt)}
          />
          <StatBlock
            label={t('details.fePerHour')}
            value={`${formatFEFull(fePerHour)} FE/h`}
          />
          <StatBlock
            label={t('details.mapsRun')}
            value={String(session.mapCount)}
            sub={`${formatDuration(session.mapTime)} ${t('details.mapTime').toLowerCase()}`}
          />
          <StatBlock
            label={t('details.totalTime')}
            value={formatDuration(session.totalTime)}
          />
        </div>

        {/* Charts row: per-map (wider) + by-type pie (narrower) */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 flex flex-col gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
              {t('details.perMapTitle')}
            </h2>
            {!mapsLoaded ? (
              <div className="h-[300px]" />
            ) : (
              <PerMapBarChart maps={maps} prices={prices} />
            )}
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
              {t('details.byTypeTitle')}
            </h2>
            <ByTypePieChart drops={session.drops} prices={prices} itemTypes={itemTypes} />
          </div>
        </div>
      </div>
    </div>
  );
}

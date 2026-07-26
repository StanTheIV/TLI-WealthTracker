import {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ArrowLeft} from 'lucide-react';
import {
  ResponsiveContainer,
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import {useSessionsStore} from '@/state/sessionsStore';
import {useItemsStore} from '@/state/itemsStore';
import {useTracking} from '@/state/TrackingContext';
import {useTheme} from '@/theme/ThemeContext';
import {ITEM_TYPES, type ItemType} from '@/types/itemType';
import type {DbSession, DbSessionMap, SeasonalType, SessionAttribution, Source} from '@/types/electron';
import type {NavItemId} from '@/components/Sidebar/Sidebar';
import {formatDate, formatDuration} from './SessionsTable';

const SOURCES: Source[] = ['map', 'overrealm', 'clockwork', 'carjack', 'sandlord', 'lunaria', 'vorex', 'arcana', 'dream'];

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

// Distinct color per loot source. Map = green to match the per-map chart's
// regular-map bars; sandlord = gold to match the standalone-seasonal stack;
// the rest reuse type tokens for visual variety.
function sourceColors(theme: ReturnType<typeof useTheme>): Record<Source, string> {
  return {
    map:       theme.success,
    sandlord:  theme.gold,
    overrealm: theme.accent,
    clockwork: theme.typeCube,
    carjack:   theme.typeCard,
    lunaria:   theme.typeFuel,
    vorex:     theme.typeEmber,
    arcana:    theme.typeSkill,
    dream:     theme.typeDream,
  };
}

// ---------------------------------------------------------------------------
// Per-map cost vs income chart
// ---------------------------------------------------------------------------

/** Maximum bars shown in the per-map chart. Beyond this we bucket adjacent
 *  maps together so the bars stay readable on a fixed-width chart. */
const MAX_BARS = 50;

interface PerMapDatum {
  /** First run index in this bucket (1-based). Equals lastIndex for size=1. */
  firstIndex:     number;
  lastIndex:      number;
  /** Display label for the X axis: "42" or "41–50". */
  xLabel:         string;
  /** Income from regular map runs in this bucket, EXCLUDING any in-map seasonal
   *  income split out below (positive). */
  mapIncome:      number;
  /** Income from seasonal runs in this bucket — standalone (e.g. Sandlord) plus
   *  in-map seasonals split out of their parent map row (positive). */
  seasonalIncome: number;
  /** seasonalIncome broken down by mechanic, for the tooltip. Only types that
   *  actually contributed appear. */
  bySeasonal:     Partial<Record<SeasonalType, number>>;
  /** Map-material cost across all runs in the bucket — negated so it stacks below 0. */
  cost:           number;
  /** Running cumulative net (income − cost summed up to and including this bucket). */
  cumulative:     number;
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
  const totalIncome = d.mapIncome + d.seasonalIncome;
  const net         = totalIncome - Math.abs(d.cost);
  return (
    <div className="bg-surface border border-border rounded px-3 py-2 text-xs shadow-lg space-y-1">
      <p className="text-text-secondary">{heading}</p>
      {d.mapIncome > 0 && (
        <p className="font-mono text-success">{t('details.tooltipIncome')}: +{formatFEFull(d.mapIncome)}</p>
      )}
      {Object.entries(d.bySeasonal)
        .sort((a, b) => b[1] - a[1])
        .map(([type, income]) => (
          <p key={type} className="font-mono text-gold">
            {t(`details.source.${type}` as never)}: +{formatFEFull(income)}
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

function PerMapBarChart({maps, prices, attribution}: {
  maps:        DbSessionMap[];
  prices:      Record<string, number>;
  attribution: SessionAttribution;
}) {
  const {t}   = useTranslation('sessions');
  const theme = useTheme();

  const data = useMemo<PerMapDatum[]>(() => {
    const primary = maps.filter(m => m.parentMapIndex == null);
    if (primary.length === 0) return [];

    // Overlap rows (parentMapIndex set) hold an in-map seasonal's income. How
    // they combine with the parent map row depends on the era:
    //   drop-through / legacy — parent row ALREADY includes them, so the
    //     overlap income is SUBTRACTED from the parent's mapIncome and shown as
    //     its own seasonal segment. Bar total is unchanged; the split is new.
    //   exclusive — parent row EXCLUDES them, so overlap income is ADDED on top.
    const parentContainsOverlap = attribution !== 'exclusive';
    const overlapBySeasonal = new Map<number, Partial<Record<SeasonalType, number>>>();
    for (const m of maps) {
      if (m.parentMapIndex == null) continue;
      let income = 0;
      for (const [id, qty] of Object.entries(m.drops)) {
        if (qty > 0) income += qty * (prices[id] ?? 0);
      }
      if (income <= 0) continue;
      const type   = (m.seasonalType ?? 'overrealm') as SeasonalType;
      const bucket = overlapBySeasonal.get(m.parentMapIndex) ?? {};
      bucket[type] = (bucket[type] ?? 0) + income;
      overlapBySeasonal.set(m.parentMapIndex, bucket);
    }

    const bucketSize = Math.max(1, Math.ceil(primary.length / MAX_BARS));
    const out: PerMapDatum[] = [];
    let runningNet = 0;
    for (let i = 0; i < primary.length; i += bucketSize) {
      const slice = primary.slice(i, i + bucketSize);
      let mapIncome      = 0;
      let seasonalIncome = 0;
      let cost           = 0;
      const bySeasonal: Partial<Record<SeasonalType, number>> = {};
      for (const m of slice) {
        // Income = positive entries in m.drops only. Negative entries are
        // pre-map material spends that ItemHandler flushed into the map
        // tracker on town→map; the same deltas live (positive-magnitude) in
        // m.spent and feed the cost line. Counting them in both would
        // double-count, so income takes only the positives.
        let rowIncome = 0;
        for (const [id, qty] of Object.entries(m.drops)) {
          if (qty > 0) rowIncome += qty * (prices[id] ?? 0);
        }
        for (const [id, qty] of Object.entries(m.spent)) cost += qty * (prices[id] ?? 0);

        const overlap = overlapBySeasonal.get(m.mapIndex);
        let overlapTotal = 0;
        for (const [type, income] of Object.entries(overlap ?? {})) {
          bySeasonal[type as SeasonalType] = (bySeasonal[type as SeasonalType] ?? 0) + income;
          overlapTotal += income;
        }
        seasonalIncome += overlapTotal;

        if (m.seasonalType !== null) {
          // Standalone seasonal run (Sandlord, town-started) — the whole row.
          seasonalIncome += rowIncome;
          bySeasonal[m.seasonalType] = (bySeasonal[m.seasonalType] ?? 0) + rowIncome;
        } else if (parentContainsOverlap) {
          // Clamp: overlap rows are a subset of the parent, but the two were
          // valued at different times, so float drift could push this negative.
          mapIncome += Math.max(0, rowIncome - overlapTotal);
        } else {
          mapIncome += rowIncome;
        }
      }
      const firstIndex = slice[0].mapIndex;
      const lastIndex  = slice[slice.length - 1].mapIndex;
      runningNet += (mapIncome + seasonalIncome) - cost;
      out.push({
        firstIndex,
        lastIndex,
        xLabel: firstIndex === lastIndex ? `${firstIndex}` : `${firstIndex}–${lastIndex}`,
        mapIncome,
        seasonalIncome,
        bySeasonal,
        cost: -cost,
        cumulative: runningNet,
      });
    }
    return out;
  }, [maps, prices, attribution]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 rounded-lg border border-border bg-surface text-xs text-text-disabled px-6 text-center">
        {t('details.perMapEmpty')}
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={data} margin={{top: 8, right: 8, bottom: 0, left: 0}}>
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
        <Bar dataKey="mapIncome"      stackId="a" fill={theme.success} radius={[2, 2, 0, 0]} />
        <Bar dataKey="seasonalIncome" stackId="a" fill={theme.gold}    radius={[2, 2, 0, 0]} />
        <Bar dataKey="cost"           stackId="a" fill={theme.danger}  radius={[0, 0, 2, 2]} />
        <Line
          type="monotone"
          dataKey="cumulative"
          stroke={theme.accent}
          strokeWidth={2}
          dot={false}
          activeDot={{r: 4, fill: theme.accent, stroke: theme.surface, strokeWidth: 2}}
          isAnimationActive={false}
        />
      </ComposedChart>
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
      // Negative quantities (e.g. items listed on the auction house mid-session)
      // aren't income — they're conversions. Clamp to 0 so they don't subtract
      // from the breakdown of where drops actually came from.
      if (qty <= 0) continue;
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
// Pie: value by source (regular map vs each seasonal mechanic)
// ---------------------------------------------------------------------------

interface BySourceDatum {
  source: Source;
  label:  string;
  value:  number;
  pct:    number;
}

function BySourceTooltip({active, payload}: {active?: boolean; payload?: {payload: BySourceDatum}[]}) {
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

// NOTE: This pie reads `session.dropsBySource` — each drop counted ONCE under
// its owner, in every attribution era, so slices always sum to session FE. It
// is deliberately a breakdown of the SESSION, not of the map: under
// drop-through the map tracker also accrues in-map seasonal drops, so the
// per-map chart's segments split differently from these slices.
//
// Legacy fallback: pre-refactor sessions saved with empty dropsBySource fall
// back to the old per-map-row aggregation. That logic is correct for the
// no-overlap case it was designed for — single-seasonal-slot guarantees
// each drop appeared in at most one overlap row's drops.
function BySourcePieChart({session, maps, prices}: {
  session: DbSession;
  maps:    DbSessionMap[];
  prices:  Record<string, number>;
}) {
  const {t} = useTranslation('sessions');
  const theme  = useTheme();
  const colors = useMemo(() => sourceColors(theme), [theme]);

  const data = useMemo<BySourceDatum[]>(() => {
    const totals: Record<Source, number> = {} as Record<Source, number>;
    for (const s of SOURCES) totals[s] = 0;

    const dbs = session.dropsBySource ?? {};
    const hasNew = Object.keys(dbs).length > 0;

    if (hasNew) {
      // New path: each drop already attributed to exactly one source.
      for (const [source, dropDict] of Object.entries(dbs)) {
        for (const [id, qty] of Object.entries(dropDict)) {
          if (qty > 0) totals[source as Source] += qty * (prices[id] ?? 0);
        }
      }
    } else {
      // Legacy fallback for sessions saved before the dropsBySource refactor.
      // Pre-refactor, only one seasonal could run at a time, so this
      // subtraction is correct (no double-overlap to worry about).
      for (const m of maps) {
        const source: Source = (m.seasonalType ?? 'map') as Source;
        let rowIncome = 0;
        for (const [id, qty] of Object.entries(m.drops)) {
          if (qty > 0) rowIncome += qty * (prices[id] ?? 0);
        }
        totals[source] += rowIncome;
        if (m.parentMapIndex != null) totals.map -= rowIncome;
      }
    }
    const grand = Object.values(totals).reduce((s, v) => s + Math.max(0, v), 0);
    if (grand <= 0) return [];
    return SOURCES
      .filter(source => totals[source] > 0)
      .map(source => ({
        source,
        label: t(`details.source.${source}` as never),
        value: totals[source],
        pct:   (totals[source] / grand) * 100,
      }))
      .sort((a, b) => b.value - a.value);
  }, [session, maps, prices, t]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 rounded-lg border border-border bg-surface text-xs text-text-disabled px-6 text-center">
        {t('details.bySourceEmpty')}
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
            <Cell key={entry.source} fill={colors[entry.source]} />
          ))}
        </Pie>
        <Tooltip content={<BySourceTooltip />} />
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

        {/* Charts row: per-map (wider) + by-type pie + by-source pie */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          <div className="lg:col-span-2 flex flex-col gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
              {t('details.perMapTitle')}
            </h2>
            {!mapsLoaded ? (
              <div className="h-[300px]" />
            ) : (
              <PerMapBarChart
                maps={maps}
                prices={prices}
                attribution={session.attribution}
              />
            )}
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
              {t('details.byTypeTitle')}
            </h2>
            <ByTypePieChart drops={session.drops} prices={prices} itemTypes={itemTypes} />
          </div>
          <div className="flex flex-col gap-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
              {t('details.bySourceTitle')}
            </h2>
            {!mapsLoaded ? (
              <div className="h-[300px]" />
            ) : (
              <BySourcePieChart session={session} maps={maps} prices={prices} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

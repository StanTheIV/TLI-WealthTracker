import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent} from 'react';
import {useTranslation} from 'react-i18next';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  type MouseHandlerDataParam,
} from 'recharts';
import {useWealthStore, type WealthRange} from '@/state/wealthStore';
import {activePointIndex} from '@/lib/chartPointer';
import {formatDateTime, formatFECompact, formatFEFull} from '@/lib/format';
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
      <p className="text-text-secondary mb-1">{formatDateTime(entry.payload.time)}</p>
      <p className="font-mono font-semibold text-gold">{formatFEFull(entry.value ?? 0, {unit: true})}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right-click menu on a reading
// ---------------------------------------------------------------------------

interface ChartPoint {
  id:    number;
  time:  number;
  value: number;
}

interface MenuState {
  x:     number;
  y:     number;
  point: ChartPoint;
}

/** Fixed-position menu at the cursor. Closes on outside click, Escape, scroll
 *  or resize — anything that would leave it pointing at the wrong spot. */
function PointMenu({menu, onDelete, onClose}: {menu: MenuState; onDelete: () => void; onClose: () => void}) {
  const {t}  = useTranslation('dashboard');
  const ref  = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({left: menu.x, top: menu.y});

  // Keep the whole menu on screen when opened near the right or bottom edge.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const {width, height} = el.getBoundingClientRect();
    setPos({
      left: Math.min(menu.x, window.innerWidth  - width  - 4),
      top:  Math.min(menu.y, window.innerHeight - height - 4),
    });
  }, [menu.x, menu.y]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-44 bg-surface-elevated border border-border rounded-lg shadow-lg py-1 text-xs"
      style={{left: pos.left, top: pos.top}}
    >
      <div className="px-3 py-1.5 border-b border-border">
        <p className="text-text-secondary">{formatDateTime(menu.point.time)}</p>
        <p className="font-mono font-semibold text-gold">{formatFEFull(menu.point.value, {unit: true})}</p>
      </div>
      <button
        role="menuitem"
        onClick={onDelete}
        className="w-full text-left px-3 py-1.5 text-danger hover:bg-danger/15 transition-colors"
      >
        {t('chart.contextMenu.delete')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WealthChart() {
  const {t}         = useTranslation('dashboard');
  const theme       = useTheme();
  const points      = useWealthStore(s => s.points);
  const range       = useWealthStore(s => s.range);
  const setRange    = useWealthStore(s => s.setRange);
  const deletePoint = useWealthStore(s => s.deletePoint);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const data = useMemo<ChartPoint[]>(
    () => points.map(p => ({id: p.id, time: p.ts, value: p.value})),
    [points],
  );

  // A right-click with no active point under the cursor leaves the native menu alone.
  const openMenu = (state: MouseHandlerDataParam, e: MouseEvent<SVGGraphicsElement>) => {
    const index = activePointIndex(state);
    const point = index === null ? undefined : data[index];
    if (!point) return;
    e.preventDefault();
    setMenu({x: e.clientX, y: e.clientY, point});
  };

  const closeMenu = useCallback(() => setMenu(null), []);

  const confirmDelete = () => {
    if (!menu) return;
    const {point} = menu;
    setMenu(null);
    if (window.confirm(t('chart.contextMenu.confirm', {time: formatDateTime(point.time), value: formatFEFull(point.value, {unit: true})}))) {
      deletePoint(point.id).catch((err: unknown) => console.error('[wealth] delete failed:', err));
    }
  };

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
        <AreaChart data={data} margin={{top: 4, right: 4, bottom: 0, left: 0}} onContextMenu={openMenu}>
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
            tickFormatter={formatFECompact}
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
      {menu && <PointMenu menu={menu} onDelete={confirmDelete} onClose={closeMenu} />}
    </div>
  );
}

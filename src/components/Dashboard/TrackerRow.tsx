import {useMemo} from 'react';
import type {RateTimeframe} from '@/state/settingsStore';

interface TrackerRowProps {
  label:         string;
  valueFE:       number | null;
  elapsedMs:     number | null;
  rateTimeframe: RateTimeframe;
  accentClass:   string; // Tailwind bg color class for the left accent bar, e.g. 'bg-accent'
  dim?:          boolean;
  badge?:        string; // small pill text, e.g. "#42"
  paused?:       boolean;
}

function formatElapsed(ms: number): string {
  const s   = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function feColor(value: number | null): string {
  if (value === null) return 'text-text-disabled';
  return value < 0 ? 'text-danger' : 'text-gold';
}

function formatFE(value: number | null): string {
  if (value === null) return '—';
  const abs  = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  return `${sign}${abs.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
}

function formatRate(valueFE: number | null, elapsedMs: number | null, timeframe: RateTimeframe): string {
  const suffix = timeframe === 'hour' ? '/h' : '/m';
  if (valueFE === null || elapsedMs === null || elapsedMs < 1000) return `— FE${suffix}`;
  const divisor = timeframe === 'hour' ? 3_600_000 : 60_000;
  const rate    = valueFE / (elapsedMs / divisor);
  const abs     = Math.abs(rate);
  const sign    = rate < 0 ? '-' : '';
  return `${sign}${abs.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} FE${suffix}`;
}

export default function TrackerRow({
  label, valueFE, elapsedMs, rateTimeframe, accentClass, dim = false, badge, paused = false,
}: TrackerRowProps) {
  const elapsedSec = elapsedMs !== null ? Math.floor(elapsedMs / 1000) * 1000 : null;
  const rateStr = useMemo(
    () => formatRate(valueFE, elapsedSec, rateTimeframe),
    [valueFE, elapsedSec, rateTimeframe],
  );

  const feVal   = formatFE(valueFE);
  const valColor = feColor(valueFE);

  return (
    <div
      className={`
        relative flex items-stretch rounded-md overflow-hidden
        transition-opacity duration-200
        ${dim ? 'opacity-35' : 'opacity-100'}
      `}
      style={{backgroundColor: 'color-mix(in srgb, var(--color-surface-elevated) calc(var(--card-opacity, 1) * 100%), transparent)'}}
    >
      {/* Left accent bar */}
      <div className={`w-1 shrink-0 ${accentClass} ${dim ? 'opacity-50' : ''}`} />

      {/* Card body */}
      <div className="flex flex-col flex-1 min-w-0 px-3 py-2 gap-1">

        {/* Header row: label + badge + elapsed */}
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-semibold uppercase tracking-wider text-text-secondary leading-none">
            {label}
          </span>

          {badge && !paused && (
            <span className="text-[12px] font-mono tabular-nums px-1 py-px rounded bg-white/8 text-text-disabled leading-none">
              {badge}
            </span>
          )}

          {paused && (
            <span className="text-[12px] font-semibold uppercase tracking-wider px-1 py-px rounded bg-gold-muted/60 text-gold leading-none">
              paused
            </span>
          )}

          <span className={`ml-auto font-mono text-[13px] tabular-nums leading-none ${elapsedMs === null ? 'text-text-disabled' : 'text-text-secondary'}`}>
            {elapsedMs === null ? '--:--:--' : formatElapsed(elapsedMs)}
          </span>
        </div>

        {/* Value row: big FE + rate right-aligned */}
        <div className="flex items-baseline gap-2">
          <span className={`font-mono text-lg font-bold tabular-nums leading-none ${valColor}`}>
            {feVal}
          </span>
          <span className={`font-mono text-[13px] tabular-nums leading-none ${dim ? 'text-text-disabled' : 'text-text-secondary'}`}>
            FE
          </span>
          <span className={`ml-auto font-mono text-[13px] tabular-nums leading-none ${paused ? 'text-text-disabled' : valColor}`}>
            {paused ? '—' : rateStr}
          </span>
        </div>

      </div>
    </div>
  );
}

import {useMemo} from 'react';
import type {RateTimeframe} from '@/state/settingsStore';

interface TrackerRowProps {
  label:       string;
  valueFE:     number | null; // null = show "—"
  elapsedMs:   number | null; // null = show "--:--"
  rateTimeframe: RateTimeframe;
  accentColor?: string;       // Tailwind text color class, default 'text-text-primary'
  dim?:         boolean;      // true = row is inactive/placeholder
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
  if (value === null) return '— FE';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  return `${sign}${abs.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} FE`;
}

function formatRate(valueFE: number | null, elapsedMs: number | null, timeframe: RateTimeframe): string {
  const suffix = timeframe === 'hour' ? 'h' : 'm';
  if (valueFE === null || elapsedMs === null || elapsedMs < 1000) return `— FE/${suffix}`;
  const divisor = timeframe === 'hour' ? 3_600_000 : 60_000;
  const rate = valueFE / (elapsedMs / divisor);
  const abs = Math.abs(rate);
  const sign = rate < 0 ? '-' : '';
  return `${sign}${abs.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})} FE/${suffix}`;
}

export default function TrackerRow({label, valueFE, elapsedMs, rateTimeframe, accentColor = 'text-text-primary', dim = false}: TrackerRowProps) {
  // Truncate to whole seconds so the rate string only recalculates once per second
  const elapsedSec = elapsedMs !== null ? Math.floor(elapsedMs / 1000) * 1000 : null;
  const rateStr = useMemo(() => formatRate(valueFE, elapsedSec, rateTimeframe), [valueFE, elapsedSec, rateTimeframe]);

  return (
    <div className={`flex items-center h-8 gap-3 px-1 transition-opacity ${dim ? 'opacity-40' : ''}`}>
      {/* Label */}
      <span className={`text-sm font-semibold w-14 shrink-0 ${accentColor}`}>
        {label}
      </span>

      {/* FE value */}
      <span className={`font-mono text-sm tabular-nums flex-1 ${feColor(valueFE)}`}>
        {formatFE(valueFE)}
      </span>

      {/* FE rate */}
      <span className={`font-mono text-xs tabular-nums shrink-0 ${feColor(valueFE)}`}>
        {rateStr}
      </span>

      {/* Elapsed */}
      <span className={`font-mono text-sm tabular-nums shrink-0 ${elapsedMs === null ? 'text-text-disabled' : 'text-text-secondary'}`}>
        {elapsedMs === null ? '--:--:--' : formatElapsed(elapsedMs)}
      </span>
    </div>
  );
}

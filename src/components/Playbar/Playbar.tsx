import {useTranslation} from 'react-i18next';
import {Play, Pause, Square} from 'lucide-react';
import {useTracking} from '@/state/TrackingContext';
import {useEngineStore} from '@/state/engineStore';

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

export default function Playbar() {
  const {t} = useTranslation('playbar');
  const {status, elapsedMs, start, pause, resume, stop} = useTracking();
  const enginePhase       = useEngineStore(s => s.phase);
  const currentZone       = useEngineStore(s => s.currentZone);
  const mapCount          = useEngineStore(s => s.mapCount);
  const activeSessionName = useEngineStore(s => s.activeSessionName);

  function statusLabel(): string {
    if (status === 'idle')    return t('status.idle');
    if (status === 'paused')  return t('status.paused');
    if (enginePhase === 'initializing') return t('status.initializing');
    if (currentZone && mapCount > 0)    return `Map #${mapCount} — ${currentZone}`;
    if (currentZone)                    return currentZone;
    return t('status.running');
  }

  return (
    <div className="flex items-center justify-between h-16 px-6 bg-surface border-t border-border shrink-0">
      {/* Left: status */}
      <div className="flex-1 flex items-center gap-2 min-w-0">
        <span className="text-sm text-text-secondary truncate">{statusLabel()}</span>
        {status !== 'idle' && enginePhase === 'initializing' && (
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-gold/15 text-gold">
            Initializing
          </span>
        )}
        {activeSessionName && status !== 'idle' && (
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-accent/15 text-accent truncate max-w-[160px]" title={activeSessionName}>
            ↩ {activeSessionName}
          </span>
        )}
      </div>

      {/* Center: controls */}
      <div className="flex items-center gap-3">
        {status === 'idle' && (
          <button onClick={start} className="w-10 h-10 rounded-full bg-accent text-bg flex items-center justify-center hover:opacity-80 transition-opacity">
            <Play className="w-4 h-4 fill-current" />
          </button>
        )}
        {status === 'running' && (<>
          <button onClick={pause} className="w-10 h-10 rounded-full bg-surface-elevated text-text-primary flex items-center justify-center hover:opacity-80 transition-opacity">
            <Pause className="w-4 h-4" />
          </button>
          <button onClick={stop} className="w-9 h-9 rounded-full bg-danger text-white flex items-center justify-center hover:opacity-80 transition-opacity">
            <Square className="w-3.5 h-3.5 fill-current" />
          </button>
        </>)}
        {status === 'paused' && (<>
          <button onClick={resume} className="w-10 h-10 rounded-full bg-accent text-bg flex items-center justify-center hover:opacity-80 transition-opacity">
            <Play className="w-4 h-4 fill-current" />
          </button>
          <button onClick={stop} className="w-9 h-9 rounded-full bg-danger text-white flex items-center justify-center hover:opacity-80 transition-opacity">
            <Square className="w-3.5 h-3.5 fill-current" />
          </button>
        </>)}
      </div>

      {/* Right: timer */}
      <div className="flex-1 text-right font-mono text-sm font-semibold text-text-primary tabular-nums">
        {status !== 'idle' && formatElapsed(elapsedMs)}
      </div>
    </div>
  );
}

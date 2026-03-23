import {useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {PackageOpen, ChevronRight} from 'lucide-react';
import {useEngineStore} from '@/state/engineStore';
import {useItemsStore} from '@/state/itemsStore';
import {useSettingsStore} from '@/state/settingsStore';
import {useTrackerElapsed} from '@/hooks/useTrackerElapsed';
import {useAnimatedPresence} from '@/hooks/useAnimatedPresence';
import type {TrackerSnapshot} from '@/types/electron';
import TrackerRow from './TrackerRow';
import DropTable from './DropTable';

// -----------------------------------------------------------------------
// Total FE helper — sums qty * price for a drops record
// -----------------------------------------------------------------------

function useTotalFE(drops: Record<number, number>): number {
  const items = useItemsStore(s => s.items);
  return useMemo(() => {
    return Object.entries(drops).reduce((sum, [id, qty]) => {
      const price = items[id]?.price ?? 0;
      return sum + qty * price;
    }, 0);
  }, [drops, items]);
}

// -----------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------

export default function TrackerPanel() {
  const {t} = useTranslation('tracker');

  const enginePhase                = useEngineStore(s => s.phase);
  const sessionStatus              = useEngineStore(s => s.sessionStatus);
  const sessionElapsed             = useEngineStore(s => s.sessionElapsed);
  const sessionReceivedAt          = useEngineStore(s => s.sessionReceivedAt);
  const mapTracker                 = useEngineStore(s => s.mapTracker);
  const seasonalTracker            = useEngineStore(s => s.seasonalTracker);
  const sessionDrops               = useEngineStore(s => s.drops);
  const mapTrackerReceivedAt       = useEngineStore(s => s.mapTrackerReceivedAt);
  const seasonalTrackerReceivedAt  = useEngineStore(s => s.seasonalTrackerReceivedAt);
  const mapCount                   = useEngineStore(s => s.mapCount);
  const rateTimeframe              = useSettingsStore(s => s.rateTimeframe);

  // Keep last-seen snapshots alive for exit animations
  const lastMapRef      = useRef<TrackerSnapshot | null>(null);
  const lastSeasonalRef = useRef<TrackerSnapshot | null>(null);
  if (mapTracker)      lastMapRef.current      = mapTracker;
  if (seasonalTracker) lastSeasonalRef.current = seasonalTracker;

  // Elapsed extrapolation only makes sense when the engine is actively tracking
  const isRunning = sessionStatus === 'running' && enginePhase === 'tracking';

  // Animated presence for temporary trackers — hooks must run unconditionally
  const mapPresence      = useAnimatedPresence(mapTracker !== null);
  const seasonalPresence = useAnimatedPresence(seasonalTracker !== null);

  // Live elapsed for session, map, and seasonal
  const elapsedMs = useTrackerElapsed(sessionElapsed, sessionReceivedAt, isRunning);
  const mapElapsed = useTrackerElapsed(
    lastMapRef.current?.elapsed ?? 0,
    mapTrackerReceivedAt,
    isRunning,
  );
  const seasonalElapsed = useTrackerElapsed(
    lastSeasonalRef.current?.elapsed ?? 0,
    seasonalTrackerReceivedAt,
    isRunning,
  );

  // FE totals
  const sessionFE  = useTotalFE(sessionDrops);
  const mapFE      = useTotalFE(lastMapRef.current?.drops ?? {});
  const seasonalFE = useTotalFE(lastSeasonalRef.current?.drops ?? {});

  // Seasonal label — resolved inline to keep i18n types happy
  const seasonalType = lastSeasonalRef.current?.seasonalType;
  const seasonalLabel =
    seasonalType === 'dream'      ? t('seasonal.dream')      :
    seasonalType === 'vorex'      ? t('seasonal.vorex')      :
    seasonalType === 'overrealm'  ? t('seasonal.overrealm')  :
    '';

  // Drop table
  const [tableOpen, setTableOpen] = useState(false);
  const tableDrops = mapTracker ? (lastMapRef.current?.drops ?? {}) : sessionDrops;

  // All hooks above — safe to early-return now.
  // Show the initializing screen whenever the engine hasn't completed bag init yet.
  // This covers both 'idle' (overlay just opened, waiting for init_started) and
  // 'initializing' (init_started received, waiting for bag sort + init_complete).
  if (enginePhase !== 'tracking') {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center gap-2 px-4">
        <PackageOpen className="w-8 h-8 opacity-30 text-text-secondary" />
        <p className="text-sm text-text-secondary">{t('initializing')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Tracker rows */}
      <div className="flex flex-col gap-0.5">
        {/* Total — always visible */}
        <TrackerRow
          label={t('total')}
          valueFE={sessionFE}
          elapsedMs={elapsedMs}
          rateTimeframe={rateTimeframe}
          accentColor="text-accent"
        />

        {/* Map — always visible, dim when no map */}
        <TrackerRow
          label={`${t('map')}${mapCount > 0 ? ` #${mapCount}` : ''}`}
          valueFE={mapPresence.shouldRender ? mapFE : null}
          elapsedMs={mapPresence.shouldRender ? mapElapsed : null}
          rateTimeframe={rateTimeframe}
          accentColor="text-success"
          dim={!mapPresence.shouldRender}
        />

        {/* Seasonal temp row — animated */}
        {seasonalPresence.shouldRender && (
          <div className={seasonalPresence.animClass}>
            <TrackerRow
              label={seasonalLabel}
              valueFE={seasonalFE}
              elapsedMs={seasonalElapsed}
              rateTimeframe={rateTimeframe}
              accentColor="text-gold"
            />
          </div>
        )}
      </div>

      {/* Chevron divider */}
      <button
        onClick={() => setTableOpen(o => !o)}
        className="flex items-center justify-end w-full py-0.5 px-1 mt-1 transition-colors"
        title={tableOpen ? 'Hide drops' : 'Show drops'}
      >
        <ChevronRight className={`w-4 h-4 text-text-secondary transition-transform duration-200 ${tableOpen ? 'rotate-90' : ''}`} />
      </button>

      {/* Drop table — collapsible */}
      {tableOpen && (
        <div className="flex-1 overflow-y-auto mt-1 min-h-0">
          <DropTable drops={tableDrops} />
        </div>
      )}
    </div>
  );
}

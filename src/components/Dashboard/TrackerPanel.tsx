import {useMemo, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {PackageOpen, ChevronDown} from 'lucide-react';
import {useEngineStore} from '@/state/engineStore';
import {useItemsStore} from '@/state/itemsStore';
import {useSettingsStore} from '@/state/settingsStore';
import {useTrackerElapsed} from '@/hooks/useTrackerElapsed';
import {useAnimatedPresence} from '@/hooks/useAnimatedPresence';
import type {TrackerSnapshot} from '@/types/electron';
import TrackerRow from './TrackerRow';
import DropTable from './DropTable';
import LowStockWarningRow from './LowStockWarningRow';

// -----------------------------------------------------------------------
// Total FE helper
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

  const enginePhase               = useEngineStore(s => s.phase);
  const sessionStatus             = useEngineStore(s => s.sessionStatus);
  const sessionElapsed            = useEngineStore(s => s.sessionElapsed);
  const sessionReceivedAt         = useEngineStore(s => s.sessionReceivedAt);
  const mapTracker                = useEngineStore(s => s.mapTracker);
  const seasonalTracker           = useEngineStore(s => s.seasonalTracker);
  const sessionDrops              = useEngineStore(s => s.drops);
  const mapTrackerReceivedAt      = useEngineStore(s => s.mapTrackerReceivedAt);
  const seasonalTrackerReceivedAt = useEngineStore(s => s.seasonalTrackerReceivedAt);
  const mapCount                  = useEngineStore(s => s.mapCount);
  const lowStockWarnings          = useEngineStore(s => s.lowStockWarnings);
  const dismissedMaterials        = useEngineStore(s => s.dismissedMaterials);
  const rateTimeframe             = useSettingsStore(s => s.rateTimeframe);

  const visibleWarnings = useMemo(
    () => lowStockWarnings.filter(w => !dismissedMaterials.has(w.itemId)),
    [lowStockWarnings, dismissedMaterials],
  );

  // Keep last-seen snapshots alive for exit animations
  const lastMapRef      = useRef<TrackerSnapshot | null>(null);
  const lastSeasonalRef = useRef<TrackerSnapshot | null>(null);
  if (mapTracker)      lastMapRef.current      = mapTracker;
  if (seasonalTracker) lastSeasonalRef.current = seasonalTracker;

  const isRunning = sessionStatus === 'running' && enginePhase === 'tracking';
  const isPaused  = sessionStatus === 'paused'  && enginePhase === 'tracking';

  const mapPresence      = useAnimatedPresence(mapTracker !== null);
  const seasonalPresence = useAnimatedPresence(seasonalTracker !== null);
  const warningPresence  = useAnimatedPresence(visibleWarnings.length > 0);

  const elapsedMs      = useTrackerElapsed(sessionElapsed, sessionReceivedAt, isRunning);
  const mapElapsed     = useTrackerElapsed(lastMapRef.current?.elapsed ?? 0, mapTrackerReceivedAt, isRunning);
  const seasonalElapsed= useTrackerElapsed(lastSeasonalRef.current?.elapsed ?? 0, seasonalTrackerReceivedAt, isRunning);

  const sessionFE  = useTotalFE(sessionDrops);
  const mapFE      = useTotalFE(lastMapRef.current?.drops ?? {});
  const seasonalFE = useTotalFE(lastSeasonalRef.current?.drops ?? {});

  const seasonalType  = lastSeasonalRef.current?.seasonalType;
  const seasonalLabel =
    seasonalType === 'dream'     ? t('seasonal.dream')     :
    seasonalType === 'vorex'     ? t('seasonal.vorex')     :
    seasonalType === 'overrealm' ? t('seasonal.overrealm') :
    seasonalType === 'carjack'   ? t('seasonal.carjack')   :
    seasonalType === 'clockwork' ? t('seasonal.clockwork') :
    '';

  const [tableOpen, setTableOpen] = useState(false);
  const tableDrops = mapTracker ? (lastMapRef.current?.drops ?? {}) : sessionDrops;

  if (enginePhase !== 'tracking') {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-5">
        <PackageOpen className="w-7 h-7 opacity-25 text-text-secondary" />
        <p className="text-xs text-text-secondary">{t('initializing')}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Cards */}
      <div className="flex flex-col gap-2 px-2.5 pt-2.5 pb-1">

        {/* Total — always visible */}
        <TrackerRow
          label={t('total')}
          valueFE={sessionFE}
          elapsedMs={elapsedMs}
          rateTimeframe={rateTimeframe}
          accentClass="bg-accent"
          badge={mapCount > 0 ? `#${mapCount}` : undefined}
          paused={isPaused}
        />

        {/* Map — always rendered, dim when no active map */}
        <TrackerRow
          label={t('map')}
          valueFE={mapPresence.shouldRender ? mapFE : null}
          elapsedMs={mapPresence.shouldRender ? mapElapsed : null}
          rateTimeframe={rateTimeframe}
          accentClass="bg-success"
          dim={!mapPresence.shouldRender}
          paused={isPaused && mapPresence.shouldRender}
        />

        {/* Seasonal — animated enter/exit */}
        {seasonalPresence.shouldRender && (
          <div className={seasonalPresence.animClass}>
            <TrackerRow
              label={seasonalLabel}
              valueFE={seasonalFE}
              elapsedMs={seasonalElapsed}
              rateTimeframe={rateTimeframe}
              accentClass="bg-gold"
              paused={isPaused}
            />
          </div>
        )}

        {/* Low-stock map-material warning — fourth row, animated enter/exit */}
        {warningPresence.shouldRender && (
          <div className={warningPresence.animClass}>
            <LowStockWarningRow warnings={visibleWarnings} />
          </div>
        )}
      </div>

      {/* Drop table toggle */}
      <button
        onClick={() => setTableOpen(o => !o)}
        className="flex items-center justify-center w-full py-0.5 gap-1 text-text-disabled hover:text-text-secondary transition-colors"
        title={tableOpen ? 'Hide drops' : 'Show drops'}
      >
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform duration-200 ${tableOpen ? 'rotate-180' : ''}`}
        />
        <span className="text-[10px] font-semibold uppercase tracking-wider">
          {tableOpen ? t('hideDrops', 'Hide drops') : t('showDrops', 'Show drops')}
        </span>
      </button>

      {/* Drop table */}
      {tableOpen && (
        <div className="border-t border-border mx-2.5 mb-2.5 pt-2 overflow-y-auto max-h-72">
          <DropTable drops={tableDrops} />
        </div>
      )}
    </div>
  );
}

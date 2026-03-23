import {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useSessionsStore} from '@/state/sessionsStore';
import {useEngineStore} from '@/state/engineStore';
import {useItemsStore} from '@/state/itemsStore';
import {useTracking} from '@/state/TrackingContext';
import type {NavItemId} from '@/components/Sidebar/Sidebar';
import SessionsTable, {formatDate, formatDuration, formatIncome} from './SessionsTable';

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

interface DetailPanelProps {
  sessionId:   string | null;
  onNavChange: (id: NavItemId) => void;
}

function DetailPanel({sessionId, onNavChange, itemPrices}: DetailPanelProps & {itemPrices: Record<string, number>}) {
  const {t}            = useTranslation('sessions');
  const sessions       = useSessionsStore(s => s.sessions);
  const deleteSession  = useSessionsStore(s => s.deleteSession);
  const renameSession  = useSessionsStore(s => s.renameSession);
  const select         = useSessionsStore(s => s.select);
  const {continueSession, status} = useTracking();

  const session = sessions.find(s => s.id === sessionId) ?? null;

  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-text-disabled px-6 text-center">
        {t('details.selectPrompt')}
      </div>
    );
  }

  const income = Object.entries(session.drops).reduce((sum, [id, qty]) => {
    return sum + qty * (itemPrices[id] ?? 0);
  }, 0);
  const uniqueItems = Object.keys(session.drops).length;

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
      select(null);
    }
  }

  const isTracking = status !== 'idle';

  return (
    <div className="flex flex-col h-full p-5 gap-4">
      <h3 className="text-sm font-bold text-text-primary">{t('details.heading')}</h3>

      {/* Session name */}
      <div className="text-base font-semibold text-text-primary truncate" title={session.name}>
        {session.name}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
        <StatRow label={t('details.saved')}>
          {formatDate(session.savedAt)}
        </StatRow>
        <StatRow label={t('details.totalTime')}>
          {formatDuration(session.totalTime)}
        </StatRow>
        <StatRow label={t('details.mapTime')}>
          {formatDuration(session.mapTime)}
        </StatRow>
        <StatRow label={t('details.mapsRun')}>
          {session.mapCount}
        </StatRow>
        <StatRow label={t('details.uniqueItems')}>
          {uniqueItems}
        </StatRow>
        <StatRow label={t('details.income')}>
          <span className="text-accent font-semibold">{formatIncome(income)}</span>
        </StatRow>
      </div>

      <div className="mt-auto flex flex-col gap-2">
        {/* Continue — disabled while tracking */}
        <button
          onClick={handleContinue}
          disabled={isTracking}
          className="w-full px-3 py-2 rounded-md text-sm font-semibold bg-accent text-bg hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t('actions.continue')}
        </button>

        <div className="flex gap-2">
          <button
            onClick={handleRename}
            className="flex-1 px-3 py-1.5 rounded-md text-xs font-medium bg-surface-elevated text-text-primary hover:bg-white/10 transition-colors"
          >
            {t('actions.rename')}
          </button>
          <button
            onClick={handleDelete}
            className="flex-1 px-3 py-1.5 rounded-md text-xs font-medium bg-danger/15 text-danger hover:bg-danger/25 transition-colors"
          >
            {t('actions.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatRow({label, children}: {label: string; children: React.ReactNode}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-text-disabled uppercase tracking-wide text-[10px] font-semibold">{label}</span>
      <span className="text-text-primary">{children}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

interface Props {
  onNavChange: (id: NavItemId) => void;
}

export default function SessionsScreen({onNavChange}: Props) {
  const {t}          = useTranslation('sessions');
  const sessions     = useSessionsStore(s => s.sessions);
  const isLoaded     = useSessionsStore(s => s.isLoaded);
  const selectedId   = useSessionsStore(s => s.selectedId);
  const select       = useSessionsStore(s => s.select);
  const refresh      = useSessionsStore(s => s.refresh);
  const lastSavedId  = useEngineStore(s => s.lastSavedSessionId);
  const items        = useItemsStore(s => s.items);

  // Track whether the panel has ever been open so we don't animate on first mount
  const [panelMounted, setPanelMounted] = useState(!!selectedId);

  const itemPrices = useMemo(
    () => Object.fromEntries(Object.entries(items).map(([id, item]) => [id, item.price])),
    [items],
  );

  // Load sessions on first mount
  useEffect(() => {
    if (!isLoaded) useSessionsStore.getState().load();
  }, [isLoaded]);

  // Refresh whenever the engine saves a new session
  useEffect(() => {
    if (lastSavedId) refresh();
  }, [lastSavedId, refresh]);

  // Mount the panel on first selection so subsequent transitions animate
  useEffect(() => {
    if (selectedId) setPanelMounted(true);
  }, [selectedId]);

  const panelOpen = !!selectedId;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-5 border-b border-border shrink-0">
        <h1 className="text-2xl font-bold text-text-primary">{t('title')}</h1>
      </div>

      {/* Body: table + detail panel */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: sessions table */}
        <div className="flex flex-col flex-1 overflow-hidden">
          {!isLoaded ? (
            <div className="flex items-center justify-center flex-1 text-sm text-text-disabled">
              Loading…
            </div>
          ) : (
            <SessionsTable
              sessions={sessions}
              selectedId={selectedId}
              itemPrices={itemPrices}
              onSelect={select}
            />
          )}
        </div>

        {/* Right: detail panel — slides in when a session is selected */}
        {panelMounted && (
          <div
            className={[
              'shrink-0 bg-surface border-l border-border overflow-hidden',
              'transition-[width,opacity] duration-300 ease-in-out',
              panelOpen ? 'w-72 opacity-100' : 'w-0 opacity-0',
            ].join(' ')}
          >
            <div className="w-72 h-full">
              <DetailPanel sessionId={selectedId} onNavChange={onNavChange} itemPrices={itemPrices} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

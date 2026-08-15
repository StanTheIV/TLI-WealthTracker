import {useEffect, useMemo, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ArrowLeft, Clock} from 'lucide-react';
import {useSessionsStore} from '@/state/sessionsStore';
import {useItemsStore} from '@/state/itemsStore';
import {useTaxConfig} from '@/state/settingsStore';
import {useTracking} from '@/state/TrackingContext';
import type {DbSessionMap} from '@/types/electron';
import type {NavItemId} from '@/components/Sidebar/Sidebar';
import {computeSessionAnalytics} from './analytics';
import {formatDate} from './SessionsTable';
import {Section} from './detail/primitives';
import type {ValueMode} from './detail/format';
import StatTiles from './detail/StatTiles';
import MechanicTable from './detail/MechanicTable';
import TimeValueBars from './detail/TimeValueBars';
import SessionTimeline from './detail/SessionTimeline';
import RunLog from './detail/RunLog';
import DataNotes from './detail/DataNotes';
import {ConsistencyPanel, CostPanel} from './detail/ConsistencyPanel';
import {DroppedTable, ConsumedTable} from './detail/ItemTables';
import {BySourceDonut, ByTypeDonut, PerMapChart} from './detail/Charts';

type ItemTab = 'dropped' | 'consumed' | 'byType' | 'bySource';

interface Props {
  sessionId:   string;
  onBack:      () => void;
  onNavChange: (id: NavItemId) => void;
}

export default function SessionDetail({sessionId, onBack, onNavChange}: Props) {
  const {t}           = useTranslation('sessions');
  const sessions      = useSessionsStore(s => s.sessions);
  const deleteSession = useSessionsStore(s => s.deleteSession);
  const renameSession = useSessionsStore(s => s.renameSession);
  const items         = useItemsStore(s => s.items);
  const tax           = useTaxConfig();
  const {continueSession, status} = useTracking();

  const [maps, setMaps]             = useState<DbSessionMap[]>([]);
  const [mapsLoaded, setMapsLoaded] = useState(false);
  const [itemTab, setItemTab]       = useState<ItemTab>('dropped');
  // Default to the prices captured at save: a past session's value is what it
  // was worth then, not what today's market would pay for the same drops.
  const [mode, setMode]             = useState<ValueMode>('snapshot');
  const [renaming, setRenaming]     = useState(false);
  const [draftName, setDraftName]   = useState('');

  const session = sessions.find(s => s.id === sessionId);

  useEffect(() => {
    let cancelled = false;
    setMapsLoaded(false);
    // Clear stale rows too: analytics over the PREVIOUS session's rows would
    // render wrong figures and spurious warnings until the load resolves.
    setMaps([]);
    window.electronAPI.db.sessionMaps.getForSession(sessionId).then(rows => {
      if (cancelled) return;
      setMaps(rows);
      setMapsLoaded(true);
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  const analytics = useMemo(
    () => (session && mapsLoaded ? computeSessionAnalytics({session, maps, items, tax}) : null),
    [session, maps, items, mapsLoaded, tax],
  );

  // Rows still loading: render the frame only. Computing over an empty `maps`
  // would flash wrong figures and spurious warnings before snapping to real data.
  const loading = session !== undefined && !analytics;
  if (loading) {
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
        <div className="flex-1" />
      </div>
    );
  }

  if (!session || !analytics) {
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
  const {hasSnapshot} = analytics.meta;
  // Dual columns only mean something when the two legs can differ.
  const showBoth = hasSnapshot;

  function handleContinue() {
    continueSession(session!.id);
    onNavChange('dashboard');
  }

  // Renaming is inline rather than a prompt(): Electron renderers ignore
  // window.prompt() entirely, so the old handler silently did nothing.
  function startRename() {
    setDraftName(session!.name);
    setRenaming(true);
  }

  function commitRename() {
    const next = draftName.trim();
    if (next && next !== session!.name) renameSession(session!.id, next);
    setRenaming(false);
  }

  function handleDelete() {
    if (window.confirm(t('actions.confirmDelete', {name: session!.name}))) {
      deleteSession(session!.id);
      onBack();
    }
  }

  const tabs: {id: ItemTab; label: string}[] = [
    {id: 'dropped',  label: `${t('details.droppedTab')} · ${analytics.dropped.length}`},
    {id: 'consumed', label: `${t('details.consumedTab')} · ${analytics.consumed.length}`},
    {id: 'byType',   label: t('details.byTypeTab')},
    {id: 'bySource', label: t('details.bySourceTab')},
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-4 border-b border-border shrink-0 flex items-center justify-between gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors shrink-0"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('details.back')}
        </button>
        {renaming ? (
          <input
            autoFocus
            value={draftName}
            onChange={e => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter')  commitRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            className="flex-1 min-w-0 text-lg font-bold bg-surface-elevated text-text-primary rounded-md px-2 py-0.5 border border-accent outline-none"
          />
        ) : (
          <h1
            onDoubleClick={startRename}
            className="flex-1 min-w-0 text-lg font-bold text-text-primary truncate cursor-text"
            title={session.name}
          >
            {session.name}
          </h1>
        )}
        <div className="flex gap-2 shrink-0">
          <button
            onClick={handleContinue}
            disabled={isTracking}
            className="px-3 py-1.5 rounded-md text-xs font-semibold bg-accent text-bg hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('actions.continue')}
          </button>
          <button
            onClick={startRename}
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

      <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-6">
        <DataNotes warnings={analytics.meta.warnings} />

        <Section
          title={t('details.summary')}
          hint={t('details.summaryMeta', {maps: session.mapCount, date: formatDate(session.savedAt)})}
          right={
            hasSnapshot ? (
              <div className="flex items-center gap-1.5">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-gold border border-gold/35 bg-gold/10 rounded px-2 py-0.5">
                  <Clock className="w-3 h-3" />
                  {t('details.snapshotBadge')}
                </span>
                <div className="flex rounded overflow-hidden border border-border">
                  {(['snapshot', 'live'] as ValueMode[]).map(m => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className={`px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                        mode === m ? 'bg-accent text-bg' : 'bg-surface text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {m === 'snapshot' ? t('details.atSave') : t('details.now')}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <span className="text-[10px] text-text-disabled">{t('details.noSnapshot')}</span>
            )
          }
        >
          <StatTiles analytics={analytics} mode={mode} />
        </Section>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
          <div className="xl:col-span-2">
            <Section title={t('details.mechanicsTitle')} hint={t('details.mechanicsHint')}>
              <MechanicTable analytics={analytics} mode={mode} />
            </Section>
          </div>
          <Section title={t('details.allocTitle')} hint={t('details.allocHint')}>
            <TimeValueBars analytics={analytics} mode={mode} />
          </Section>
        </div>

        {!analytics.meta.noMapRows && (
          <Section title={t('details.timelineTitle')} hint={t('details.timelineHint')}>
            <SessionTimeline analytics={analytics} mode={mode} />
          </Section>
        )}

        <Section title={t('details.itemsTitle')} hint={t('details.itemsHint')}>
          <div className="bg-surface border border-border rounded-lg p-4">
            <div className="flex gap-0.5 border-b border-border mb-3 -mt-1">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setItemTab(tab.id)}
                  aria-selected={itemTab === tab.id}
                  className={`px-3.5 py-2 text-xs font-semibold border-b-2 -mb-px transition-colors ${
                    itemTab === tab.id
                      ? 'text-accent border-accent'
                      : 'text-text-secondary border-transparent hover:text-text-primary'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {itemTab === 'dropped'  && <DroppedTable analytics={analytics} mode={mode} showBoth={showBoth} />}
            {itemTab === 'consumed' && <ConsumedTable analytics={analytics} mode={mode} showBoth={showBoth} />}
            {itemTab === 'byType'   && <ByTypeDonut analytics={analytics} mode={mode} />}
            {itemTab === 'bySource' && <BySourceDonut analytics={analytics} mode={mode} />}
          </div>
        </Section>

        {!analytics.meta.noMapRows && (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
            <Section title={t('details.consistencyTitle')} hint={t('details.consistencyHint')}>
              <ConsistencyPanel analytics={analytics} mode={mode} />
            </Section>
            <div className="xl:col-span-2">
              <Section title={t('details.runLogTitle')} hint={t('details.runLogHint')}>
                <RunLog analytics={analytics} mode={mode} />
              </Section>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
          <div className="xl:col-span-2">
            <Section title={t('details.perMapTitle')}>
              {mapsLoaded ? <PerMapChart analytics={analytics} mode={mode} /> : <div className="h-[300px]" />}
            </Section>
          </div>
          <Section title={t('details.costTitle')}>
            <CostPanel analytics={analytics} mode={mode} />
          </Section>
        </div>
      </div>
    </div>
  );
}

import {useEffect, useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {useSessionsStore} from '@/state/sessionsStore';
import {useEngineStore} from '@/state/engineStore';
import {useItemsStore} from '@/state/itemsStore';
import type {NavItemId} from '@/components/Sidebar/Sidebar';
import SessionsTable from './SessionsTable';
import SessionDetail from './SessionDetail';

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

  // Detail view — full-screen swap with back button.
  if (selectedId) {
    return (
      <SessionDetail
        sessionId={selectedId}
        onBack={() => select(null)}
        onNavChange={onNavChange}
      />
    );
  }

  // List view
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-6 py-5 border-b border-border shrink-0">
        <h1 className="text-2xl font-bold text-text-primary">{t('title')}</h1>
      </div>

      <div className="flex flex-col flex-1 overflow-hidden">
        {!isLoaded ? (
          <div className="flex items-center justify-center flex-1 text-sm text-text-disabled">
            Loading…
          </div>
        ) : (
          <SessionsTable
            sessions={sessions}
            selectedId={null}
            itemPrices={itemPrices}
            onSelect={select}
          />
        )}
      </div>
    </div>
  );
}

import {useEffect, useRef} from 'react';
import {useTranslation} from 'react-i18next';
import type {TFunction} from 'i18next';
import {useEngineStore, type FeedEvent} from '@/state/engineStore';
import {useItemsStore} from '@/state/itemsStore';
import type {DbItem} from '@/types/electron';

// ---------------------------------------------------------------------------
// Per-event rendering
// ---------------------------------------------------------------------------

function eventColor(type: string): string {
  switch (type) {
    case 'init_started':      return 'text-text-secondary';
    case 'init_complete':     return 'text-accent';
    case 'drop':              return 'text-gold';
    case 'new_item':          return 'text-gold';
    case 'zone_change':       return 'text-text-primary';
    case 'map_started':       return 'text-success';
    case 'map_ended':         return 'text-text-secondary';
    case 'tracker_started':   return 'text-success';
    case 'tracker_finished':  return 'text-text-secondary';
    case 'loot_window_started': return 'text-accent';
    case 'loot_window_ended':   return 'text-text-secondary';
    case 'map_material_warning': return 'text-danger';
    case 'error':             return 'text-danger';
    default:                  return 'text-text-secondary';
  }
}

/** Short badge label for an event type. Known types are localized; unknown
 *  types fall back to the raw (upper-cased) type string so new engine events
 *  render harmlessly instead of crashing the feed. */
function eventLabel(type: string, t: TFunction<'dashboard'>): string {
  const key = `feed.label.${type}`;
  const label = t(key, {defaultValue: ''});
  return label || type.toUpperCase();
}

function eventDescription(fe: FeedEvent, items: Record<string, DbItem>, t: TFunction<'dashboard'>): string {
  const e = fe.event;
  switch (e.type) {
    case 'init_started':
      return t('feed.desc.initStarted');
    case 'init_complete':
      return t('feed.desc.initComplete', {count: e.itemCount});
    case 'new_item': {
      const label = items[String(e.itemId)]?.name || t('feed.item', {id: e.itemId});
      return t('feed.desc.newItem', {label});
    }
    case 'drop': {
      const label = items[String(e.itemId)]?.name || t('feed.item', {id: e.itemId});
      return `${label}  ${e.change > 0 ? '+' : ''}${e.change}`;
    }
    case 'zone_change':
      return `${e.from}  →  ${e.to}`;
    case 'map_started':
      return t('feed.desc.mapStarted', {count: e.mapCount});
    case 'map_ended':
      return t('feed.desc.mapEnded', {seconds: (e.elapsed / 1000).toFixed(1)});
    case 'tracker_started':
      return t('feed.desc.trackerStarted', {kind: e.tracker.seasonalType ?? e.tracker.kind});
    case 'tracker_finished':
      return t('feed.desc.trackerFinished', {kind: e.tracker.seasonalType ?? e.tracker.kind});
    case 'loot_window_started':
      return t('feed.desc.lootWindowStarted', {kind: e.seasonalType ?? '?'});
    case 'loot_window_ended':
      return t('feed.desc.lootWindowEnded', {kind: e.seasonalType ?? '?'});
    case 'map_material_warning':
      return t('feed.desc.mapMaterialWarning', {count: e.items.length});
    case 'error':
      return e.message;
    default:
      return '';
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function EventFeed() {
  const {t} = useTranslation('dashboard');
  const feed  = useEngineStore(s => s.feed);
  const items = useItemsStore(s => s.items);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new events
  useEffect(() => {
    bottomRef.current?.scrollIntoView({behavior: 'smooth'});
  }, [feed.length]);

  return (
    <div className="flex flex-col h-full">
      <h2 className="text-[11px] font-semibold text-text-secondary uppercase tracking-widest mb-3">
        {t('feed.title')}
      </h2>

      <div className="flex-1 overflow-y-auto bg-bg rounded-lg border border-border font-mono text-xs">
        {feed.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-disabled">
            {t('feed.empty')}
          </div>
        ) : (
          <div className="p-2 space-y-0.5">
            {feed.map(fe => (
              <div key={fe.id} className="flex items-baseline gap-2 hover:bg-white/3 rounded px-1 py-0.5">
                <span className="text-text-disabled shrink-0 w-16">{formatTime(fe.timestamp)}</span>
                <span className={`shrink-0 w-10 font-bold ${eventColor(fe.event.type)}`}>
                  {eventLabel(fe.event.type, t)}
                </span>
                <span className={`flex-1 truncate ${eventColor(fe.event.type)}`}>
                  {eventDescription(fe, items, t)}
                </span>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </div>
  );
}

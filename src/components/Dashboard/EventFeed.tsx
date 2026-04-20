import {useEffect, useRef} from 'react';
import {useEngineStore, type FeedEvent} from '@/state/engineStore';
import {useItemsStore} from '@/state/itemsStore';
import type {DbItem} from '@/types/electron';

// ---------------------------------------------------------------------------
// Per-event rendering
// ---------------------------------------------------------------------------

function eventColor(type: string): string {
  switch (type) {
    case 'init_started':  return 'text-text-secondary';
    case 'init_complete': return 'text-accent';
    case 'drop':          return 'text-gold';
    case 'zone_change':   return 'text-text-primary';
    case 'map_started':   return 'text-success';
    case 'map_ended':     return 'text-text-secondary';
    case 'error':         return 'text-danger';
    default:              return 'text-text-secondary';
  }
}

function eventLabel(type: string): string {
  switch (type) {
    case 'init_started':  return 'INIT';
    case 'init_complete': return 'READY';
    case 'drop':          return 'DROP';
    case 'zone_change':   return 'ZONE';
    case 'map_started':   return 'MAP';
    case 'map_ended':     return 'END';
    case 'error':         return 'ERR';
    default:              return type.toUpperCase();
  }
}

function eventDescription(fe: FeedEvent, items: Record<string, DbItem>): string {
  const e = fe.event;
  switch (e.type) {
    case 'init_started':  return 'Bag initialization started…';
    case 'init_complete': return `Bag ready — ${e.itemCount} item types tracked`;
    case 'drop': {
      const label = items[String(e.itemId)]?.name || `Item #${e.itemId}`;
      return `${label}  ${e.change > 0 ? '+' : ''}${e.change}`;
    }
    case 'zone_change':   return `${e.from}  →  ${e.to}`;
    case 'map_started':   return `Map #${e.mapCount} started`;
    case 'map_ended':     return `Map ended — ${(e.elapsed / 1000).toFixed(1)}s`;
    case 'error':         return e.message;
    default:              return '';
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
        Live Event Feed
      </h2>

      <div className="flex-1 overflow-y-auto bg-bg rounded-lg border border-border font-mono text-xs">
        {feed.length === 0 ? (
          <div className="flex items-center justify-center h-full text-text-disabled">
            Start tracking to see events
          </div>
        ) : (
          <div className="p-2 space-y-0.5">
            {feed.map(fe => (
              <div key={fe.id} className="flex items-baseline gap-2 hover:bg-white/3 rounded px-1 py-0.5">
                <span className="text-text-disabled shrink-0 w-16">{formatTime(fe.timestamp)}</span>
                <span className={`shrink-0 w-10 font-bold ${eventColor(fe.event.type)}`}>
                  {eventLabel(fe.event.type)}
                </span>
                <span className={`flex-1 truncate ${eventColor(fe.event.type)}`}>
                  {eventDescription(fe, items)}
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

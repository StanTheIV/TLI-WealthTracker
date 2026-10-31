import type {SqliteSessionStore} from './db/session-store';
import type {Logger} from './logger';
import {isEmptyRun} from './session-persistence';

/**
 * Startup crash-close. A session still open (`ended_at` NULL) at launch
 * belongs to a run that never reached Stop — the app died or the OS ended the
 * session. Its last unit write is all there is: an empty run (the Stop rule)
 * is deleted, any other is closed at that write (`saved_at`, bumped on every
 * write). Call after the schema is current and before any tracking starts.
 * One transaction: a crash mid-recovery leaves every session as it was.
 */
export function closeCrashedSessions(store: SqliteSessionStore, log: Pick<Logger, 'info' | 'warn'>): void {
  const open = store.listOpenSessions();
  if (open.length === 0) return;

  let deleted = 0;
  store.transaction(() => {
    for (const s of open) {
      if (isEmptyRun({elapsedMs: s.totalTime * 1000, drops: s.drops, spent: s.spent, hasRows: store.hasRows(s.id)})) {
        store.deleteSession(s.id);
        deleted++;
        continue;
      }
      let endedAt = Date.parse(s.savedAt);
      if (Number.isNaN(endedAt)) {
        // The app always writes ISO; fall back as migration v4 does (last row end, else 0)
        // — left NULL it would read as live forever.
        endedAt = Math.max(0, ...store.getRows(s.id).map(r => r.endedAt));
        log.warn('session', `Crash-close: id=${s.id} has an unparsable saved_at "${s.savedAt}", closed at ${endedAt}`);
      }
      store.closeSession(s.id, endedAt);
    }
  });
  log.info('session', `Crash-close: ${open.length - deleted} open session(s) closed, ${deleted} empty one(s) deleted`);
}

import {useSyncExternalStore} from 'react';
import {getSnapshot, subscribe} from '@/state/clock';

const subscribeNone = () => () => undefined;

/**
 * The shared display clock's `now` (4 Hz). When `enabled` is false nothing is
 * subscribed — a paused or idle row keeps no timer alive and never re-renders
 * on a tick.
 */
export function useNow(enabled: boolean): number {
  return useSyncExternalStore(enabled ? subscribe : subscribeNone, getSnapshot);
}

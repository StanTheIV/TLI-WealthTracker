import {withGlobal} from '@sinonjs/fake-timers';

/**
 * Virtual time for a replay. The engine reads `Date.now()` and schedules
 * `setTimeout` debounces; installing global fake timers makes both follow log
 * time instead of wall time, so a 300 ms resort debounce means 300 ms *of log*.
 *
 * A replay owns the globals while it runs. Installing on top of other fake
 * timers (e.g. `vi.useFakeTimers()`) throws — fake-timers refuses a double
 * install — rather than letting two clocks fight over `setTimeout`.
 */
export interface ReplayClock {
  /** Move time forward to `ts`, firing every timer due on the way. Never moves back. */
  advanceTo(ts: number): void;
  dispose(): void;
}

export function installReplayClock(startTs: number): ReplayClock {
  const clock = withGlobal(globalThis).install({
    now:    startTs,
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  return {
    advanceTo: (ts) => { if (ts > clock.now) clock.tick(ts - clock.now); },
    dispose:   () => clock.uninstall(),
  };
}

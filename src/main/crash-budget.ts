export type CrashVerdict = 'reload' | 'give-up' | 'ignore';

export interface CrashBudgetOptions {
  /** Reloads allowed within any `windowMs` span. */
  max:      number;
  windowMs: number;
  now:      () => number;
}

export interface CrashBudget {
  /** A renderer's `render-process-gone` reason → what to do with its window. */
  onGone(reason: string): CrashVerdict;
}

/** Reasons that are not a crash: the renderer exited normally or was killed on purpose. */
const NOT_A_CRASH: ReadonlySet<string> = new Set(['clean-exit', 'killed']);

/**
 * One window's renderer-crash budget: a crash reloads it, unless `max` reloads
 * already happened within the last `windowMs` (sliding) — then give up, so a
 * renderer that crashes on load can't spin.
 */
export function createCrashBudget({max, windowMs, now}: CrashBudgetOptions): CrashBudget {
  const reloads: number[] = [];
  return {
    onGone(reason) {
      if (NOT_A_CRASH.has(reason)) return 'ignore';
      const t = now();
      while (reloads.length > 0 && t - reloads[0] >= windowMs) reloads.shift();
      if (reloads.length >= max) return 'give-up';
      reloads.push(t);
      return 'reload';
    },
  };
}

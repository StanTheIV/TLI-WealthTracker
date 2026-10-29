import type {Logger} from './logger';
import {describeError} from '@/shared/describe-error';

export interface ShutdownStep {
  name: string;
  run(): void;
}

/**
 * Run every shutdown step in order, each isolated: a throwing step is logged
 * (with its name) and the rest still run. Never throws — a failed bounds write
 * must not skip closing the active session.
 */
export function runShutdownSteps(steps: readonly ShutdownStep[], log: Pick<Logger, 'error'>): void {
  for (const step of steps) {
    try {
      step.run();
    } catch (err) {
      log.error('app', `Shutdown step '${step.name}' failed: ${describeError(err)}`);
    }
  }
}

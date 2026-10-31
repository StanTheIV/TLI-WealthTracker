import type {RawEvent} from '@/worker/processors/types';

type WorkerLogType = Extract<RawEvent, {type: 'worker_log'}>['logType'];

const LOG_TYPES: ReadonlySet<string> = new Set<WorkerLogType>(['info', 'warn', 'error', 'debug']);

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * Validate a message the log-reader utility process posted. The structured
 * clone delivers plain data, but its shape is only the worker's word — so it
 * is checked here, once, before main acts on it. Null unless it is an object
 * with a string `type`; then the fields main itself reads: `worker_log` an
 * OWN `logType` among the logger's levels (WorkerProcess indexes `log` with
 * it — an inherited key such as `constructor` must never pass) and a string
 * `message`, `reader_error` a string `message`. Every other type passes as the
 * processors (same build) typed it; the engine's handlers read those.
 */
export function parseWorkerMessage(raw: unknown): RawEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const msg = raw as Record<string, unknown>;
  if (typeof msg.type !== 'string') return null;

  if (msg.type === 'worker_log') {
    if (!hasOwn(msg, 'logType') || typeof msg.logType !== 'string' || !LOG_TYPES.has(msg.logType)) return null;
    if (typeof msg.message !== 'string') return null;
  } else if (msg.type === 'reader_error') {
    if (typeof msg.message !== 'string') return null;
  }
  return msg as unknown as RawEvent;
}

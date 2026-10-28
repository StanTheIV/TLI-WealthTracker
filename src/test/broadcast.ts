/**
 * Readers for what a test's `Broadcast` recorder captured. Every
 * `engine:event` payload must be an EngineEnvelope — anything else throws, so
 * an assertion over the unwrapped events can never pass vacuously on a payload
 * of the wrong shape.
 */
import type {EngineEnvelope, EngineEvent} from '@/shared/contracts/engine';

export interface Sent { channel: string; payload: unknown }

/** One `engine:event` payload, checked to be an envelope. */
export function asEnvelope(payload: unknown): EngineEnvelope {
  const p = payload as Partial<EngineEnvelope> | null;
  if (typeof p?.seq !== 'number' || typeof p.event?.type !== 'string') {
    throw new Error(`engine:event payload is not an envelope: ${JSON.stringify(payload)}`);
  }
  return p as EngineEnvelope;
}

/** The event inside one `engine:event` payload. */
export function unwrapEngineEvent(payload: unknown): EngineEvent {
  return asEnvelope(payload).event;
}

/** Every `engine:event` envelope, in broadcast order. */
export function engineEnvelopes(sent: readonly Sent[]): EngineEnvelope[] {
  return sent.filter(s => s.channel === 'engine:event').map(s => asEnvelope(s.payload));
}

/** Every broadcast engine event, in order. */
export function engineEvents(sent: readonly Sent[]): EngineEvent[] {
  return engineEnvelopes(sent).map(e => e.event);
}

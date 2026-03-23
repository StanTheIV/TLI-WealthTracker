import {describe, it, expect, vi, beforeEach} from 'vitest';
import {Engine} from '@/main/engine/engine';
import {PriceHandler} from '@/main/engine/handlers/price';
import {EngineContext} from '@/main/engine/context';
import type {EmitFn, EngineEvent} from '@/main/engine/types';

// ---------------------------------------------------------------------------
// PriceHandler unit tests
// ---------------------------------------------------------------------------

describe('PriceHandler', () => {
  let persist: ReturnType<typeof vi.fn<(id: string, price: number) => void>>;
  let handler: PriceHandler;
  let ctx: EngineContext;
  let events: EngineEvent[];
  let emit: EmitFn;

  beforeEach(() => {
    persist = vi.fn<(id: string, price: number) => void>();
    handler = new PriceHandler(persist);
    ctx     = new EngineContext();
    events  = [];
    emit    = (e) => events.push(e);
  });

  it('calls persist with stringified itemId and price', () => {
    handler.handle({type: 'price_update', itemId: 1001, price: 42.5}, ctx, emit);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith('1001', 42.5);
  });

  it('emits a price_update EngineEvent', () => {
    handler.handle({type: 'price_update', itemId: 1001, price: 42.5}, ctx, emit);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({type: 'price_update', itemId: 1001, price: 42.5});
  });

  it('emitted event includes a timestamp', () => {
    const before = Date.now();
    handler.handle({type: 'price_update', itemId: 5011, price: 1.23}, ctx, emit);
    const after = Date.now();

    expect(events[0].type).toBe('price_update');
    if (events[0].type === 'price_update') {
      expect(events[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(events[0].timestamp).toBeLessThanOrEqual(after);
    }
  });

  it('works regardless of engine phase', () => {
    for (const phase of ['idle', 'initializing', 'tracking'] as const) {
      persist.mockClear();
      ctx.phase = phase;
      const phaseEvents: EngineEvent[] = [];
      handler.handle({type: 'price_update', itemId: 1, price: 1}, ctx, (e) => phaseEvents.push(e));
      expect(persist).toHaveBeenCalledOnce();
      expect(phaseEvents).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: raw event → Engine → PriceHandler → EngineEvent
// ---------------------------------------------------------------------------

describe('Engine + PriceHandler (integration)', () => {
  it('routes price_update raw event through engine and emits EngineEvent', () => {
    const persist = vi.fn<(id: string, price: number) => void>();
    const events: EngineEvent[] = [];
    const engine = new Engine((e) => events.push(e)).register(new PriceHandler(persist));

    engine.start();
    engine.onRawEvent({type: 'price_update', itemId: 1234, price: 77.77});

    expect(persist).toHaveBeenCalledWith('1234', 77.77);
    expect(events.find(e => e.type === 'price_update')).toMatchObject({
      type:   'price_update',
      itemId: 1234,
      price:  77.77,
    });
  });
});

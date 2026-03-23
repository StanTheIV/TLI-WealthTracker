import {describe, it, expect, vi, beforeEach} from 'vitest';
import {BagInitHandler} from '@/main/engine/handlers/bag-init';
import {EngineContext} from '@/main/engine/context';
import type {EmitFn} from '@/main/engine/types';

function makeCtx(): EngineContext {
  const ctx = new EngineContext();
  ctx.phase = 'initializing';
  return ctx;
}

describe('BagInitHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('emits init_started on onStart', () => {
    const handler = new BagInitHandler();
    const ctx = makeCtx();
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.onStart(ctx, emit);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('init_started');
  });

  it('feeds bag slots to BagState during init', () => {
    const handler = new BagInitHandler();
    const ctx = makeCtx();
    handler.onStart(ctx, () => {});

    handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 111, quantity: 10}, ctx, () => {});
    handler.handle({type: 'bag_init', pageId: 0, slotId: 2, itemId: 222, quantity: 5},  ctx, () => {});

    expect(ctx.bag.slotCount).toBe(2);
  });

  it('emits init_complete and transitions to tracking after debounce', async () => {
    const handler = new BagInitHandler();
    const ctx = makeCtx();
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.onStart(ctx, emit);
    handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 111, quantity: 10}, ctx, emit);

    expect(ctx.phase).toBe('initializing');

    vi.advanceTimersByTime(600);

    expect(ctx.phase).toBe('tracking');
    expect(ctx.bag.initialized).toBe(true);
    const complete = events.find(e => e.type === 'init_complete');
    expect(complete).toBeDefined();
    if (complete?.type === 'init_complete') {
      expect(complete.itemCount).toBe(1);
    }
  });

  it('resets debounce timer on each new bag_init', () => {
    const handler = new BagInitHandler();
    const ctx = makeCtx();
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.onStart(ctx, emit);

    handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 1, quantity: 1}, ctx, emit);
    vi.advanceTimersByTime(300); // not yet expired

    handler.handle({type: 'bag_init', pageId: 0, slotId: 2, itemId: 2, quantity: 1}, ctx, emit);
    vi.advanceTimersByTime(300); // timer reset — still not expired

    expect(ctx.phase).toBe('initializing');

    vi.advanceTimersByTime(300); // now expired (300 + 300 > 500 from last event)

    expect(ctx.phase).toBe('tracking');
    expect(ctx.bag.slotCount).toBe(2);
  });

  it('ignores bag_init events when not in initializing phase', () => {
    const handler = new BagInitHandler();
    const ctx = makeCtx();
    ctx.phase = 'tracking';

    handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 111, quantity: 10}, ctx, () => {});

    expect(ctx.bag.slotCount).toBe(0);
  });

  it('clears timer on onStop', () => {
    const handler = new BagInitHandler();
    const ctx = makeCtx();
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.onStart(ctx, emit);
    handler.handle({type: 'bag_init', pageId: 0, slotId: 1, itemId: 1, quantity: 1}, ctx, emit);
    handler.onStop(ctx);
    vi.advanceTimersByTime(1000);

    // init_complete should NOT have been emitted
    expect(events.find(e => e.type === 'init_complete')).toBeUndefined();
    expect(ctx.phase).toBe('initializing'); // unchanged — ctx.reset() is engine's job
  });
});

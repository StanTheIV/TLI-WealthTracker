import {describe, it, expect, vi, beforeEach} from 'vitest';
import {ItemHandler} from '@/main/engine/handlers/item';
import {EngineContext} from '@/main/engine/context';
import {Tracker} from '@/main/engine/tracker';
import type {EmitFn} from '@/main/engine/types';

function makeCtx(inMap = false): EngineContext {
  const ctx = new EngineContext();
  ctx.phase   = 'tracking';
  ctx.inMap   = inMap;
  ctx.session = new Tracker('session');
  // Pre-init the bag with one slot so processUpdate works
  ctx.bag.processInit(0, 1, 111, 10);
  ctx.bag.finishInit();
  return ctx;
}

describe('ItemHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('emits drop immediately when in map', () => {
    const handler = new ItemHandler();
    const ctx = makeCtx(true);
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.handle({type: 'bag_update', pageId: 0, slotId: 1, itemId: 111, quantity: 15}, ctx, emit);

    const drops = events.filter(e => e.type === 'drop');
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({type: 'drop', itemId: 111, change: 5});
  });

  it('buffers and delays flush when in town', () => {
    const handler = new ItemHandler();
    const ctx = makeCtx(false);
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.handle({type: 'bag_update', pageId: 0, slotId: 1, itemId: 111, quantity: 15}, ctx, emit);

    expect(events).toHaveLength(0); // not yet

    vi.advanceTimersByTime(1600);

    const drops = events.filter(e => e.type === 'drop');
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({type: 'drop', itemId: 111, change: 5});
  });

  it('accumulates multiple changes for same item before flush', () => {
    const ctx = makeCtx(false);
    // Give the bag a second slot with same item
    ctx.bag.processInit(0, 2, 111, 5);
    ctx.bag.finishInit();

    const handler = new ItemHandler();
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.handle({type: 'bag_update', pageId: 0, slotId: 1, itemId: 111, quantity: 13}, ctx, emit); // +3
    handler.handle({type: 'bag_update', pageId: 0, slotId: 2, itemId: 111, quantity: 8},  ctx, emit); // +3

    vi.advanceTimersByTime(1600);

    const drops = events.filter(e => e.type === 'drop');
    expect(drops).toHaveLength(1);
    if (drops[0].type === 'drop') {
      expect(drops[0].change).toBe(6); // net +6
    }
  });

  it('flushes on zone_transition when leaving map (ctx.inMap already false)', () => {
    const handler = new ItemHandler();
    const ctx = makeCtx(false); // ZoneHandler already set inMap=false before us
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    // Buffer a change in town (not flushed yet)
    ctx.bag.processInit(0, 1, 111, 10);
    ctx.bag.finishInit();
    handler.handle({type: 'bag_update', pageId: 0, slotId: 1, itemId: 111, quantity: 15}, ctx, emit);
    expect(events).toHaveLength(0);

    // Zone transition (inMap already false — ZoneHandler ran first)
    handler.handle({type: 'zone_transition', fromScene: '/Game/Art/Maps/X', toScene: 'Town'}, ctx, emit);

    expect(events.some(e => e.type === 'drop')).toBe(true);
  });

  it('ignores events when not in tracking phase', () => {
    const handler = new ItemHandler();
    const ctx = makeCtx(true);
    ctx.phase = 'initializing';
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.handle({type: 'bag_update', pageId: 0, slotId: 1, itemId: 111, quantity: 15}, ctx, emit);

    expect(events).toHaveLength(0);
  });

  it('distributes drop to session tracker on flush', () => {
    const handler = new ItemHandler();
    const ctx = makeCtx(true);
    const emit: EmitFn = () => {};

    handler.handle({type: 'bag_update', pageId: 0, slotId: 1, itemId: 111, quantity: 20}, ctx, emit);

    expect(ctx.session?.snapshot().drops[111]).toBe(10);
  });

  it('clears buffer and timer on onStop', () => {
    const handler = new ItemHandler();
    const ctx = makeCtx(false);
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.handle({type: 'bag_update', pageId: 0, slotId: 1, itemId: 111, quantity: 15}, ctx, emit);
    handler.onStop(ctx);
    vi.advanceTimersByTime(2000);

    expect(events).toHaveLength(0);
  });

  describe('new_item emission', () => {
    it('emits new_item the first time an unknown itemId is seen', () => {
      const handler = new ItemHandler();
      const ctx = makeCtx(true);
      // 111 is pre-registered in makeCtx; simulate it being already known in DB
      ctx.knownItems = new Set(['111']);

      // Add a new bag slot for an unknown item 222
      ctx.bag.processInit(0, 5, 222, 0);
      ctx.bag.finishInit();

      const events: Parameters<EmitFn>[0][] = [];
      const emit: EmitFn = (e) => events.push(e);

      handler.handle({type: 'bag_update', pageId: 0, slotId: 5, itemId: 222, quantity: 3}, ctx, emit);

      const newItems = events.filter(e => e.type === 'new_item');
      expect(newItems).toHaveLength(1);
      expect(newItems[0]).toMatchObject({type: 'new_item', itemId: 222});
      expect(ctx.knownItems.has('222')).toBe(true);
    });

    it('does not emit new_item for already-known items', () => {
      const handler = new ItemHandler();
      const ctx = makeCtx(true);
      ctx.knownItems = new Set(['111']);

      const events: Parameters<EmitFn>[0][] = [];
      const emit: EmitFn = (e) => events.push(e);

      handler.handle({type: 'bag_update', pageId: 0, slotId: 1, itemId: 111, quantity: 15}, ctx, emit);

      expect(events.some(e => e.type === 'new_item')).toBe(false);
    });

    it('emits new_item before the corresponding drop', () => {
      const handler = new ItemHandler();
      const ctx = makeCtx(true);
      ctx.knownItems = new Set();
      ctx.bag.processInit(0, 7, 999, 0);
      ctx.bag.finishInit();

      const events: Parameters<EmitFn>[0][] = [];
      const emit: EmitFn = (e) => events.push(e);

      handler.handle({type: 'bag_update', pageId: 0, slotId: 7, itemId: 999, quantity: 2}, ctx, emit);

      const types = events.map(e => e.type);
      const newIdx  = types.indexOf('new_item');
      const dropIdx = types.indexOf('drop');
      expect(newIdx).toBeGreaterThanOrEqual(0);
      expect(dropIdx).toBeGreaterThan(newIdx);
    });

    it('emits new_item only once across multiple drops of the same new item', () => {
      const handler = new ItemHandler();
      const ctx = makeCtx(true);
      ctx.knownItems = new Set();
      ctx.bag.processInit(0, 4, 333, 0);
      ctx.bag.finishInit();

      const events: Parameters<EmitFn>[0][] = [];
      const emit: EmitFn = (e) => events.push(e);

      handler.handle({type: 'bag_update', pageId: 0, slotId: 4, itemId: 333, quantity: 1}, ctx, emit);
      handler.handle({type: 'bag_update', pageId: 0, slotId: 4, itemId: 333, quantity: 2}, ctx, emit);

      expect(events.filter(e => e.type === 'new_item')).toHaveLength(1);
    });
  });
});

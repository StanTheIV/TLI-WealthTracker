import {describe, it, expect, beforeEach} from 'vitest';
import {ZoneHandler} from '@/main/engine/handlers/zone';
import {EngineContext} from '@/main/engine/context';
import type {EmitFn} from '@/main/engine/types';

function makeCtx(): EngineContext {
  const ctx = new EngineContext();
  ctx.phase = 'tracking';
  return ctx;
}

const ts = '[2026.01.25-12.34.56:789]';

describe('ZoneHandler', () => {
  let handler: ZoneHandler;
  let ctx: EngineContext;

  beforeEach(() => {
    handler = new ZoneHandler();
    ctx = makeCtx();
  });

  it('emits zone_change on any transition', () => {
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.handle(
      {type: 'zone_transition', fromScene: 'XZ_YuJinZhiXiBiNanSuo200', toScene: '/Game/Art/Maps/S5_Magma_Boss'},
      ctx, emit,
    );

    expect(events[0]).toMatchObject({type: 'zone_change', from: 'XZ_YuJinZhiXiBiNanSuo200', to: 'S5_Magma_Boss', entering: 'map'});
  });

  it('entering a map sets ctx.inMap and emits map_started', () => {
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.handle(
      {type: 'zone_transition', fromScene: 'XZ_YuJinZhiXiBiNanSuo200', toScene: '/Game/Art/Maps/S5_Boss'},
      ctx, emit,
    );

    expect(ctx.inMap).toBe(true);
    expect(ctx.mapCount).toBe(1);
    expect(events.find(e => e.type === 'map_started')).toMatchObject({type: 'map_started', mapCount: 1});
  });

  it('entering town from map sets ctx.inMap=false and emits map_ended', () => {
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    ctx.inMap = true;
    ctx.mapStartTime = Date.now() - 60_000;

    handler.handle(
      {type: 'zone_transition', fromScene: '/Game/Art/Maps/S5_Boss', toScene: 'XZ_YuJinZhiXiBiNanSuo200'},
      ctx, emit,
    );

    expect(ctx.inMap).toBe(false);
    const ended = events.find(e => e.type === 'map_ended');
    expect(ended).toBeDefined();
    if (ended?.type === 'map_ended') {
      expect(ended.elapsed).toBeGreaterThan(50_000);
    }
  });

  it('does not emit map_started when not in tracking phase', () => {
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    ctx.phase = 'initializing';
    handler.handle(
      {type: 'zone_transition', fromScene: 'Town', toScene: '/Game/Art/Maps/S5_Boss'},
      ctx, emit,
    );

    expect(ctx.inMap).toBe(true); // ctx still updated
    expect(events.find(e => e.type === 'map_started')).toBeUndefined();
    expect(events.find(e => e.type === 'zone_change')).toBeDefined();
  });

  it('increments mapCount on each new map entry', () => {
    const emit: EmitFn = () => {};
    const town = 'XZ_YuJinZhiXiBiNanSuo200';
    const map  = '/Game/Art/Maps/S5_Boss';

    handler.handle({type: 'zone_transition', fromScene: town, toScene: map}, ctx, emit);
    handler.handle({type: 'zone_transition', fromScene: map,  toScene: town}, ctx, emit);
    handler.handle({type: 'zone_transition', fromScene: town, toScene: map}, ctx, emit);

    expect(ctx.mapCount).toBe(2);
  });

  it('classifies season paths as map', () => {
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.handle(
      {type: 'zone_transition', fromScene: 'Town', toScene: '/Game/Art/Season/S13_VorexDungeon'},
      ctx, emit,
    );

    expect(events[0]).toMatchObject({entering: 'map'});
  });

  it('classifies unknown scene correctly', () => {
    const events: Parameters<EmitFn>[0][] = [];
    const emit: EmitFn = (e) => events.push(e);

    handler.handle(
      {type: 'zone_transition', fromScene: 'A', toScene: 'SomeUnknownScene'},
      ctx, emit,
    );

    expect(events[0]).toMatchObject({entering: 'unknown'});
    expect(ctx.inMap).toBe(false);
  });
});

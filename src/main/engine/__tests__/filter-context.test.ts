/**
 * Unit tests for EngineContext.distributeDrop() with an active ItemFilterEngine.
 *
 * Verifies that the filter is applied per-scope and that the default (no filter)
 * distributes drops to all active trackers.
 */
import {describe, it, expect} from 'vitest';
import {EngineContext}        from '@/main/engine/context';
import {Tracker}              from '@/main/engine/tracker';
import {ItemFilterEngine}     from '@/main/engine/item-filter';
import type {FilterRule}      from '@/types/itemFilter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(
  action: FilterRule['action'],
  kind:   FilterRule['kind'],
  scopes: FilterRule['scopes'],
): FilterRule {
  return {id: crypto.randomUUID(), action, kind, scopes};
}

function makeTrackingCtx(): EngineContext {
  const ctx    = new EngineContext();
  ctx.phase    = 'tracking';
  ctx.session  = new Tracker('session');
  return ctx;
}

// ---------------------------------------------------------------------------
// No filter
// ---------------------------------------------------------------------------

describe('distributeDrop — no filter', () => {
  it('distributes to session tracker when no filter is set', () => {
    const ctx = makeTrackingCtx();
    ctx.distributeDrop(100, 5);
    expect(ctx.session!.snapshot().drops[100]).toBe(5);
  });

  it('distributes to map tracker when in map and no filter', () => {
    const ctx = makeTrackingCtx();
    ctx.map = new Tracker('map');
    ctx.distributeDrop(100, 3);
    expect(ctx.map.snapshot().drops[100]).toBe(3);
  });

  it('distributes to seasonal tracker when active and no filter', () => {
    const ctx = makeTrackingCtx();
    ctx.seasonal = new Tracker('seasonal', 'vorex');
    ctx.distributeDrop(200, 2);
    expect(ctx.seasonal.snapshot().drops[200]).toBe(2);
  });

  it('distributes to all three trackers simultaneously', () => {
    const ctx    = makeTrackingCtx();
    ctx.map      = new Tracker('map');
    ctx.seasonal = new Tracker('seasonal', 'dream');
    ctx.distributeDrop(50, 7);
    expect(ctx.session!.snapshot().drops[50]).toBe(7);
    expect(ctx.map.snapshot().drops[50]).toBe(7);
    expect(ctx.seasonal.snapshot().drops[50]).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Filter on session scope
// ---------------------------------------------------------------------------

describe('distributeDrop — filter on session scope', () => {
  it('blocks drop from session tracker when filter hides it in session scope', () => {
    const ctx = makeTrackingCtx();
    const types = new Map([['100', 'equipment' as const]]);
    ctx.filter = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['session'])],
      types,
    );
    ctx.distributeDrop(100, 5);
    expect(ctx.session!.snapshot().drops[100]).toBeUndefined();
  });

  it('still distributes to map tracker even when session scope is filtered', () => {
    const ctx = makeTrackingCtx();
    ctx.map = new Tracker('map');
    const types = new Map([['100', 'equipment' as const]]);
    ctx.filter = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['session'])],
      types,
    );
    ctx.distributeDrop(100, 5);
    expect(ctx.session!.snapshot().drops[100]).toBeUndefined();
    expect(ctx.map.snapshot().drops[100]).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Filter on map scope
// ---------------------------------------------------------------------------

describe('distributeDrop — filter on map scope', () => {
  it('blocks drop from map tracker but not session', () => {
    const ctx = makeTrackingCtx();
    ctx.map = new Tracker('map');
    const types = new Map([['200', 'cube' as const]]);
    ctx.filter = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-item', itemId: '200'}, ['map'])],
      types,
    );
    ctx.distributeDrop(200, 4);
    expect(ctx.session!.snapshot().drops[200]).toBe(4);  // session still gets it
    expect(ctx.map.snapshot().drops[200]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Filter on seasonal scope
// ---------------------------------------------------------------------------

describe('distributeDrop — filter on seasonal scope', () => {
  it('blocks drop from vorex seasonal tracker when vorex scope is filtered', () => {
    const ctx = makeTrackingCtx();
    ctx.seasonal = new Tracker('seasonal', 'vorex');
    const types = new Map([['300', 'equipment' as const]]);
    ctx.filter = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['vorex'])],
      types,
    );
    ctx.distributeDrop(300, 2);
    expect(ctx.session!.snapshot().drops[300]).toBe(2);          // session unaffected
    expect(ctx.seasonal.snapshot().drops[300]).toBeUndefined();  // vorex blocked
  });

  it('blocks drop from dream seasonal tracker when dream scope is filtered', () => {
    const ctx = makeTrackingCtx();
    ctx.seasonal = new Tracker('seasonal', 'dream');
    const types = new Map([['300', 'equipment' as const]]);
    ctx.filter = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['dream'])],
      types,
    );
    ctx.distributeDrop(300, 1);
    expect(ctx.seasonal.snapshot().drops[300]).toBeUndefined();
  });

  it('does not block vorex drop when only dream scope is filtered', () => {
    const ctx = makeTrackingCtx();
    ctx.seasonal = new Tracker('seasonal', 'vorex');
    const types = new Map([['300', 'equipment' as const]]);
    ctx.filter = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['dream'])],
      types,
    );
    ctx.distributeDrop(300, 3);
    // dream rule does not apply to vorex tracker
    expect(ctx.seasonal.snapshot().drops[300]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Whitelist pattern through distributeDrop
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Return value — used by drop-publisher to gate the renderer-facing 'drop' event
// ---------------------------------------------------------------------------

describe('distributeDrop — return value reflects session-scope acceptance', () => {
  it('returns true when no filter is set', () => {
    const ctx = makeTrackingCtx();
    expect(ctx.distributeDrop(100, 5)).toBe(true);
  });

  it('returns true when session scope accepts the drop', () => {
    const ctx = makeTrackingCtx();
    const types = new Map([['100', 'equipment' as const]]);
    ctx.filter = new ItemFilterEngine(
      // Hide from map only — session still accepts.
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['map'])],
      types,
    );
    expect(ctx.distributeDrop(100, 5)).toBe(true);
  });

  it('returns false when session scope rejects the drop', () => {
    const ctx = makeTrackingCtx();
    const types = new Map([['100', 'equipment' as const]]);
    ctx.filter = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['session'])],
      types,
    );
    expect(ctx.distributeDrop(100, 5)).toBe(false);
  });
});

describe('distributeDrop — whitelist pattern', () => {
  it('whitelisted item is tracked in session even when type rule would hide it', () => {
    const ctx = makeTrackingCtx();
    const types = new Map([
      ['100', 'equipment' as const],
      ['200', 'equipment' as const],
    ]);
    ctx.filter = new ItemFilterEngine(
      [
        // Show item 100 first → whitelist
        makeRule('show', {type: 'by-item',  itemId:   '100'},       ['session']),
        // Then hide all equipment
        makeRule('hide', {type: 'by-type',  itemType: 'equipment'}, ['session']),
      ],
      types,
    );

    ctx.distributeDrop(100, 5);  // whitelisted equipment → should be tracked
    ctx.distributeDrop(200, 3);  // regular equipment     → should be blocked

    expect(ctx.session!.snapshot().drops[100]).toBe(5);
    expect(ctx.session!.snapshot().drops[200]).toBeUndefined();
  });
});

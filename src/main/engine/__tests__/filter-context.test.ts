/**
 * Unit tests for TrackerRegistry.distributeDrop() with an active
 * ItemFilterEngine. Verifies per-scope filtering and that the default (no
 * filter) distributes drops to all active trackers.
 */
import {describe, it, expect} from 'vitest';
import {TrackerRegistry}      from '@/main/engine/tracker-registry';
import {ItemFilterEngine}     from '@/main/engine/item-filter';
import type {FilterRule}      from '@/types/itemFilter';

function makeRule(
  action: FilterRule['action'],
  kind:   FilterRule['kind'],
  scopes: FilterRule['scopes'],
): FilterRule {
  return {id: crypto.randomUUID(), action, kind, scopes};
}

function makeRegistry(): TrackerRegistry {
  const r = new TrackerRegistry();
  r.startSession();
  return r;
}

const noEmit = () => {};

// ---------------------------------------------------------------------------
// No filter
// ---------------------------------------------------------------------------

describe('distributeDrop — no filter', () => {
  it('distributes to session tracker when no filter is set', () => {
    const r = makeRegistry();
    r.distributeDrop(100, 5, null);
    expect(r.session!.snapshot().drops[100]).toBe(5);
  });

  it('distributes to map tracker when in map and no filter', () => {
    const r = makeRegistry();
    r.startMap();
    r.distributeDrop(100, 3, null);
    expect(r.map!.snapshot().drops[100]).toBe(3);
  });

  it('distributes to seasonal tracker when active and no filter', () => {
    const r = makeRegistry();
    r.startSeasonal({type: 'vorex'}, noEmit);
    r.distributeDrop(200, 2, null);
    expect(r.seasonal('vorex')!.snapshot().drops[200]).toBe(2);
  });

  it('distributes to all three trackers simultaneously', () => {
    const r = makeRegistry();
    r.startMap();
    r.startSeasonal({type: 'dream'}, noEmit);
    r.distributeDrop(50, 7, null);
    expect(r.session!.snapshot().drops[50]).toBe(7);
    expect(r.map!.snapshot().drops[50]).toBe(7);
    expect(r.seasonal('dream')!.snapshot().drops[50]).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Filter on session scope
// ---------------------------------------------------------------------------

describe('distributeDrop — filter on session scope', () => {
  it('blocks drop from session tracker when filter hides it in session scope', () => {
    const r = makeRegistry();
    const types = new Map([['100', 'equipment' as const]]);
    const filter = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['session'])],
      types,
    );
    r.distributeDrop(100, 5, filter);
    expect(r.session!.snapshot().drops[100]).toBeUndefined();
  });

  it('still distributes to map tracker even when session scope is filtered', () => {
    const r = makeRegistry();
    r.startMap();
    const types = new Map([['100', 'equipment' as const]]);
    const filter = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['session'])],
      types,
    );
    r.distributeDrop(100, 5, filter);
    expect(r.session!.snapshot().drops[100]).toBeUndefined();
    expect(r.map!.snapshot().drops[100]).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Filter on map scope
// ---------------------------------------------------------------------------

describe('distributeDrop — filter on map scope', () => {
  it('blocks drop from map tracker but not session', () => {
    const r = makeRegistry();
    r.startMap();
    const types = new Map([['200', 'cube' as const]]);
    const filter = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-item', itemId: '200'}, ['map'])],
      types,
    );
    r.distributeDrop(200, 4, filter);
    expect(r.session!.snapshot().drops[200]).toBe(4);
    expect(r.map!.snapshot().drops[200]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Filter on seasonal scope
// ---------------------------------------------------------------------------

describe('distributeDrop — filter on seasonal scope', () => {
  it('blocks drop from vorex seasonal tracker when vorex scope is filtered', () => {
    const r = makeRegistry();
    r.startSeasonal({type: 'vorex'}, noEmit);
    const types = new Map([['300', 'equipment' as const]]);
    const filter = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['vorex'])],
      types,
    );
    r.distributeDrop(300, 2, filter);
    expect(r.session!.snapshot().drops[300]).toBe(2);
    expect(r.seasonal('vorex')!.snapshot().drops[300]).toBeUndefined();
  });

  it('blocks drop from dream seasonal tracker when dream scope is filtered', () => {
    const r = makeRegistry();
    r.startSeasonal({type: 'dream'}, noEmit);
    const types = new Map([['300', 'equipment' as const]]);
    const filter = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['dream'])],
      types,
    );
    r.distributeDrop(300, 1, filter);
    expect(r.seasonal('dream')!.snapshot().drops[300]).toBeUndefined();
  });

  it('does not block vorex drop when only dream scope is filtered', () => {
    const r = makeRegistry();
    r.startSeasonal({type: 'vorex'}, noEmit);
    const types = new Map([['300', 'equipment' as const]]);
    const filter = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['dream'])],
      types,
    );
    r.distributeDrop(300, 3, filter);
    expect(r.seasonal('vorex')!.snapshot().drops[300]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Return value — used by drop-publisher to gate the renderer-facing 'drop' event
// ---------------------------------------------------------------------------

describe('distributeDrop — return value reflects session-scope acceptance', () => {
  it('returns sessionAccepted=true when no filter is set', () => {
    const r = makeRegistry();
    expect(r.distributeDrop(100, 5, null).sessionAccepted).toBe(true);
  });

  it('returns sessionAccepted=true when session scope accepts the drop', () => {
    const r = makeRegistry();
    const types = new Map([['100', 'equipment' as const]]);
    const filter = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['map'])],
      types,
    );
    expect(r.distributeDrop(100, 5, filter).sessionAccepted).toBe(true);
  });

  it('returns sessionAccepted=false when session scope rejects the drop', () => {
    const r = makeRegistry();
    const types = new Map([['100', 'equipment' as const]]);
    const filter = new ItemFilterEngine(
      [makeRule('hide', {type: 'by-type', itemType: 'equipment'}, ['session'])],
      types,
    );
    expect(r.distributeDrop(100, 5, filter).sessionAccepted).toBe(false);
  });
});

describe('distributeDrop — whitelist pattern', () => {
  it('whitelisted item is tracked in session even when type rule would hide it', () => {
    const r = makeRegistry();
    const types = new Map([
      ['100', 'equipment' as const],
      ['200', 'equipment' as const],
    ]);
    const filter = new ItemFilterEngine(
      [
        makeRule('show', {type: 'by-item',  itemId:   '100'},       ['session']),
        makeRule('hide', {type: 'by-type',  itemType: 'equipment'}, ['session']),
      ],
      types,
    );

    r.distributeDrop(100, 5, filter);
    r.distributeDrop(200, 3, filter);

    expect(r.session!.snapshot().drops[100]).toBe(5);
    expect(r.session!.snapshot().drops[200]).toBeUndefined();
  });
});

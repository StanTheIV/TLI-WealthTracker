/** 5.1b adversarial: decodeFilterRules on hostile input. */
import {describe, it, expect} from 'vitest';
import {decodeFilterRules, type FilterRule} from '@/shared/item-filter';

const RULE = (over: Record<string, unknown> = {}) => ({
  id: 'r1', action: 'hide', kind: {type: 'by-type', itemType: 'ember'}, scopes: ['session'], ...over,
});

describe('decodeFilterRules - hostile shapes', () => {
  it('a throwing getter on a rule field propagates a throw (never returns a partial rule)', () => {
    const rule = RULE();
    Object.defineProperty(rule, 'action', {get() { throw new Error('getter boom'); }, enumerable: true});
    expect(() => decodeFilterRules([rule])).toThrow('getter boom');
  });

  it('a throwing getter on kind.itemType throws', () => {
    const kind = {type: 'by-type'};
    Object.defineProperty(kind, 'itemType', {get() { throw new Error('kind boom'); }});
    expect(() => decodeFilterRules([RULE({kind})])).toThrow('kind boom');
  });

  it('a revoked proxy as the list or as a rule throws instead of returning', () => {
    const {proxy, revoke} = Proxy.revocable([RULE()], {});
    revoke();
    expect(() => decodeFilterRules(proxy)).toThrow();
    const {proxy: rp, revoke: rr} = Proxy.revocable({}, {});
    rr();
    expect(() => decodeFilterRules([rp])).toThrow();
  });

  it('a Proxy-wrapped valid rule decodes to a plain fresh object', () => {
    const out = decodeFilterRules([new Proxy(RULE(), {})]);
    expect(out).toEqual([RULE()]);
    expect(Object.getPrototypeOf(out[0])).toBe(Object.prototype);
  });

  it('__proto__ / constructor keys never reach the output', () => {
    const polluted = JSON.parse(
      '{"id":"r1","action":"hide","kind":{"type":"by-type","itemType":"ember","__proto__":{"x":1}},"scopes":["a"],"__proto__":{"polluted":true},"constructor":{"evil":1}}',
    );
    const [out] = decodeFilterRules([polluted]) as Array<FilterRule & Record<string, unknown>>;
    expect(Object.keys(out).sort()).toEqual(['action', 'id', 'kind', 'scopes']);
    expect(out.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(out.kind).sort()).toEqual(['itemType', 'type']);
  });

  it('a rule carrying extra fields keeps only the known ones', () => {
    const [out] = decodeFilterRules([RULE({extra: 1, kind: {type: 'by-item', itemId: '5', itemType: 'x', more: 2}})]);
    expect(out).toEqual({id: 'r1', action: 'hide', kind: {type: 'by-item', itemId: '5'}, scopes: ['session']});
  });

  it('wrong-typed ids and kinds are rejected', () => {
    for (const bad of [
      RULE({id: 1}), RULE({id: null}), RULE({action: 'HIDE'}), RULE({action: undefined}),
      RULE({kind: null}), RULE({kind: []}), RULE({kind: {type: 'by-type'}}), RULE({kind: {type: 'by-item', itemId: 5}}),
      RULE({kind: {type: 'toString'}}), RULE({scopes: 'session'}), RULE({scopes: [1]}), RULE({scopes: null}),
    ]) {
      expect(() => decodeFilterRules([bad]), JSON.stringify(bad)).toThrow();
    }
  });

  it('action names inherited from Object/Array prototypes never pass', () => {
    for (const action of ['constructor', 'length', 'toString', '__proto__']) {
      expect(() => decodeFilterRules([RULE({action})])).toThrow();
    }
  });

  it('non-array containers throw: array-likes, Set, string, typed array, null', () => {
    for (const v of [{length: 1, 0: RULE()}, new Set([RULE()]), 'x', new Uint8Array(2), null, undefined, 3]) {
      expect(() => decodeFilterRules(v)).toThrow();
    }
  });

  it('a Date / Map as a rule is rejected', () => {
    expect(() => decodeFilterRules([new Date()])).toThrow();
    expect(() => decodeFilterRules([new Map()])).toThrow();
  });

  it('a huge list decodes without blowing up and keeps order', () => {
    const big = Array.from({length: 100_000}, (_, i) => RULE({id: `r${i}`}));
    const out = decodeFilterRules(big);
    expect(out).toHaveLength(100_000);
    expect(out[99_999].id).toBe('r99999');
  });

  it('frozen input decodes; the output is not frozen', () => {
    const input = Object.freeze([Object.freeze(RULE({kind: Object.freeze({type: 'by-type', itemType: 'ember'}), scopes: Object.freeze(['session'])}))]);
    const out = decodeFilterRules(input);
    expect(Object.isFrozen(out)).toBe(false);
    expect(Object.isFrozen(out[0])).toBe(false);
    expect(() => { out[0].scopes.push('map'); out[0].id = 'z'; }).not.toThrow();
  });
});

describe('decodeFilterRules - aliasing', () => {
  it('the output shares no object with the input, in either direction', () => {
    const input = [RULE()];
    const snapshot = structuredClone(input);
    const out = decodeFilterRules(input);

    expect(out).not.toBe(input);
    expect(out[0]).not.toBe(input[0]);
    expect(out[0].kind).not.toBe(input[0].kind);
    expect(out[0].scopes).not.toBe(input[0].scopes);

    out[0].scopes.push('map' as never);
    out[0].id = 'mutated';
    (out[0].kind as {itemType: string}).itemType = 'other';
    expect(input).toEqual(snapshot);

    input[0].scopes.push('wealth');
    (input[0].kind as {itemType: string}).itemType = 'again';
    expect(out[0].scopes).toEqual(['session', 'map']);
    expect((out[0].kind as {itemType: string}).itemType).toBe('other');
  });

  it('two rules sharing one scopes array in the input get separate arrays out', () => {
    const shared = ['session'];
    const out = decodeFilterRules([RULE({id: 'a', scopes: shared}), RULE({id: 'b', scopes: shared})]);
    expect(out[0].scopes).not.toBe(out[1].scopes);
    out[0].scopes.push('map' as never);
    expect(out[1].scopes).toEqual(['session']);
  });

  it('decoding twice yields independent results', () => {
    const input = [RULE()];
    const a = decodeFilterRules(input);
    const b = decodeFilterRules(input);
    a[0].scopes.length = 0;
    expect(b[0].scopes).toEqual(['session']);
  });

  it('an extra own non-index property on the array is dropped', () => {
    const input = Object.assign([RULE()], {extra: 'x'});
    expect(Object.keys(decodeFilterRules(input))).toEqual(['0']);
  });
});

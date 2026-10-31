/** 5.1b: decodeFilterRules — the one structural validator for filter rules. */
import {describe, it, expect} from 'vitest';
import {decodeFilterRules as decode} from '@/shared/item-filter';

const byType = (over: object = {}) => ({id: 'r1', action: 'hide', kind: {type: 'by-type', itemType: 'ember'}, scopes: ['session', 'wealth'], ...over});
const byItem = (over: object = {}) => ({id: 'r2', action: 'show', kind: {type: 'by-item', itemId: '100'}, scopes: ['map'], ...over});

describe('decodeFilterRules', () => {
  it('is exported', () => {
    expect(typeof decode).toBe('function');
  });

  it('accepts valid by-type and by-item rules, in order', () => {
    expect(decode([byType(), byItem()])).toEqual([byType(), byItem()]);
    expect(decode([])).toEqual([]);
  });

  it('returns fresh objects carrying only the known fields', () => {
    const input = [byType({extra: 1, kind: {type: 'by-type', itemType: 'ember', junk: true}})];
    const out = decode(input);
    expect(out).toEqual([byType()]);
    expect(out[0]).not.toBe(input[0]);
    expect((out[0] as {kind: object}).kind).not.toBe(input[0].kind);
    expect(Object.keys(out[0] as object).sort()).toEqual(['action', 'id', 'kind', 'scopes']);
  });

  it('is lenient on unknown scope and itemType strings', () => {
    expect(() => decode([byType({scopes: ['future-scope'], kind: {type: 'by-type', itemType: 'future-type'}})])).not.toThrow();
  });

  it.each<[string, unknown]>([
    ['null', null], ['object', {}], ['string', '[]'], ['undefined', undefined],
  ])('throws for non-array %s', (_n, v) => {
    expect(typeof decode).toBe('function');
    expect(() => decode(v)).toThrow(Error);
  });

  it.each<[string, unknown]>([
    ['null rule', null], ['string rule', 'x'], ['number rule', 3], ['array rule', []],
    ['numeric id', byType({id: 1})], ['missing id', byType({id: undefined})],
    ['bad action', byType({action: 'toggle'})], ['missing action', byType({action: undefined})],
    ['missing kind', byType({kind: undefined})], ['null kind', byType({kind: null})],
    ['bad kind.type', byType({kind: {type: 'by-name', itemType: 'ember'}})],
    ['by-type without itemType', byType({kind: {type: 'by-type'}})],
    ['by-type numeric itemType', byType({kind: {type: 'by-type', itemType: 5}})],
    ['by-item without itemId', byItem({kind: {type: 'by-item'}})],
    ['by-item numeric itemId', byItem({kind: {type: 'by-item', itemId: 100}})],
    ['scopes not array', byType({scopes: 'session'})],
    ['missing scopes', byType({scopes: undefined})],
    ['scopes with non-string', byType({scopes: ['session', 3]})],
  ])('throws a clear Error for %s', (_n, bad) => {
    expect(typeof decode).toBe('function');
    let err: unknown;
    try { decode([byItem(), bad]); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message.length).toBeGreaterThan(5);
  });
});

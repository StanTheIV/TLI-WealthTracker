import {describe, it, expect} from 'vitest';
import {ITEM_TYPE_CONFIG, ITEM_TYPES, mapRawType} from '@/shared/items';

describe('mapRawType', () => {
  it('an item type maps to itself', () => {
    for (const type of ITEM_TYPES) expect(mapRawType(type)).toBe(type);
  });

  it('a raw import name maps to its type', () => {
    for (const type of ITEM_TYPES) {
      for (const raw of ITEM_TYPE_CONFIG[type].rawNames) expect(mapRawType(raw), raw).toBe(type);
    }
    expect(mapRawType('Corrosion Material')).toBe('fuel');
    expect(mapRawType('Compass')).toBe('compass');
  });

  it('missing, empty and unknown raw types are other', () => {
    expect(mapRawType(undefined)).toBe('other');
    expect(mapRawType('')).toBe('other');
    expect(mapRawType('Unheard Of Material')).toBe('other');
    expect(mapRawType('Fuel')).toBe('other'); // a label, not a type or raw name
  });

  it.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__proto__', '__defineGetter__'])(
    'the prototype key %s is other, not itself or an inherited member',
    raw => {
      expect(mapRawType(raw)).toBe('other');
    },
  );
});

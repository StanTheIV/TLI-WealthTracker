import {describe, it, expect} from 'vitest';
import {activePointIndex} from '@/lib/chartPointer';

describe('activePointIndex', () => {
  it('reads a numeric or numeric-string index while the tooltip is active', () => {
    expect(activePointIndex({isTooltipActive: true, activeTooltipIndex: 3})).toBe(3);
    expect(activePointIndex({isTooltipActive: true, activeTooltipIndex: '7'})).toBe(7);
    expect(activePointIndex({isTooltipActive: true, activeTooltipIndex: 0})).toBe(0);
  });

  it('never turns "no active point" into the first point', () => {
    expect(activePointIndex({isTooltipActive: true,  activeTooltipIndex: null})).toBeNull();
    expect(activePointIndex({isTooltipActive: true,  activeTooltipIndex: undefined})).toBeNull();
    expect(activePointIndex({isTooltipActive: true,  activeTooltipIndex: ''})).toBeNull();
    expect(activePointIndex({isTooltipActive: false, activeTooltipIndex: 4})).toBeNull();
  });

  it('rejects indices that cannot address a data row', () => {
    expect(activePointIndex({isTooltipActive: true, activeTooltipIndex: '1.5'})).toBeNull();
    expect(activePointIndex({isTooltipActive: true, activeTooltipIndex: -1})).toBeNull();
    expect(activePointIndex({isTooltipActive: true, activeTooltipIndex: 'abc'})).toBeNull();
  });
});

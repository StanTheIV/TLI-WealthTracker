import {describe, it, expect} from 'vitest';
import {createModalStack} from '../modalStack';

describe('modalStack', () => {
  it('only the last opened modal is on top', () => {
    const stack = createModalStack();
    const setup = Symbol('setup');
    const changelog = Symbol('changelog');
    expect(stack.isTop(setup)).toBe(false);
    stack.push(setup);
    expect(stack.isTop(setup)).toBe(true);
    stack.push(changelog);
    expect(stack.isTop(changelog)).toBe(true);
    expect(stack.isTop(setup)).toBe(false);
    stack.remove(changelog);
    expect(stack.isTop(setup)).toBe(true);
  });

  it('removing a modal below the top keeps the top', () => {
    const stack = createModalStack();
    const a = Symbol('a');
    const b = Symbol('b');
    stack.push(a);
    stack.push(b);
    stack.remove(a);
    expect(stack.isTop(b)).toBe(true);
    stack.remove(b);
    expect(stack.isTop(b)).toBe(false);
  });

  it('removing an unknown id is a no-op', () => {
    const stack = createModalStack();
    const a = Symbol('a');
    stack.push(a);
    stack.remove(Symbol('other'));
    expect(stack.isTop(a)).toBe(true);
  });
});

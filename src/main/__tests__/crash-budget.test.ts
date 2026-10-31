/** 5.1d: createCrashBudget — 3 reloads per sliding 60 s, then give up; non-crash exits ignored. */
import {describe, it, expect} from 'vitest';
import {createCrashBudget} from '@/main/crash-budget';

function setup() {
  let t = 1_000_000;
  const budget = createCrashBudget({max: 3, windowMs: 60_000, now: () => t});
  return {budget, advance: (ms: number) => { t += ms; }};
}

describe('createCrashBudget', () => {
  it('reloads 3 times within 60 s, then gives up', () => {
    const {budget, advance} = setup();
    expect(budget.onGone('crashed')).toBe('reload');
    advance(1_000);
    expect(budget.onGone('oom')).toBe('reload');
    advance(1_000);
    expect(budget.onGone('abnormal-exit')).toBe('reload');
    advance(1_000);
    expect(budget.onGone('crashed')).toBe('give-up');
    expect(budget.onGone('crashed')).toBe('give-up');
  });

  it('the window slides: a reload older than 60 s frees a slot', () => {
    const {budget, advance} = setup();
    budget.onGone('crashed');            // t0
    advance(30_000);
    budget.onGone('crashed');            // t0 + 30 s
    budget.onGone('crashed');            // t0 + 30 s
    advance(29_999);
    expect(budget.onGone('crashed')).toBe('give-up'); // t0 still within 60 s
    advance(1);
    expect(budget.onGone('crashed')).toBe('reload');  // t0 expired exactly at 60 s
    expect(budget.onGone('crashed')).toBe('give-up'); // the two at +30 s and this one fill it
    advance(30_000);
    expect(budget.onGone('crashed')).toBe('reload');
  });

  it('a quiet minute restores the full budget', () => {
    const {budget, advance} = setup();
    for (let i = 0; i < 3; i++) budget.onGone('crashed');
    expect(budget.onGone('crashed')).toBe('give-up');
    advance(60_000);
    for (let i = 0; i < 3; i++) expect(budget.onGone('crashed')).toBe('reload');
  });

  it.each(['clean-exit', 'killed'])('%s is ignored and uses no budget', (reason) => {
    const {budget} = setup();
    for (let i = 0; i < 10; i++) expect(budget.onGone(reason)).toBe('ignore');
    for (let i = 0; i < 3; i++) expect(budget.onGone('crashed')).toBe('reload');
  });

  it.each(['crashed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure', 'memory-eviction', 'something-new'])(
    '%s counts as a crash', (reason) => {
      const {budget} = setup();
      expect(budget.onGone(reason)).toBe('reload');
    });

  it('budgets are independent', () => {
    const a = setup().budget;
    const b = setup().budget;
    for (let i = 0; i < 3; i++) a.onGone('crashed');
    expect(a.onGone('crashed')).toBe('give-up');
    expect(b.onGone('crashed')).toBe('reload');
  });
});

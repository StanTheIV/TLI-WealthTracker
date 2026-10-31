/**
 * 3.1b invariant: a handler that freezes the map for an interlude (calls
 * pauseMapForInterlude) must pick an interlude that is already in progress up
 * when the session opens (bag init, Reset) — i.e. implement `onSessionOpen`.
 * Dream is in-map, but its run also starts from state seen before init.
 * Read from the handler sources, like engine-configure.test.ts.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, it, expect} from 'vitest';
import {createEngine} from './seasonal-fixtures';

const HANDLERS = join(__dirname, '..', 'handlers');

/** The `name` of every handler whose source calls pauseMapForInterlude. */
function mapFreezingHandlers(): string[] {
  return readdirSync(HANDLERS)
    .filter(f => f.endsWith('.ts'))
    .map(f => readFileSync(join(HANDLERS, f), 'utf8'))
    .filter(src => /\bpauseMapForInterlude\(ctx\b/.test(src))
    .map(src => {
      const name = /readonly name\s*=\s*'([^']+)'/.exec(src)?.[1];
      if (!name) throw new Error('a handler calling pauseMapForInterlude has no name');
      return name;
    })
    .sort();
}

describe('onSessionOpen', () => {
  const engine = createEngine([]);

  it('finds the four map-freezing handlers', () => {
    expect(mapFreezingHandlers()).toEqual(['arcana', 'sandlord', 'tartarus', 'vorex']);
  });

  it.each(mapFreezingHandlers())('%s (calls pauseMapForInterlude) implements onSessionOpen', (name) => {
    const handler = engine.getHandler(name);
    expect(handler).not.toBeNull();
    expect(typeof handler?.onSessionOpen).toBe('function');
  });

  it('dream (an in-map run started from pre-init state) implements onSessionOpen', () => {
    expect(typeof engine.getHandler('dream')?.onSessionOpen).toBe('function');
  });
});

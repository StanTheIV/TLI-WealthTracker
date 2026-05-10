import type {Processor, RawEvent} from './types';

export type S12Event =
  | {type: 's12_entry'}
  | {type: 's12_exit'};

/**
 * S12Processor — Overrealm entry/exit detection.
 *
 * Game-log quirks this hides from the handler:
 *
 *  1. `USceneEffectMgr::S12SwitchFinish` fires on every pact/area switch:
 *     the initial entry, each stage transition (stage 1→2, 2→3, …), AND the
 *     final post-exit transition that switches the scene back to the
 *     Netherrealm map. Only the first one is a real "entry" — every other
 *     occurrence is internal scene plumbing the handler doesn't care about.
 *
 *  2. The exit signal `gameplay type 8001 received notifyId 101` fires
 *     ~200ms BEFORE the post-exit `S12SwitchFinish`, so the order at the
 *     stream level is `entry … entry … entry … exit … entry`. A naïve
 *     "every S12SwitchFinish is an entry" rule mis-interprets that final
 *     entry as a re-entry into Overrealm.
 *
 * Resolution: the processor keeps a tiny state machine and only emits
 * `s12_entry` on the genuine outside→inside transition. The handler then
 * just sees `entry → exit` per Overrealm run, with optional re-entries
 * during the loot window if the player takes another portal.
 *
 *   outside → (S12SwitchFinish) → inside     ⇒ emit s12_entry
 *   inside  → (S12SwitchFinish) → inside     ⇒ swallow (stage transition)
 *   inside  → (notifyId 101)    → looting    ⇒ emit s12_exit
 *   looting → (S12SwitchFinish) → outside    ⇒ swallow (post-exit map switch)
 *   looting → (S12SwitchFinish) → inside     ⇒ emit s12_entry (re-entry portal)
 *
 * The "looting" sub-state distinguishes the swallowed post-exit
 * `S12SwitchFinish` from a genuine re-entry. The first `S12SwitchFinish`
 * after `s12_exit` is always the scene switch back to Netherrealm and is
 * dropped; any subsequent one is a real new portal entry.
 */
const RE_ENTRY = /S12SwitchFinish/;
const RE_EXIT  = /gameplay type 8001 received notifyId 101\b/;

export class S12Processor implements Processor {
  readonly name = 's12';

  private _state: 'outside' | 'inside' | 'looting' = 'outside';

  test(line: string): boolean {
    return line.includes('S12SwitchFinish') || line.includes('gameplay type 8001 received notifyId 101');
  }

  process(line: string): RawEvent | null {
    if (RE_ENTRY.test(line)) {
      switch (this._state) {
        case 'outside':
          this._state = 'inside';
          return {type: 's12_entry'};
        case 'inside':
          // Stage transition while already inside — swallow.
          return null;
        case 'looting':
          // First S12SwitchFinish after exit = scene switch back to map; swallow.
          // Any later one is a real re-entry — but since we only get one
          // post-exit switch, we drop this one and go to outside; the next
          // one will be treated as a fresh entry.
          this._state = 'outside';
          return null;
      }
    }

    if (RE_EXIT.test(line)) {
      // Exit only meaningful while inside; outside/looting → ignore as noise.
      if (this._state === 'inside') {
        this._state = 'looting';
        return {type: 's12_exit'};
      }
      return null;
    }

    return null;
  }
}

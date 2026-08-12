import type {Processor, RawEvent} from './types';

export type S7Event =
  | {type: 's7_podium'}
  | {type: 's7_cogwheel'}
  | {type: 's7_cogwheel_end'}
  | {type: 's7_turnin'}
  | {type: 's7_fail'};

// Clockwork Ballet (S7) spans a whole map: podium → cogwheel fights → turn-in.
//
// The END of a cogwheel is definitive — Gear_Exp_Common, 132 of them, 126
// followed by their voucher inside 0.5s. The START is not: Gear_Idle_Common_Lp
// is an ambient LOOP that re-fires roughly every 2.8s while the player stands by
// a spinning cogwheel (1-9 times per fight), carries no id or position, and so
// cannot distinguish "a second cogwheel started" from "the first is still
// spinning". Concurrent cogwheels are therefore NOT countable from this log, and
// the handler treats engagement as a boolean rather than a depth count.
//
// Both track the MACHINE, not its monsters. The 261xxxx mobs a cogwheel spawns
// scatter across the whole map rather than staying at it, so driving the window
// off spawns kept it alive on kills made anywhere — measured 1.45x over-count,
// one encounter clocking 85.2s of fight time in a 109.5s run. Machine markers
// are Clockwork-exclusive: 265 of 267 fall inside a run.
//
// s7_turnin fires for FAILED runs too: a failure emits PushState =
// S7GamePlayStateSuccess first, then opens the fail page ~2s later. Failed runs
// still drop loot, so the Success push is the loot signal for both outcomes and
// s7_fail is a pure outcome annotation. (An earlier comment here claimed a
// failure emits no push line at all — it does.)
//
// The two marker families need opposite handling. AudioMgr lines are echoed 1:1
// by a LogDataTable row, so they must be matched via AUDIO_PREFIX or every event
// double-fires; the machine markers exist ONLY as LogDataTable rows.
const AUDIO_PREFIX    = 'AudioMgr@PlayAudio  AudioEnum  == ';
const PODIUM_MARKER   = `${AUDIO_PREFIX}S7_3X1_Open`;
const PUSH_PREFIX     = 'S7GamePlayMgr@HandleS7PushData';
const TURNIN_MARKER   = 'PushState = S7GamePlayStateSuccess';
const FAIL_UI_MARKER  = 'S7GamePlayFailStateItem';
// A cogwheel spinning (a loop, so it repeats) and one finishing. GearBox_* is
// the post-turn-in reward chest and is deliberately excluded.
const MACHINE_PREFIX  = 'Play_Obj_S7_WOJLB_Machine_';
const GEAR_SPINNING   = `${MACHINE_PREFIX}Gear_Idle_`;
const GEAR_DONE       = `${MACHINE_PREFIX}Gear_Exp_`;

export class S7Processor implements Processor {
  readonly name = 's7';

  test(line: string): boolean {
    return line.includes('S7');
  }

  process(line: string): RawEvent | null {
    if (line.includes(MACHINE_PREFIX)) {
      if (line.includes(GEAR_DONE))     return {type: 's7_cogwheel_end'};
      if (line.includes(GEAR_SPINNING)) return {type: 's7_cogwheel'};
      return null; // GearBox_* — the post-turn-in reward chest.
    }

    if (line.includes(AUDIO_PREFIX)) {
      if (line.includes(PODIUM_MARKER)) return {type: 's7_podium'};
      // S7_Level_Gear is the voucher award. It trails Gear_Exp by ~0.15s and so
      // says nothing new, and 38 of 164 fire with no cogwheel at all (bonus and
      // turn-in payouts), which would wrongly park the tracker.
      return null;
    }

    if (line.includes(PUSH_PREFIX)) {
      if (line.includes(TURNIN_MARKER)) return {type: 's7_turnin'};
      return null; // heartbeat, the -1 → Start transition, other pushes
    }

    // Only the OpenFlow0 opening of the fail page counts — later references to
    // the same widget during teardown are ignored.
    if (line.includes(FAIL_UI_MARKER) && line.includes('OpenFlow0')) {
      return {type: 's7_fail'};
    }

    return null;
  }
}

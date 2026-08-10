import type {Processor, RawEvent} from './types';

export type S10Event =
  | {type: 's10_tile'}
  | {type: 's10_wave'}
  | {type: 's10_quench'};

// Sandlord (S10) IN-MAP coin-tile event. The only reliable markers are Wwise
// audio rows that are genuinely missing from the game's AudioCDTable, so every
// tile interaction surfaces as a `LogDataTable: Warning ... FindRow` line —
// exactly one line per event, verified against ~25 consecutive map runs:
//
//   Play_Obj_Season_S10_Machine_Normal_Lp          → s10_tile   (tile activated)
//   Play_Obj_Season_S10_Machine_PaLu_Active_Lp     → s10_wave   (machine engaged)
//   Play_Obj_Season_S10_Machine_Resource_Active_Lp → s10_wave   (machine engaged)
//   Play_Obj_Season_S10_<mob>_Land                 → s10_wave   (mobs landing)
//   Play_Obj_Season_S10_Machine_PaLu_Quench        → s10_quench (machine done)
//   Play_Obj_Season_S10_Machine_Resource_Quench    → s10_quench (machine done)
//
// A Machine_*_Active fires once per MACHINE, not per spawn round — a single
// machine spawns several mob rounds with no further Machine marker between
// them. The per-round signal is the mob-landing markers (`<mob>_Land`, one
// line per landing mob, 30+/sec during a burst); the handler rate-limits the
// resulting timer resets. The Quench variant mirrors whichever Active variant
// fired last — it is NOT a success/fail distinction, and one tile can quench
// more than once (per machine). No abandon marker exists; abandonment is
// derived (wave-timer expiry / town entry) by the handler.
//
// CAUTION: the same markers fire densely during the hub's Pillage minigame —
// the handler gates on "in a regular map, no bubble", not the processor.
const PREFIX      = 'Play_Obj_Season_S10_';
const TILE_MARKER = 'Play_Obj_Season_S10_Machine_Normal_Lp';
const WAVE_MARKERS = [
  'Play_Obj_Season_S10_Machine_PaLu_Active_Lp',
  'Play_Obj_Season_S10_Machine_Resource_Active_Lp',
];
const QUENCH_MARKERS = [
  'Play_Obj_Season_S10_Machine_PaLu_Quench',
  'Play_Obj_Season_S10_Machine_Resource_Quench',
];
// Matches every mob type's landing row (WuZhuangZhe/LieRen/JieLun/KuangFeng/
// MeiYing observed; suffix-matched so a new mob type still counts).
const RE_MOB_LAND = /Play_Obj_Season_S10_[A-Za-z]+_Land/;

export class S10Processor implements Processor {
  readonly name = 's10';

  test(line: string): boolean {
    return line.includes(PREFIX);
  }

  process(line: string): RawEvent | null {
    if (line.includes(TILE_MARKER)) return {type: 's10_tile'};
    if (QUENCH_MARKERS.some(m => line.includes(m))) return {type: 's10_quench'};
    if (WAVE_MARKERS.some(m => line.includes(m)) || RE_MOB_LAND.test(line)) return {type: 's10_wave'};
    return null;
  }
}

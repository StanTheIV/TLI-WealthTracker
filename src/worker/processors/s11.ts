import type {Processor, RawEvent} from './types';

export type S11Event =
  | {type: 's11_start'}
  | {type: 's11_wave'}
  | {type: 's11_end'};

// Play audio PostEventAsync bgm .../Play_Mus_Gameplay_S11_Robbery_Full...  → s11_start
//   Fires when Carjack combat begins (both regular and bounty variants).
//
// Play audio PostEventAsync bgm .../Stop_Mus_Gameplay_S11_Robbery_Full...  → s11_end
//   Fires on a fixed post-encounter sequence, NOT when the player stops fighting:
//   one measured encounter ran 24s past its last activity marker. It also fires
//   twice per encounter (a combined form, then a bare one 6-34s later) — the
//   handler de-dupes.
//
// Play_Obj_Season_S11_THTJ_<mob/box/car> → s11_wave
//   Combat activity, the signal the encounter is still being played. Measured
//   across 884 intra-encounter gaps: p99 0.47s, max 7.89s.
//
// Both music lines appear as duplicates in the log — the handler is idempotent.
// "Stop" must be checked first since both contain "Play_Mus_Gameplay_S11_Robbery_Full".
const STOP_MARKER  = 'Stop_Mus_Gameplay_S11_Robbery_Full';
const START_MARKER = 'Play_Mus_Gameplay_S11_Robbery_Full';
const MUSIC_MARKER = 'Mus_Gameplay_S11_Robbery_Full';
// Object markers only. The Play_UI_Season_S11_THTJ_* siblings (countdown, result
// screen) are UI flourishes that fire outside combat and must not count.
const WAVE_PREFIX  = 'Play_Obj_Season_S11_THTJ_';
// Mon_DisAppear is excluded on purpose: it fires in the terminal despawn burst,
// so counting it as activity would extend the window exactly when it should end.
const WAVE_MARKERS = [
  'Mon_Appear',
  'Mon_Die_Gold1',
  'Mon_Die_Gold2',
  'Mon_Die_Gold3',
  'BoxMonster_Appear',
  'BoxMonster_Open',
  'Car_Open1',
  'Car_DisAppear2',
];

export class S11Processor implements Processor {
  readonly name = 's11';

  test(line: string): boolean {
    return line.includes(MUSIC_MARKER) || line.includes(WAVE_PREFIX);
  }

  process(line: string): RawEvent | null {
    if (line.includes(STOP_MARKER))  return {type: 's11_end'};
    if (line.includes(START_MARKER)) return {type: 's11_start'};
    if (WAVE_MARKERS.some(m => line.includes(WAVE_PREFIX + m))) return {type: 's11_wave'};
    return null;
  }
}

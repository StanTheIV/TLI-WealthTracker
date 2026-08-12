import type {Processor, RawEvent} from './types';

export type AfterlightEvent =
  | {type: 'afterlight_start'}
  | {type: 'afterlight_special'}
  | {type: 'afterlight_wave'}
  | {type: 'afterlight_end'};

// Afterlight (S15) in-map encounter. The player activates a hearse cart, a
// warden boss appears with several bursts of mobs, and the encounter ends when
// the boss dies — a bounded fight (median ~22s, max ~51s), one per map, NOT a
// long cart route. Like the S10 tile markers these are Wwise rows missing from
// the game's AudioCDTable, so each surfaces as a `LogDataTable: Warning ...
// FindRow` line, one line per event.
//
// The 'ShouYe' (守夜, "night watch") family has four members, but only two are
// encounters. Verified across three real logs (2026-08-08/09/10):
//
//   ShouYe_JiangJun_App / _Win  → start / end   (the General — 144/143 events)
//   ShouYe_JiangJun_Lose        → end           (the fight was failed — 1 event)
//   ShouYe_XinNiang_App / _Win  → start / end   (the Bride   — 5/5 events)
//   ShouYe_YouHun_App, _DiaApp  → ignored: mid-fight NPC, NEVER has a _Win
//   ShouYe_Box_App, _Open       → ignored: reward chest,   NEVER has a _Win
//
// Waves come from a different log category entirely — the gameplay line
// `Monster Created: npc id <id>`, not an audio row. Every 299-prefixed id in the
// corpus (2990xxx, plus a 2991xxx family present in some sessions) fires only
// inside a JiangJun/XinNiang window: 48,880 spawns across 143 encounters, none
// outside. Encounters run 6-9 scripted waves of 22 rarity-1 + 8 rarity-2 mobs.
//
// Filtering to the two real encounter variants is load-bearing, not cosmetic: a
// YouHun_App fires *inside* an ongoing General encounter (observed 3x), so
// matching _App across the whole ShouYe_ prefix would start a phantom second
// tracker mid-fight. App→Win pairs perfectly and never nests; the single
// unmatched App across all three logs is a run abandoned by leaving the map,
// which the handler leaves to ZoneHandler.finishAll.
//
// Markers deliberately NOT used:
//   Play/Stop_Mus_Gameplay_S15_Core — BGM, and lossy: 6-15% of encounters fire
//     with no Play line at all when music was already playing. Also stops twice
//     (a real stop plus a fade-out exactly +10.0s later).
//   gameplay type 8100 received notifyId 8000 — a genuine gameplay line rather
//     than an audio-table side effect, so it is the future-proof fallback if
//     these rows are ever added to the datatable and the warnings vanish. Not
//     used today: it is a route/board-state broadcast carrying a 15-slot
//     NotifyData payload, fires out of step with the encounter (+2.25s), and has
//     sibling notifyIds (8100/8101/101/103) of unverified meaning.
//   S15_Bride BGM / S15_WF_ZTTC_Start — a different S15 sub-mechanic; ZTTC_Start
//     was once seen 9ms from a JiangJun_App, so it must never gate the cart.
// Encounter TYPE comes from the BGM bracket, not the ShouYe rows. Counted over
// three logs: Core 196 (the plain fight, 22.5s median), Special 12 (45s median,
// 42% spawn a reward casket), Bride 7, Goblin 1. The three non-Core variants are
// longer and richer, so the handler widens their window.
//
// Special also does NOT reliably log a boss death: 7 of its 9 completed
// encounters had no _Win/_Lose row at all, and its casket spawns 27-35s in —
// long after the window a _Win would have armed. Its BGM Stop is the only
// dependable end (1.2-2.2s after the casket appears), so it is matched here.
const PREFIX = 'Play_Obj_Season_S15_ShouYe_';
const MUS_PREFIX = 'Mus_Gameplay_S15_';
// Suffix-matched on the encounter variants only, so a future 5th encounter type
// would need adding here explicitly — deliberate, given YouHun/Box share the
// prefix but have no _Win and must never trigger.
const RE_START = /Play_Obj_Season_S15_ShouYe_(?:JiangJun|XinNiang)_App/;
const RE_END   = /Play_Obj_Season_S15_ShouYe_(?:JiangJun|XinNiang)_(?:Win|Lose)/;
const RE_SPECIAL_START = /Play_Mus_Gameplay_S15_(?:Special|Bride|Goblin)/;
const RE_SPECIAL_END   = /Stop_Mus_Gameplay_S15_(?:Special|Bride|Goblin)/;
// The only processor whose test() fires on a hot non-audio line category
// (`Monster Created` is ~2% of all lines) — keep it a plain substring check.
const WAVE_MARKER = 'Monster Created: npc id 299';

export class AfterlightProcessor implements Processor {
  readonly name = 'afterlight';

  test(line: string): boolean {
    return line.includes(PREFIX) || line.includes(WAVE_MARKER) || line.includes(MUS_PREFIX);
  }

  process(line: string): RawEvent | null {
    // Stop before Play: the Stop marker's string contains the Play one.
    if (RE_SPECIAL_END.test(line))     return {type: 'afterlight_end'};
    if (RE_SPECIAL_START.test(line))   return {type: 'afterlight_special'};
    if (RE_START.test(line))           return {type: 'afterlight_start'};
    if (RE_END.test(line))             return {type: 'afterlight_end'};
    if (line.includes(WAVE_MARKER))    return {type: 'afterlight_wave'};
    return null;
  }
}

/** Range presets for price history (modal + trends). Pure; ranges are half-open [from, to). */
import {leagueAt, type LeagueRange} from './leagues';

export type PricePreset = 'league' | 'prevLeague' | 'all' | '7d' | '1d';

export type PriceRange = {from: number; to: number};

const DAY_MS = 24 * 3_600_000;

/** Presets that make sense for the given leagues (league presets need a league). */
export function availablePresets(ranges: LeagueRange[], now: number): PricePreset[] {
  const cur = leagueAt(ranges, now);
  const out: PricePreset[] = [];
  if (cur) out.push('league');
  if (cur && ranges.indexOf(cur) > 0) out.push('prevLeague');
  out.push('all', '7d', '1d');
  return out;
}

/** 'league' when a league is known, otherwise 'all'. */
export function defaultPreset(ranges: LeagueRange[], now: number): PricePreset {
  return availablePresets(ranges, now)[0] === 'league' ? 'league' : 'all';
}

/** Resolve a preset to [from, to); null when the preset is unavailable. Open ends include `now`. */
export function resolvePriceRange(
  preset: PricePreset,
  ranges: LeagueRange[],
  now: number,
): PriceRange | null {
  const end = now + 1;
  switch (preset) {
    case 'all': return {from: 0, to: end};
    case '7d':  return {from: now - 7 * DAY_MS, to: end};
    case '1d':  return {from: now - DAY_MS, to: end};
    case 'league': {
      const cur = leagueAt(ranges, now);
      // The next league may already be announced (future start): cap at now so the
      // chart axis doesn't stretch into empty days.
      return cur ? {from: cur.from, to: Math.min(cur.to ?? end, end)} : null;
    }
    case 'prevLeague': {
      const cur = leagueAt(ranges, now);
      const prev = cur ? ranges[ranges.indexOf(cur) - 1] : undefined;
      return prev ? {from: prev.from, to: prev.to ?? cur!.from} : null;
    }
  }
}

export type LeagueSource = 'bundled' | 'remote' | 'user';

export type League = {
  id: string;
  name: string;
  /** ms epoch */
  startsAt: number;
  source: LeagueSource;
};

export type LeagueRange = {
  id: string;
  name: string;
  source: LeagueSource;
  /** inclusive, ms epoch */
  from: number;
  /** exclusive (next league's start); null for the latest league */
  to: number | null;
};

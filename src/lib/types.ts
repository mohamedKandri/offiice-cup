export type Format = 'league_playoff' | 'league' | 'knockout';
export type TournamentStatus = 'lobby' | 'league' | 'playoffs' | 'finished';
export type Stage = 'league' | 'playoff' | 'third';
export type MatchStatus = 'scheduled' | 'live' | 'pending' | 'confirmed' | 'disputed';

export interface Settings {
  game: string;
  race: number;        // league / knockout matches: first to N frames
  playoffRace: number; // playoff matches (league + playoff format)
  winPoints: number;
  playoffSize: 2 | 4 | 8;
  tables: number;
  thirdPlace: boolean;
}

export interface Tournament {
  id: string;
  code: string;
  name: string;
  format: Format;
  settings: Settings;
  status: TournamentStatus;
  created_at: string;
}

export interface Player {
  id: string;
  tournament_id: string;
  name: string;
  ball: number;
  is_admin: boolean;
  created_at: string;
}

export interface Match {
  id: string;
  tournament_id: string;
  stage: Stage;
  round: number;
  slot: number;
  player_a: string;
  player_b: string | null;
  race: number;
  score_a: number;
  score_b: number;
  status: MatchStatus;
  table_no: number | null;
  reported_by: string | null;
  dispute: { by: string; a: number; b: number } | null;
  updated_at: string;
}

/** A match the admin's device asks the server to create. */
export interface NewMatch {
  stage: Stage;
  round: number;
  slot: number;
  player_a: string;
  player_b: string | null;
  race: number;
  status?: MatchStatus;
  score_a?: number;
  score_b?: number;
}

export const DEFAULT_SETTINGS: Settings = {
  game: '8-Ball',
  race: 3,
  playoffRace: 3,
  winPoints: 3,
  playoffSize: 4,
  tables: 2,
  thirdPlace: false
};

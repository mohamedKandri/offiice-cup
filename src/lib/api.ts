import { createClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Format, Match, NewMatch, Player, Settings, Tournament, TournamentStatus } from './types';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_KEY as string;

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { params: { eventsPerSecond: 10 } }
});

const MESSAGES: Record<string, string> = {
  not_found: 'No tournament with that code.',
  already_started: 'This tournament has already started.',
  full: 'This tournament is full (32 players).',
  name_taken: 'Someone already uses that name here. Try another.',
  forbidden: 'You are not allowed to do that.',
  not_enough_players: 'At least 2 players are needed.',
  bad_player: 'A player in that match is not in this tournament.',
  bad_state: 'That match changed meanwhile. Refresh and try again.',
  bad_score: 'That score is not valid for this race.',
  player_busy: 'One of you is already playing on a table.',
  no_free_table: 'All tables are busy. Wait for a match to finish.',
  finished: 'This tournament is finished.'
};

export class ApiError extends Error {}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    const code = Object.keys(MESSAGES).find((k) => error.message?.includes(k));
    throw new ApiError(code ? MESSAGES[code] : 'Connection problem. Check your internet and try again.');
  }
  return data as T;
}

export interface CreateResult {
  tournament_id: string; code: string; admin_token: string; player_id: string | null; player_token: string | null;
}
export interface JoinResult {
  tournament_id: string; code: string; player_id: string; player_token: string;
}

export const api = {
  createTournament: (name: string, format: Format, settings: Settings, adminName: string | null, adminBall: number | null) =>
    rpc<CreateResult>('create_tournament', {
      p_name: name, p_format: format, p_settings: settings, p_admin_name: adminName, p_admin_ball: adminBall
    }),
  join: (code: string, name: string, ball: number) =>
    rpc<JoinResult>('join_tournament', { p_code: code, p_name: name, p_ball: ball }),
  removePlayer: (tid: string, adminToken: string, playerId: string) =>
    rpc<void>('admin_remove_player', { p_tid: tid, p_admin_token: adminToken, p_player: playerId }),
  advance: (tid: string, adminToken: string, matches: NewMatch[], status: TournamentStatus) =>
    rpc<void>('admin_advance', { p_tid: tid, p_admin_token: adminToken, p_matches: matches, p_status: status }),
  startMatch: (matchId: string, token: string) => rpc<void>('start_match', { p_match: matchId, p_token: token }),
  liveScore: (matchId: string, token: string, a: number, b: number) =>
    rpc<void>('update_live_score', { p_match: matchId, p_token: token, p_a: a, p_b: b }),
  report: (matchId: string, token: string, a: number, b: number) =>
    rpc<void>('report_result', { p_match: matchId, p_token: token, p_a: a, p_b: b }),
  confirm: (matchId: string, token: string) => rpc<void>('confirm_result', { p_match: matchId, p_token: token }),
  dispute: (matchId: string, token: string, a: number, b: number) =>
    rpc<void>('dispute_result', { p_match: matchId, p_token: token, p_a: a, p_b: b })
};

export interface TournamentData {
  tournament: Tournament;
  players: Player[];
  matches: Match[];
}

async function load(code: string): Promise<TournamentData | null> {
  const { data: t, error } = await supabase.from('tournaments').select('*').eq('code', code.toUpperCase()).maybeSingle();
  if (error) throw new ApiError('Connection problem. Check your internet and try again.');
  if (!t) return null;
  const [{ data: players }, { data: matches }] = await Promise.all([
    supabase.from('players').select('*').eq('tournament_id', t.id).order('created_at'),
    supabase.from('matches').select('*').eq('tournament_id', t.id)
  ]);
  return { tournament: t as Tournament, players: (players ?? []) as Player[], matches: (matches ?? []) as Match[] };
}

/**
 * Loads a tournament by code and keeps it fresh: realtime changes trigger a
 * (debounced) reload, and so does coming back to the app after the phone slept.
 */
export function useTournament(code: string) {
  const [data, setData] = useState<TournamentData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const d = await load(code);
      if (!d) { setState('missing'); return; }
      setData(d);
      setState('ready');
    } catch {
      setState((s) => (s === 'ready' ? s : 'error'));
    }
  }, [code]);

  const soon = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(refresh, 150);
  }, [refresh]);

  useEffect(() => { refresh(); }, [refresh]);

  const tid = data?.tournament.id;
  useEffect(() => {
    if (!tid) return;
    const channel = supabase
      .channel(`t-${tid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: `tournament_id=eq.${tid}` }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `tournament_id=eq.${tid}` }, soon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tournaments', filter: `id=eq.${tid}` }, soon)
      .subscribe();
    const onVisible = () => { if (document.visibilityState === 'visible') soon(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', soon);
    // safety net in case a realtime message is missed (e.g. player deletions)
    const poll = window.setInterval(soon, 20000);
    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', soon);
      window.clearInterval(poll);
    };
  }, [tid, soon]);

  return { data, state, refresh };
}

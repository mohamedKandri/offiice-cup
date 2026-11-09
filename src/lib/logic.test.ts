import { describe, expect, it } from 'vitest';
import {
  championOf, firstKnockoutRound, leagueMatches, nextStep, roundRobin, seedOrder, standings
} from './logic';
import { DEFAULT_SETTINGS, type Match, type NewMatch, type Player, type Tournament } from './types';

const mkPlayers = (n: number): Player[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`, tournament_id: 't', name: `P${i + 1}`, ball: (i % 8) + 1, is_admin: i === 0, created_at: ''
  }));

let idSeq = 0;
const toMatch = (m: NewMatch, a = 0, b = 0, status: Match['status'] = 'confirmed'): Match => ({
  id: `m${idSeq++}`, tournament_id: 't', stage: m.stage, round: m.round, slot: m.slot,
  player_a: m.player_a, player_b: m.player_b, race: m.race,
  score_a: m.score_a ?? a, score_b: m.score_b ?? b, status: m.status ?? status,
  table_no: null, reported_by: null, dispute: null, updated_at: ''
});

const tour = (over: Partial<Tournament> = {}): Tournament => ({
  id: 't', code: 'BIL-TEST', name: 'Test', format: 'league_playoff',
  settings: { ...DEFAULT_SETTINGS }, status: 'lobby', created_at: '', ...over
});

describe('roundRobin', () => {
  for (const n of [2, 3, 4, 5, 8, 9]) {
    it(`pairs every player exactly once with ${n} players`, () => {
      const ids = mkPlayers(n).map((p) => p.id);
      const rounds = roundRobin(ids);
      const seen = new Set<string>();
      for (const round of rounds) {
        const inRound = new Set<string>();
        for (const [a, b] of round) {
          expect(inRound.has(a) || inRound.has(b)).toBe(false); // nobody plays twice in a round
          inRound.add(a); inRound.add(b);
          const key = [a, b].sort().join('-');
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
      expect(seen.size).toBe((n * (n - 1)) / 2);
    });
  }
});

describe('standings', () => {
  it('counts points and frame difference, breaking ties head-to-head first', () => {
    const [a, b, c] = mkPlayers(3);
    const ms = [
      toMatch({ stage: 'league', round: 1, slot: 0, player_a: a.id, player_b: b.id, race: 3 }, 3, 0), // A beats B
      toMatch({ stage: 'league', round: 2, slot: 0, player_a: b.id, player_b: c.id, race: 3 }, 3, 2), // B beats C
      toMatch({ stage: 'league', round: 3, slot: 0, player_a: c.id, player_b: a.id, race: 3 }, 3, 0)  // C beats A
    ];
    // all on 3 pts, all 1 h2h win → frame diff: A +0, B -2, C +2
    const t = standings([a, b, c], ms, 3);
    expect(t.map((r) => r.player.id)).toEqual(['p3', 'p1', 'p2']);
    expect(t[0].points).toBe(3);
  });

  it('puts the head-to-head winner first on equal points', () => {
    const [a, b, c, d] = mkPlayers(4);
    const ms = [
      toMatch({ stage: 'league', round: 1, slot: 0, player_a: a.id, player_b: b.id, race: 3 }, 2, 3), // B beats A
      toMatch({ stage: 'league', round: 1, slot: 1, player_a: a.id, player_b: c.id, race: 3 }, 3, 0),
      toMatch({ stage: 'league', round: 1, slot: 2, player_a: a.id, player_b: d.id, race: 3 }, 3, 0),
      toMatch({ stage: 'league', round: 2, slot: 0, player_a: b.id, player_b: c.id, race: 3 }, 0, 3)
    ];
    // A: 2 wins (+4), B: 1 win... make B 2 wins:
    ms.push(toMatch({ stage: 'league', round: 2, slot: 1, player_a: b.id, player_b: d.id, race: 3 }, 3, 2));
    const t = standings([a, b, c, d], ms, 3);
    // A and B both 6 pts; A has better frame diff but B won head-to-head
    expect(t[0].player.id).toBe('p2');
    expect(t[1].player.id).toBe('p1');
  });

  it('ignores unconfirmed matches', () => {
    const [a, b] = mkPlayers(2);
    const ms = [toMatch({ stage: 'league', round: 1, slot: 0, player_a: a.id, player_b: b.id, race: 3 }, 3, 1, 'pending')];
    expect(standings([a, b], ms, 3).every((r) => r.played === 0)).toBe(true);
  });
});

describe('knockout', () => {
  it('seeds 1v4 and 2v3 in a four-player bracket', () => {
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    const r = firstKnockoutRound(['s1', 's2', 's3', 's4'], 3);
    expect(r.map((m) => [m.player_a, m.player_b])).toEqual([['s1', 's4'], ['s2', 's3']]);
  });

  it('gives byes to the top seeds when the field is not a power of two', () => {
    const r = firstKnockoutRound(['s1', 's2', 's3', 's4', 's5', 's6'], 3);
    expect(r).toHaveLength(4);
    const byes = r.filter((m) => m.player_b === null).map((m) => m.player_a);
    expect(byes.sort()).toEqual(['s1', 's2']);
    expect(r.filter((m) => m.player_b === null).every((m) => m.status === 'confirmed')).toBe(true);
  });
});

describe('nextStep: a full league + top 4 tournament', () => {
  it('goes lobby → league → semis → final → finished', () => {
    const players = mkPlayers(5);
    let t = tour();
    let matches: Match[] = [];

    let step = nextStep(t, players, matches);
    expect(step.kind).toBe('advance');
    if (step.kind !== 'advance') return;
    expect(step.matches).toHaveLength(10);
    // lower player number always wins 3-1 → final order p1..p5
    matches = step.matches.map((m) => {
      const aWins = Number(m.player_a.slice(1)) < Number(m.player_b!.slice(1));
      return toMatch(m, aWins ? 3 : 1, aWins ? 1 : 3);
    });
    t = { ...t, status: 'league' };

    step = nextStep(t, players, matches);
    expect(step.kind === 'advance' && step.label).toBe('Start playoffs');
    if (step.kind !== 'advance') return;
    expect(step.matches.map((m) => [m.player_a, m.player_b])).toEqual([['p1', 'p4'], ['p2', 'p3']]);
    matches = [...matches, ...step.matches.map((m) => toMatch(m, 3, 0))]; // p1 and p2 win
    t = { ...t, status: 'playoffs' };

    step = nextStep(t, players, matches);
    expect(step.kind === 'advance' && step.label).toBe('Start final');
    if (step.kind !== 'advance') return;
    expect(step.matches).toHaveLength(1);
    expect([step.matches[0].player_a, step.matches[0].player_b]).toEqual(['p1', 'p2']);
    matches = [...matches, toMatch(step.matches[0], 1, 3)]; // p2 wins the final

    step = nextStep(t, players, matches);
    expect(step.kind === 'advance' && step.status).toBe('finished');
    t = { ...t, status: 'finished' };
    expect(championOf(t, players, matches)?.id).toBe('p2');
  });

  it('adds a 3rd-place match when enabled', () => {
    const players = mkPlayers(4);
    const t = tour({ status: 'playoffs', settings: { ...DEFAULT_SETTINGS, thirdPlace: true } });
    const semis = firstKnockoutRound(['p1', 'p2', 'p3', 'p4'], 3).map((m) => toMatch(m, 3, 1));
    const step = nextStep(t, players, semis);
    expect(step.kind === 'advance' && step.matches.map((m) => m.stage)).toEqual(['playoff', 'third']);
  });

  it('waits while league matches are open', () => {
    const players = mkPlayers(3);
    const ms = leagueMatches(players, 3).map((m) => toMatch(m, 0, 0, 'scheduled'));
    const step = nextStep(tour({ status: 'league' }), players, ms);
    expect(step.kind).toBe('wait');
  });
});

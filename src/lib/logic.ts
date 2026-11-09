import type { Match, NewMatch, Player, Settings, Tournament, TournamentStatus } from './types';

// ---------------------------------------------------------------------------
// League (round robin)
// ---------------------------------------------------------------------------

const BYE = '__bye__';

/** Circle-method round robin. Every player meets every other player once. */
export function roundRobin(ids: string[]): [string, string][][] {
  const list = [...ids];
  if (list.length % 2 === 1) list.push(BYE);
  const n = list.length;
  const rounds: [string, string][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: [string, string][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a === BYE || b === BYE) continue;
      // alternate who is listed first so nobody is always "player A"
      pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(pairs);
    list.splice(1, 0, list.pop()!); // keep list[0] fixed, rotate the rest
  }
  return rounds;
}

export function leagueMatches(players: Player[], race: number): NewMatch[] {
  const rounds = roundRobin(players.map((p) => p.id));
  return rounds.flatMap((pairs, r) =>
    pairs.map(([a, b], slot) => ({ stage: 'league' as const, round: r + 1, slot, player_a: a, player_b: b, race }))
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export function winnerOf(m: Match): string | null {
  if (m.status !== 'confirmed') return null;
  if (m.player_b === null) return m.player_a;
  return m.score_a > m.score_b ? m.player_a : m.player_b;
}

export function loserOf(m: Match): string | null {
  if (m.status !== 'confirmed' || m.player_b === null) return null;
  return m.score_a > m.score_b ? m.player_b : m.player_a;
}

// ---------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------

export interface StandingRow {
  player: Player;
  played: number;
  won: number;
  lost: number;
  framesFor: number;
  framesAgainst: number;
  frameDiff: number;
  points: number;
}

/**
 * League table from confirmed league matches.
 * Order: points, then head-to-head among the tied players, then frame
 * difference, then frames won, then name.
 */
export function standings(players: Player[], matches: Match[], winPoints: number): StandingRow[] {
  const rows = new Map<string, StandingRow>();
  for (const p of players) {
    rows.set(p.id, { player: p, played: 0, won: 0, lost: 0, framesFor: 0, framesAgainst: 0, frameDiff: 0, points: 0 });
  }
  const league = matches.filter((m) => m.stage === 'league' && m.status === 'confirmed' && m.player_b);
  for (const m of league) {
    const a = rows.get(m.player_a);
    const b = rows.get(m.player_b!);
    if (!a || !b) continue;
    a.played++; b.played++;
    a.framesFor += m.score_a; a.framesAgainst += m.score_b;
    b.framesFor += m.score_b; b.framesAgainst += m.score_a;
    if (m.score_a > m.score_b) { a.won++; b.lost++; a.points += winPoints; }
    else { b.won++; a.lost++; b.points += winPoints; }
  }
  for (const r of rows.values()) r.frameDiff = r.framesFor - r.framesAgainst;

  const sorted = [...rows.values()].sort((x, y) => y.points - x.points);
  const result: StandingRow[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j].points === sorted[i].points) j++;
    const group = sorted.slice(i, j);
    if (group.length > 1) {
      const ids = new Set(group.map((g) => g.player.id));
      const h2h = new Map<string, number>(group.map((g) => [g.player.id, 0]));
      for (const m of league) {
        if (ids.has(m.player_a) && ids.has(m.player_b!)) {
          const w = m.score_a > m.score_b ? m.player_a : m.player_b!;
          h2h.set(w, (h2h.get(w) ?? 0) + 1);
        }
      }
      group.sort((x, y) =>
        (h2h.get(y.player.id)! - h2h.get(x.player.id)!) ||
        (y.frameDiff - x.frameDiff) ||
        (y.framesFor - x.framesFor) ||
        x.player.name.localeCompare(y.player.name)
      );
    }
    result.push(...group);
    i = j;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Knockout
// ---------------------------------------------------------------------------

export function nextPow2(n: number): number {
  let p = 2;
  while (p < n) p *= 2;
  return p;
}

export function largestPow2AtMost(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

/** Standard bracket seed order, e.g. 4 → [1,4,2,3], 8 → [1,8,4,5,2,7,3,6]. */
export function seedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

/** First knockout round. `seeded` is best-first. Missing opponents become byes (auto-wins). */
export function firstKnockoutRound(seeded: string[], race: number): NewMatch[] {
  const size = nextPow2(seeded.length);
  const order = seedOrder(size);
  const out: NewMatch[] = [];
  for (let i = 0; i < size / 2; i++) {
    const a = seeded[order[2 * i] - 1];
    const b = seeded[order[2 * i + 1] - 1] ?? null;
    out.push(
      b === null
        ? { stage: 'playoff', round: 1, slot: i, player_a: a, player_b: null, race, status: 'confirmed', score_a: race, score_b: 0 }
        : { stage: 'playoff', round: 1, slot: i, player_a: a, player_b: b, race }
    );
  }
  return out;
}

/** Number of knockout rounds once round 1 exists (2 matches in round 1 → 2 rounds). */
export function totalKnockoutRounds(matches: Match[]): number {
  const r1 = matches.filter((m) => m.stage === 'playoff' && m.round === 1).length;
  if (r1 === 0) return 0;
  return Math.round(Math.log2(r1 * 2));
}

export function roundName(round: number, total: number): string {
  const fromEnd = total - round;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semi-finals';
  if (fromEnd === 2) return 'Quarter-finals';
  return `Round of ${2 ** (fromEnd + 1)}`;
}

/** Shuffle for a fair random knockout draw. */
export function shuffle<T>(arr: T[], rand: () => number = Math.random): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// What can the admin do next?
// ---------------------------------------------------------------------------

export type NextStep =
  | { kind: 'advance'; label: string; detail: string; matches: NewMatch[]; status: TournamentStatus }
  | { kind: 'wait'; detail: string }
  | { kind: 'done' };

export function nextStep(t: Tournament, players: Player[], matches: Match[]): NextStep {
  const s: Settings = t.settings;

  if (t.status === 'lobby') {
    if (players.length < 2) return { kind: 'wait', detail: 'At least 2 players are needed.' };
    if (t.format === 'knockout') {
      const ms = firstKnockoutRound(shuffle(players).map((p) => p.id), s.race);
      return { kind: 'advance', label: 'Start tournament', detail: `Random draw · ${ms.filter((m) => m.player_b).length} first-round matches`, matches: ms, status: 'playoffs' };
    }
    const ms = leagueMatches(players, s.race);
    return { kind: 'advance', label: 'Start tournament', detail: `${ms.length} league matches`, matches: ms, status: 'league' };
  }

  if (t.status === 'league') {
    const league = matches.filter((m) => m.stage === 'league');
    const left = league.filter((m) => m.status !== 'confirmed').length;
    if (left > 0) return { kind: 'wait', detail: `${left} league ${left === 1 ? 'match' : 'matches'} left` };
    if (t.format === 'league') return { kind: 'advance', label: 'Finish tournament', detail: 'All league matches are done.', matches: [], status: 'finished' };
    const table = standings(players, matches, s.winPoints);
    const n = Math.min(largestPow2AtMost(Math.max(2, s.playoffSize)), largestPow2AtMost(players.length));
    const seeded = table.slice(0, n).map((r) => r.player.id);
    const ms = firstKnockoutRound(seeded, s.playoffRace);
    return { kind: 'advance', label: 'Start playoffs', detail: `Top ${n} qualify`, matches: ms, status: 'playoffs' };
  }

  if (t.status === 'playoffs') {
    const ko = matches.filter((m) => m.stage === 'playoff');
    const third = matches.filter((m) => m.stage === 'third');
    if (ko.length === 0) return { kind: 'wait', detail: 'No playoff matches yet.' };
    const maxRound = Math.max(...ko.map((m) => m.round));
    const current = ko.filter((m) => m.round === maxRound).sort((a, b) => a.slot - b.slot);
    const open = [...current, ...third].filter((m) => m.status !== 'confirmed').length;
    if (open > 0) return { kind: 'wait', detail: `${open} playoff ${open === 1 ? 'match' : 'matches'} left` };
    if (current.length === 1) return { kind: 'advance', label: 'Crown the champion', detail: 'The final is confirmed.', matches: [], status: 'finished' };

    const race = t.format === 'knockout' ? s.race : s.playoffRace;
    const next: NewMatch[] = [];
    for (let j = 0; j < current.length / 2; j++) {
      next.push({ stage: 'playoff', round: maxRound + 1, slot: j, player_a: winnerOf(current[2 * j])!, player_b: winnerOf(current[2 * j + 1])!, race });
    }
    if (current.length === 2 && s.thirdPlace) {
      const la = loserOf(current[0]);
      const lb = loserOf(current[1]);
      if (la && lb) next.push({ stage: 'third', round: maxRound + 1, slot: 0, player_a: la, player_b: lb, race });
    }
    const total = totalKnockoutRounds(matches);
    return { kind: 'advance', label: `Start ${roundName(maxRound + 1, total).toLowerCase()}`, detail: 'Winners move on.', matches: next, status: 'playoffs' };
  }

  return { kind: 'done' };
}

/** Champion once finished: final winner, or league leader for a pure league. */
export function championOf(t: Tournament, players: Player[], matches: Match[]): Player | null {
  if (t.status !== 'finished') return null;
  const byId = new Map(players.map((p) => [p.id, p]));
  if (t.format === 'league') {
    return standings(players, matches, t.settings.winPoints)[0]?.player ?? null;
  }
  const ko = matches.filter((m) => m.stage === 'playoff');
  if (ko.length === 0) return null;
  const maxRound = Math.max(...ko.map((m) => m.round));
  const final = ko.find((m) => m.round === maxRound);
  const w = final ? winnerOf(final) : null;
  return w ? byId.get(w) ?? null : null;
}

/** Matches still to play, in schedule order. */
export function upcoming(matches: Match[]): Match[] {
  const stageOrder = { league: 0, playoff: 1, third: 1 } as const;
  return matches
    .filter((m) => m.status === 'scheduled' && m.player_b)
    .sort((a, b) => stageOrder[a.stage] - stageOrder[b.stage] || a.round - b.round || a.slot - b.slot);
}

export function formatLabel(t: Pick<Tournament, 'format' | 'settings'>): string {
  if (t.format === 'league') return 'League';
  if (t.format === 'knockout') return 'Knockout';
  return `League + Top ${t.settings.playoffSize}`;
}

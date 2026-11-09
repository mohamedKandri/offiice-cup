/** What this phone knows about a tournament: secret tokens for admin and/or player. */
export interface Session {
  tournamentId: string;
  code: string;
  name: string;
  adminToken?: string;
  playerId?: string;
  playerToken?: string;
  savedAt: number;
}

const KEY = 'bp:sessions:v1';

function readAll(): Record<string, Session> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Session>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode / storage full: the app still works for this visit */
  }
}

export function getSession(code: string): Session | undefined {
  return readAll()[code.toUpperCase()];
}

export function saveSession(s: Omit<Session, 'savedAt'>) {
  const all = readAll();
  const prev = all[s.code] ?? {};
  all[s.code] = { ...prev, ...s, savedAt: Date.now() };
  writeAll(all);
}

export function forgetSession(code: string) {
  const all = readAll();
  delete all[code];
  writeAll(all);
}

export function listSessions(): Session[] {
  return Object.values(readAll()).sort((a, b) => b.savedAt - a.savedAt);
}

const LAST_PROFILE = 'bp:profile:v1';
export function lastProfile(): { name: string; ball: number } | null {
  try {
    return JSON.parse(localStorage.getItem(LAST_PROFILE) ?? 'null');
  } catch {
    return null;
  }
}
export function rememberProfile(name: string, ball: number) {
  try {
    localStorage.setItem(LAST_PROFILE, JSON.stringify({ name, ball }));
  } catch {
    /* ignore */
  }
}

import type { Env, Score } from './types';

export type MatchEvent = {
  ts: number;            // wall-clock ms when the event was detected
  type: 'wicket' | '4' | '6' | 'fifty' | 'hundred' | 'team-milestone' | 'moment';
  over: string;          // e.g. "12.3"
  innings: number;
  batter?: string;
  bowler?: string;
  runs?: number;         // for milestone events
  context?: string;      // freeform e.g. "c PATEL b KHAN"
  endTs?: number;        // explicit clip end (ms wall-clock); used by /embed/clip
  note?: string;         // freeform scorer caption (mainly for type='moment')
  manual?: boolean;      // true when stamped by an admin rather than scrape-detected
};

function eventsKey(matchId: string): string {
  return `events:${matchId}`;
}
function lastSeenKey(matchId: string): string {
  return `events:${matchId}:last`;
}

export async function readEvents(env: Env, matchId: string): Promise<MatchEvent[]> {
  const raw = await env.CRICKET_CACHE.get(eventsKey(matchId));
  if (!raw) return [];
  try { return JSON.parse(raw) as MatchEvent[]; } catch { return []; }
}

/**
 * Append a manual event and auto-close the most-recent open manual event by
 * setting its `endTs` to this event's `ts`. Returns the full updated list.
 *
 * Used by `POST /[scope]/api/admin/stamp/:matchId` — back-to-back stamps
 * therefore self-bound for `/embed/clip` without the scorer marking an end.
 */
export async function appendEvent(env: Env, matchId: string, evt: MatchEvent): Promise<MatchEvent[]> {
  const existing = await readEvents(env, matchId);
  for (let i = existing.length - 1; i >= 0; i--) {
    const e = existing[i];
    if (e.manual && !e.endTs) {
      existing[i] = { ...e, endTs: evt.ts };
      break;
    }
  }
  const combined = existing.concat(evt);
  await env.CRICKET_CACHE.put(eventsKey(matchId), JSON.stringify(combined));
  return combined;
}

type LastSeen = {
  innings: number;
  overs: string;
  runs: number;
  wickets: number;
  batterRunsByName: Record<string, number>;
  recentBallsSig?: string;
};

function ballSig(b: { runs?: number; isWicket?: boolean; isFour?: boolean; isSix?: boolean }): string {
  return [b.runs ?? 0, b.isWicket?1:0, b.isFour?1:0, b.isSix?1:0].join(',');
}

function recentBallsSig(score: Score): string {
  return (score.recentBalls ?? []).map(ballSig).join('|');
}

const TEAM_MILESTONES = [50, 100, 150, 200, 250, 300, 350, 400];

/** Detect new events by diffing prev → next, append to events list. Idempotent on identical scores. */
export async function detectAndAppendEvents(env: Env, score: Score): Promise<void> {
  if (score.error || !score.matchId) return;
  const matchId = score.matchId;
  const prevRaw = await env.CRICKET_CACHE.get(lastSeenKey(matchId));
  const prev: LastSeen | null = prevRaw ? safeJson<LastSeen>(prevRaw) : null;

  const next: LastSeen = {
    innings: score.innings,
    overs: score.overs,
    runs: score.runs,
    wickets: score.wickets,
    batterRunsByName: Object.fromEntries((score.batters ?? []).map((b) => [b.name, b.runs])),
    recentBallsSig: recentBallsSig(score),
  };

  // Always persist the latest snapshot for next diff.
  await env.CRICKET_CACHE.put(lastSeenKey(matchId), JSON.stringify(next));

  // Skip event detection on first sighting (we have no baseline).
  if (!prev) return;
  // Skip if innings changed (mid-innings restart, breaks comparisons).
  if (prev.innings !== next.innings) return;
  // Skip if recentBalls hasn't changed — nothing new happened.
  if (prev.recentBallsSig === next.recentBallsSig) {
    // But still check milestones — possible the score was already past 50 when we first saw the match.
  }

  const newEvents: MatchEvent[] = [];
  const ts = Date.now();
  const striker = (score.batters ?? [])[0];
  const bowler = score.bowler;

  // Wicket: wickets count went up.
  if (next.wickets > prev.wickets) {
    newEvents.push({
      ts,
      type: 'wicket',
      over: score.overs,
      innings: score.innings,
      batter: score.lastDismissal?.batter,
      bowler: bowler?.name,
      context: score.lastDismissal?.dismissalText,
    });
  }

  // 4 or 6: look at last entry of recentBalls.
  const lastBall = (score.recentBalls ?? [])[score.recentBalls?.length ? score.recentBalls.length - 1 : -1];
  if (lastBall && prev.recentBallsSig !== next.recentBallsSig) {
    if (lastBall.isFour) {
      newEvents.push({ ts, type: '4', over: score.overs, innings: score.innings, batter: striker?.name, bowler: bowler?.name });
    } else if (lastBall.isSix) {
      newEvents.push({ ts, type: '6', over: score.overs, innings: score.innings, batter: striker?.name, bowler: bowler?.name });
    }
  }

  // Batter milestones: check each currently-at-crease batter for crossing 50/100.
  for (const b of score.batters ?? []) {
    const prevRuns = prev.batterRunsByName[b.name] ?? 0;
    if (prevRuns < 50 && b.runs >= 50 && b.runs < 100) {
      newEvents.push({ ts, type: 'fifty', over: score.overs, innings: score.innings, batter: b.name, runs: b.runs });
    }
    if (prevRuns < 100 && b.runs >= 100) {
      newEvents.push({ ts, type: 'hundred', over: score.overs, innings: score.innings, batter: b.name, runs: b.runs });
    }
  }

  // Team milestone: crossing a 50-multiple.
  for (const m of TEAM_MILESTONES) {
    if (prev.runs < m && next.runs >= m) {
      newEvents.push({ ts, type: 'team-milestone', over: score.overs, innings: score.innings, runs: m });
    }
  }

  if (!newEvents.length) return;
  const existing = await readEvents(env, matchId);
  const combined = existing.concat(newEvents);
  await env.CRICKET_CACHE.put(eventsKey(matchId), JSON.stringify(combined));
}

function safeJson<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

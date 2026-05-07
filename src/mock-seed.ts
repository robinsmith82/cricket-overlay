// Seed a fake match into KV for end-to-end demos.
//
// Writes synthetic data under a chosen matchId so every v2 surface
// (highlights, summary, reel, share cards, embed/clip) immediately shows
// rich content without needing a live match:
//
//   events:{matchId}        — wickets / 4 / 6 / 50 / 100 / team milestones
//                             stamped over the last 90 minutes wall-clock
//   tag:{matchId}:…         — wagon-wheel ball tags (zone + shot)
//   vibe:{matchId}:…        — emoji reaction counters
//   score:{matchId}:last_good — final-state score so /summary hero renders
//   final-state:{matchId}:1   — sealed end-of-innings-1 snapshot for the
//                               D1 archive's `innings` table
//   final-state:{matchId}:2   — sealed end-of-innings-2 snapshot ditto
//
// Deliberately deterministic-ish — same matchId reseeds the same shape
// (cleared first), so demos are stable.

import type { Env, Score, BallEvent, Batter } from './types';
import type { MatchEvent } from './events';
import type { BallTag, ShotType } from './archive';

// Cricket-y names so the mock looks plausible at a glance. No real people.
const BATTERS = ['R. Smith', 'J. Patel', 'K. Williams', 'A. Mehta', 'T. Edwards', 'S. Iqbal', 'M. Davies', 'O. Hassan'];
const BOWLERS = ['A. Khan', 'D. Roberts', 'L. Bell', 'P. Singh', 'C. Wright', 'N. Ahmed'];

const SHOTS: ShotType[] = ['drive', 'cut', 'pull', 'sweep', 'glance', 'defence', 'edge', 'slog'];

const EMOJIS = ['🔥', '😮', '🎯', '👏', '😂'];

/** Stable pseudo-random — Linear Congruential Generator seeded from a string. */
function rng(seed: string): () => number {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = ((s << 5) - s + seed.charCodeAt(i)) | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) / 0x100000000);
  };
}
const pick = <T>(rand: () => number, arr: T[]): T => arr[Math.floor(rand() * arr.length)];

export type SeedResult = {
  matchId: string;
  cleared: number;
  events: number;
  tags: number;
  vibes: number;
  durationMs: number;
};

/**
 * Seed `matchId` with a 38.5-over chase narrative. Call repeatedly to refresh.
 * Total writes: ~30 events + ~80 tags + ~50 vibe counters + 2 score keys ≈ 165 KV writes.
 */
export async function seedMockMatch(env: Env, matchId: string, scope: string): Promise<SeedResult> {
  const t0 = Date.now();
  const rand = rng(matchId + ':' + scope);
  const startedAt = Date.now() - 90 * 60 * 1000; // 90 minutes ago

  // ---- Clear any previous seed -----------------------------------------
  const cleared = await clearMatchKeys(env, matchId);

  // ---- Build event list ------------------------------------------------
  const events: MatchEvent[] = [];
  const battingTeam = 'Home CC 3rd XI';
  const bowlingTeam = 'Away CC 4th XI';
  const innings = 1;

  // Innings 1 narrative: 38.5 overs, 326/9 — top order tons, a few wickets,
  // peppered with 4s/6s. Times spread across last 90 mins evenly so YouTube
  // deep links work if youtube.startedAt is set ~now-90mins.
  const TOTAL_MS = 90 * 60 * 1000;
  const eventCount = 30;
  for (let i = 0; i < eventCount; i++) {
    const ts = startedAt + Math.floor((i / eventCount) * TOTAL_MS);
    const over = Math.floor(2 + (i / eventCount) * 36);
    const ball = 1 + Math.floor(rand() * 6);
    const r = rand();
    let evt: MatchEvent;
    const batter = pick(rand, BATTERS);
    const bowler = pick(rand, BOWLERS);
    if (r < 0.20) {
      evt = { ts, type: 'wicket', over: `${over}.${ball}`, innings, batter, bowler, context: ['c slip', 'b bowled', 'lbw', 'c keeper', 'c mid-on'][Math.floor(rand() * 5)] };
    } else if (r < 0.45) {
      evt = { ts, type: '6', over: `${over}.${ball}`, innings, batter, bowler };
    } else {
      evt = { ts, type: '4', over: `${over}.${ball}`, innings, batter, bowler };
    }
    events.push(evt);
  }
  // Throw in two 50s, one 100, two team milestones, deterministically placed.
  events.push({ ts: startedAt + 25 * 60 * 1000, type: 'fifty',  over: '12.4', innings, batter: 'J. Patel', runs: 51 });
  events.push({ ts: startedAt + 55 * 60 * 1000, type: 'fifty',  over: '24.1', innings, batter: 'R. Smith', runs: 53 });
  events.push({ ts: startedAt + 75 * 60 * 1000, type: 'hundred', over: '32.5', innings, batter: 'R. Smith', runs: 102 });
  events.push({ ts: startedAt + 18 * 60 * 1000, type: 'team-milestone', over: '8.2',  innings, runs: 100 });
  events.push({ ts: startedAt + 50 * 60 * 1000, type: 'team-milestone', over: '21.0', innings, runs: 200 });
  events.push({ ts: startedAt + 78 * 60 * 1000, type: 'team-milestone', over: '33.4', innings, runs: 300 });

  // Two manual `moment` stamps so the new highlights "stamp" UI and the
  // bounded-clip iframe (with explicit endTs) light up under mock data.
  const momentTs1 = startedAt + 40 * 60 * 1000;
  events.push({ ts: momentTs1, type: 'moment', over: '17.3', innings, manual: true, note: 'Big appeal turned down — replay it', endTs: momentTs1 + 18_000 });
  events.push({ ts: startedAt + 65 * 60 * 1000, type: 'moment', over: '28.2', innings, manual: true });

  events.sort((a, b) => a.ts - b.ts);

  // ---- Ball tags (wagon wheel + shot) ---------------------------------
  const tagWrites: Array<Promise<unknown>> = [];
  let tagCount = 0;
  for (let over = 1; over <= 38; over++) {
    for (let ball = 1; ball <= 6; ball++) {
      // ~30% of balls get tagged.
      if (rand() > 0.3) continue;
      const zone = Math.floor(rand() * 9); // 0..8
      const shot = rand() > 0.4 ? pick(rand, SHOTS) : undefined;
      const tag: BallTag = { zone, taggedAt: startedAt + (over * 60_000) + (ball * 9_000), shot };
      tagWrites.push(env.CRICKET_CACHE.put(`tag:${matchId}:${innings}:${over}.${ball}`, JSON.stringify(tag)));
      tagCount++;
    }
  }

  // ---- Vibes (emoji counters keyed off random events) -----------------
  const vibeWrites: Array<Promise<unknown>> = [];
  let vibeCount = 0;
  for (const e of events) {
    // Pick 0–3 emojis per event; weight wickets/sixes higher.
    const m = e.over.match(/^(\d+)\.(\d+)$/);
    if (!m) continue;
    const [, oStr, bStr] = m;
    const heat = e.type === 'wicket' || e.type === '6' || e.type === 'hundred' ? 3 : 1;
    const tries = 1 + Math.floor(rand() * 3) + heat;
    const counts: Record<string, number> = {};
    for (let i = 0; i < tries; i++) {
      const emoji = pick(rand, EMOJIS);
      counts[emoji] = (counts[emoji] ?? 0) + 1 + Math.floor(rand() * 3);
    }
    for (const [emoji, count] of Object.entries(counts)) {
      vibeWrites.push(env.CRICKET_CACHE.put(`vibe:${matchId}:${e.innings}:${oStr}.${bStr}:${emoji}`, String(count)));
      vibeCount++;
    }
  }

  // ---- Final score (so /summary hero is populated) --------------------
  const recentBalls: BallEvent[] = [
    { runs: 2 }, { runs: 0 }, { runs: 0, isWicket: true }, { runs: 1 }, { runs: 0 }, { runs: 4, isFour: true },
  ];
  const batters: Batter[] = [
    { name: 'R. Smith', runs: 136, balls: 128, notOut: true, onStrike: true },
    { name: 'J. Patel', runs: 91, balls: 93, notOut: true },
  ];
  const score: Score = {
    matchId,
    fetchedAt: new Date().toISOString(),
    status: 'finished',
    innings,
    battingTeam,
    bowlingTeam,
    runs: 326,
    wickets: 9,
    overs: '38.5',
    oversTotal: 40,
    batters,
    bowler: { name: 'A. Khan', overs: '12.5', maidens: 1, runs: 146, wickets: 3 },
    recentBalls,
    lastDismissal: { batter: 'M. Davies', runs: 14, balls: 22, dismissalText: 'c slip b A. Khan' },
    partnership: { runs: 227, balls: 221 },
    powerplay: null,
    source: 'mock',
  };

  // ---- Per-innings final-state snapshots ------------------------------
  // The D1 archive's `innings` table is fed from these `final-state:` keys.
  // Innings 1 final state mirrors the seeded `score`. Innings 2 is a
  // synthetic chase that finished, so the mock match exercises the
  // multiple-innings code path end-to-end (single innings would let the
  // bug — losing innings 1 — sneak back in unnoticed).
  const inningsOneFinal: Score = { ...score, innings: 1 };
  const inningsTwoFinal: Score = {
    matchId,
    fetchedAt: new Date().toISOString(),
    status: 'finished',
    innings: 2,
    battingTeam: bowlingTeam,
    bowlingTeam: battingTeam,
    runs: 248,
    wickets: 10,
    overs: '36.2',
    oversTotal: 40,
    target: 327,
    source: 'mock',
  };

  // ---- Persist all writes in parallel ----------------------------------
  const eventsRaw = JSON.stringify(events);
  await Promise.all([
    env.CRICKET_CACHE.put(`events:${matchId}`, eventsRaw),
    env.CRICKET_CACHE.put(`score:${matchId}`, JSON.stringify(score)),
    env.CRICKET_CACHE.put(`score:${matchId}:last_good`, JSON.stringify(score)),
    env.CRICKET_CACHE.put(`final-state:${matchId}:1`, JSON.stringify(inningsOneFinal)),
    env.CRICKET_CACHE.put(`final-state:${matchId}:2`, JSON.stringify(inningsTwoFinal)),
    env.CRICKET_CACHE.put(`score:${matchId}:last_innings`, '2'),
    ...tagWrites,
    ...vibeWrites,
  ]);

  return {
    matchId,
    cleared,
    events: events.length,
    tags: tagCount,
    vibes: vibeCount,
    durationMs: Date.now() - t0,
  };
}

/** Wipe every key for this matchId across all v2 stores. */
async function clearMatchKeys(env: Env, matchId: string): Promise<number> {
  let cleared = 0;
  for (const prefix of [`tag:${matchId}:`, `vibe:${matchId}:`, `vote:${matchId}:`, `final-state:${matchId}:`]) {
    const list = await env.CRICKET_CACHE.list({ prefix });
    await Promise.all(list.keys.map((k) => env.CRICKET_CACHE.delete(k.name)));
    cleared += list.keys.length;
  }
  await Promise.all([
    env.CRICKET_CACHE.delete(`events:${matchId}`),
    env.CRICKET_CACHE.delete(`events:${matchId}:last`),
    env.CRICKET_CACHE.delete(`tag-meta:${matchId}`),
    env.CRICKET_CACHE.delete(`score:${matchId}`),
    env.CRICKET_CACHE.delete(`score:${matchId}:last_good`),
    env.CRICKET_CACHE.delete(`score:${matchId}:last_innings`),
  ]);
  return cleared;
}

import type { Env, Score } from './types';
import { readEvents, type MatchEvent } from './events';
import { readAllBallTags } from './archive';

/**
 * D1 match archive.
 *
 * Live match data lives in KV (volatile, per-key, hard to query). When a match
 * ends we promote the permanent state — final score, events, ball tags — into
 * D1 so we get a queryable relational artifact for /player/:slug career pages,
 * head-to-head cards, and the eventual /archive search UI.
 *
 * One archive operation = one D1 batch transaction. Idempotent via
 * INSERT OR REPLACE so retries are safe.
 *
 * Note on the binding name: `LOG_DB` is what wrangler.toml calls the D1
 * binding. It was named for the scrape_log table but it's our only D1
 * database — everything goes here.
 */

export type ArchiveResult = {
  archived: true;
  balls: number;
  events: number;
  innings: number;
};

export type ArchivedInnings = {
  match_id: string;
  innings: number;
  batting_team: string | null;
  runs: number | null;
  wickets: number | null;
  overs: string | null;
  status: string | null;
};

export type ArchivedBall = {
  match_id: string;
  innings: number;
  over_num: number;
  ball_num: number;
  zone: number | null;
  shot: string | null;
  tagged_at: number | null;
};

export type ArchivedEvent = {
  match_id: string;
  idx: number;
  type: string;
  innings: number | null;
  over: string | null;
  batter: string | null;
  bowler: string | null;
  runs: number | null;
  context: string | null;
  ts: number | null;
};

export type ArchivedMatch = {
  match_id: string;
  scope: string;
  home_team: string | null;
  away_team: string | null;
  status: string | null;
  source_url: string | null;
  archived_at: number;
  total_events: number;
  total_balls: number;
};

export type ArchivedBundle = {
  match: ArchivedMatch;
  innings: ArchivedInnings[];
  events: ArchivedEvent[];
  balls: ArchivedBall[];
};

function lastGoodScoreKey(matchId: string): string {
  return `score:${matchId}:last_good`;
}

/** KV key for a sealed (innings-end) score snapshot. */
export function finalStateKey(matchId: string, innings: number): string {
  return `final-state:${matchId}:${innings}`;
}

/** KV key tracking the most-recently-seen innings number for a match. */
export function lastInningsPointerKey(matchId: string): string {
  return `score:${matchId}:last_innings`;
}

async function readFinalScore(env: Env, matchId: string): Promise<Score | null> {
  const raw = await env.CRICKET_CACHE.get(lastGoodScoreKey(matchId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Score;
  } catch {
    return null;
  }
}

/**
 * List every per-innings final-state snapshot we have for this match, sorted
 * by innings number ascending. Pre-rollout matches won't have any of these
 * keys; the caller should fall back to the single `score:<matchId>:last_good`.
 */
async function readAllFinalStateSnapshots(
  env: Env,
  matchId: string,
): Promise<Score[]> {
  const prefix = `final-state:${matchId}:`;
  const list = await env.CRICKET_CACHE.list({ prefix });
  if (!list.keys.length) return [];
  const raws = await Promise.all(
    list.keys.map((k) => env.CRICKET_CACHE.get(k.name)),
  );
  const scores: Score[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    try {
      scores.push(JSON.parse(raw) as Score);
    } catch {
      // Skip corrupt rows — we'd rather archive what we have than fail the
      // batch on a single malformed snapshot.
    }
  }
  scores.sort((a, b) => (a.innings ?? 0) - (b.innings ?? 0));
  return scores;
}

function buildSourceUrl(score: Score | null, matchId: string): string | null {
  if (!matchId) return null;
  if (score?.source === 'play-cricket') {
    return `https://play-cricket.com/website/results/${encodeURIComponent(matchId)}`;
  }
  if (score?.source === 'resultsvault') {
    return `https://www.resultsvault.com/m/${encodeURIComponent(matchId)}`;
  }
  return null;
}

/**
 * Promote a completed match from KV → D1.
 *
 * Reads events, ball tags, and the last-good score snapshot from KV; writes a
 * single batch transaction across `matches`, `innings`, `events`, `balls`.
 * Returns counts so the caller can log them.
 *
 * Throws on D1 failure — the caller decides how to handle. Unlike `logScrape`
 * we do *not* swallow errors here: silent corruption in the permanent archive
 * is much worse than silent corruption in an audit log.
 */
export async function archiveMatch(
  env: Env,
  matchId: string,
  scope = '',
): Promise<ArchiveResult> {
  if (!matchId) throw new Error('archiveMatch: matchId required');

  const [events, tags, score, perInnings] = await Promise.all([
    readEvents(env, matchId),
    readAllBallTags(env, matchId),
    readFinalScore(env, matchId),
    readAllFinalStateSnapshots(env, matchId),
  ]);

  const homeTeam = score?.battingTeam ?? null;
  const awayTeam = score?.bowlingTeam ?? null;
  const status = score?.status ?? null;
  const sourceUrl = buildSourceUrl(score, matchId);
  const archivedAt = Date.now();

  // Innings rows: prefer the per-innings sealed snapshots written at end of
  // each innings (`final-state:<matchId>:<innings>`), which preserve innings 1
  // even after the match has moved on to innings 2. Falls back to the single
  // `score:<matchId>:last_good` for pre-rollout matches that never got
  // per-innings snapshots — they'll archive with the old single-row
  // limitation, but at least they archive.
  const inningsRows: ArchivedInnings[] = [];
  const sourceSnapshots = perInnings.length > 0
    ? perInnings
    : (score && Number.isFinite(score.innings) ? [score] : []);
  for (const snap of sourceSnapshots) {
    if (!Number.isFinite(snap.innings)) continue;
    inningsRows.push({
      match_id: matchId,
      innings: snap.innings,
      batting_team: snap.battingTeam ?? null,
      runs: snap.runs ?? null,
      wickets: snap.wickets ?? null,
      overs: snap.overs ?? null,
      status: snap.status ?? null,
    });
  }

  const stmts: D1PreparedStatement[] = [];

  stmts.push(
    env.LOG_DB
      .prepare(
        `INSERT OR REPLACE INTO matches
          (match_id, scope, home_team, away_team, status, source_url, archived_at, total_events, total_balls)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .bind(
        matchId,
        scope,
        homeTeam,
        awayTeam,
        status,
        sourceUrl,
        archivedAt,
        events.length,
        tags.length,
      ),
  );

  for (const row of inningsRows) {
    stmts.push(
      env.LOG_DB
        .prepare(
          `INSERT OR REPLACE INTO innings
            (match_id, innings, batting_team, runs, wickets, overs, status)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(
          row.match_id,
          row.innings,
          row.batting_team,
          row.runs,
          row.wickets,
          row.overs,
          row.status,
        ),
    );
  }

  for (let i = 0; i < events.length; i++) {
    const e: MatchEvent = events[i];
    stmts.push(
      env.LOG_DB
        .prepare(
          `INSERT OR REPLACE INTO events
            (match_id, idx, type, innings, over, batter, bowler, runs, context, ts)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        )
        .bind(
          matchId,
          i,
          e.type,
          e.innings ?? null,
          e.over ?? null,
          e.batter ?? null,
          e.bowler ?? null,
          e.runs ?? null,
          e.context ?? null,
          e.ts ?? null,
        ),
    );
  }

  for (const t of tags) {
    stmts.push(
      env.LOG_DB
        .prepare(
          `INSERT OR REPLACE INTO balls
            (match_id, innings, over_num, ball_num, zone, shot, tagged_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(
          matchId,
          t.innings,
          t.over,
          t.ball,
          t.tag.zone ?? null,
          t.tag.shot ?? null,
          t.tag.taggedAt ?? null,
        ),
    );
  }

  try {
    await env.LOG_DB.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`archiveMatch(${matchId}): D1 batch failed: ${msg}`);
  }

  return {
    archived: true,
    balls: tags.length,
    events: events.length,
    innings: inningsRows.length,
  };
}

/** Has this match already been promoted to the archive? */
export async function isArchived(env: Env, matchId: string): Promise<boolean> {
  if (!matchId) return false;
  try {
    const row = await env.LOG_DB
      .prepare(`SELECT match_id FROM matches WHERE match_id = ?1 LIMIT 1`)
      .bind(matchId)
      .first<{ match_id: string }>();
    return !!row;
  } catch {
    // If the table doesn't exist yet (migration not applied), treat as not
    // archived — the next archive call will surface the real error.
    return false;
  }
}

/** Read everything we have for an archived match, or null if no row. */
export async function readArchivedMatch(
  env: Env,
  matchId: string,
): Promise<ArchivedBundle | null> {
  if (!matchId) return null;

  const matchRow = await env.LOG_DB
    .prepare(
      `SELECT match_id, scope, home_team, away_team, status, source_url, archived_at, total_events, total_balls
       FROM matches WHERE match_id = ?1 LIMIT 1`,
    )
    .bind(matchId)
    .first<ArchivedMatch>();
  if (!matchRow) return null;

  const [innings, events, balls] = await Promise.all([
    env.LOG_DB
      .prepare(
        `SELECT match_id, innings, batting_team, runs, wickets, overs, status
         FROM innings WHERE match_id = ?1 ORDER BY innings ASC`,
      )
      .bind(matchId)
      .all<ArchivedInnings>(),
    env.LOG_DB
      .prepare(
        `SELECT match_id, idx, type, innings, over, batter, bowler, runs, context, ts
         FROM events WHERE match_id = ?1 ORDER BY idx ASC`,
      )
      .bind(matchId)
      .all<ArchivedEvent>(),
    env.LOG_DB
      .prepare(
        `SELECT match_id, innings, over_num, ball_num, zone, shot, tagged_at
         FROM balls WHERE match_id = ?1
         ORDER BY innings ASC, over_num ASC, ball_num ASC`,
      )
      .bind(matchId)
      .all<ArchivedBall>(),
  ]);

  return {
    match: matchRow,
    innings: innings.results ?? [],
    events: events.results ?? [],
    balls: balls.results ?? [],
  };
}

/** Most recent N archived matches, for the admin index. */
export async function listArchivedMatches(
  env: Env,
  limit = 50,
): Promise<ArchivedMatch[]> {
  try {
    const res = await env.LOG_DB
      .prepare(
        `SELECT match_id, scope, home_team, away_team, status, source_url, archived_at, total_events, total_balls
         FROM matches ORDER BY archived_at DESC LIMIT ?1`,
      )
      .bind(limit)
      .all<ArchivedMatch>();
    return res.results ?? [];
  } catch {
    return [];
  }
}

/**
 * Capture a per-innings final-state snapshot when an innings ends.
 *
 * Two ways an innings ends:
 *   (a) the next scrape shows a higher innings number — the *previous* score
 *       snapshot is the sealed end-of-innings record.
 *   (b) the match status is terminal (finished/drawn/abandoned/no_result) —
 *       the *current* score snapshot is the sealed end-of-innings record.
 *
 * Writes are idempotent: once `final-state:<matchId>:<n>` exists we never
 * overwrite it, so a scraper retry or cache miss after the transition can't
 * clobber the true end-of-innings figures with a stale or post-resume number.
 *
 * Maintains a `score:<matchId>:last_innings` pointer so the next call can
 * detect (a) by comparing to the previous innings number.
 *
 * Called inline in the scrape pipeline. Errors are swallowed by the caller —
 * a broken snapshot must never break the live overlay.
 */
export async function recordInningsTransition(
  env: Env,
  fresh: Score,
): Promise<void> {
  if (!fresh.matchId) return;
  if (!Number.isFinite(fresh.innings) || fresh.innings <= 0) return;

  const pointerKey = lastInningsPointerKey(fresh.matchId);
  const prevPointerRaw = await env.CRICKET_CACHE.get(pointerKey);
  const prevInnings = prevPointerRaw ? parseInt(prevPointerRaw, 10) : NaN;

  // Case (a): innings advanced — seal the *previous* innings using the
  // last-good snapshot we have on hand (which still describes innings
  // prevInnings, since this fresh scrape is the first one to reflect the new
  // innings).
  if (Number.isFinite(prevInnings) && prevInnings > 0 && prevInnings < fresh.innings) {
    const prevKey = finalStateKey(fresh.matchId, prevInnings);
    const existing = await env.CRICKET_CACHE.get(prevKey);
    if (!existing) {
      const prevScoreRaw = await env.CRICKET_CACHE.get(lastGoodScoreKey(fresh.matchId));
      if (prevScoreRaw) {
        try {
          const prev = JSON.parse(prevScoreRaw) as Score;
          if (Number.isFinite(prev.innings) && prev.innings === prevInnings) {
            await env.CRICKET_CACHE.put(prevKey, prevScoreRaw);
          }
        } catch {
          // Corrupt last_good — nothing we can do; skip.
        }
      }
    }
  }

  // Case (b): match status is terminal — seal the current innings.
  if (isTerminalStatus(fresh)) {
    const curKey = finalStateKey(fresh.matchId, fresh.innings);
    const existing = await env.CRICKET_CACHE.get(curKey);
    if (!existing) {
      await env.CRICKET_CACHE.put(curKey, JSON.stringify(fresh));
    }
  }

  // Always keep the pointer up to date. We update it after the transition
  // detection so the comparison above sees the previous value.
  if (prevPointerRaw !== String(fresh.innings)) {
    await env.CRICKET_CACHE.put(pointerKey, String(fresh.innings));
  }
}

/**
 * Heuristic: does this status string indicate a terminal / completed match?
 * Used by the auto-archive trigger in the scrape pipeline.
 */
export function isTerminalStatus(score: Score): boolean {
  if (score.error) return false;
  if (score.status === 'finished' || score.status === 'drawn' || score.status === 'abandoned' || score.status === 'no_result') {
    return true;
  }
  return false;
}

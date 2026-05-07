import type { Env, Score } from './types';

/**
 * Append one row to the scrape_log D1 table for every real scrape attempt.
 *
 * Sets `changed=1` when (runs, wickets, overs, status) differ from the
 * previous row for the same match_id. Cache hits don't reach this function —
 * only actual `scrapeMatch()` results are logged. Logging failures are
 * swallowed: never let an audit-trail bug break a scrape.
 *
 * Concurrency: change-detection runs inside the INSERT itself (correlated
 * subquery against MAX(id) for this match) so two near-simultaneous scrapes
 * can't both compare against the same stale "previous" row. SQLite serializes
 * writes within the D1 instance, so the comparison sees whichever insert won
 * the storage-tier ordering. The id column is AUTOINCREMENT — no PK clashes.
 */
export async function logScrape(env: Env, score: Score): Promise<void> {
  try {
    await env.LOG_DB
      .prepare(
        `INSERT INTO scrape_log
          (ts, match_id, source, ok, status, runs, wickets, overs, batting_team, changed, error)
         SELECT
           ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
           CASE
             WHEN (
               SELECT runs || '|' || wickets || '|' || COALESCE(overs,'') || '|' || COALESCE(status,'')
               FROM scrape_log
               WHERE match_id = ?2
               ORDER BY id DESC LIMIT 1
             ) IS ?10 THEN 0 ELSE 1
           END,
           ?11`,
      )
      .bind(
        Date.now(),
        score.matchId,
        score.source ?? 'unknown',
        score.error ? 0 : 1,
        score.status,
        score.runs,
        score.wickets,
        score.overs,
        score.battingTeam,
        // Comparison key — must mirror the SELECT shape above
        `${score.runs}|${score.wickets}|${score.overs ?? ''}|${score.status ?? ''}`,
        score.error ?? null,
      )
      .run();
  } catch {
    // intentionally swallowed — logging must never break a scrape
  }
}

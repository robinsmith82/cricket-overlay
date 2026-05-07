import type { Env } from './types';

/**
 * Head-to-head lookups against the D1 archive.
 *
 * Surfaces prior meetings between two named teams using the `matches` and
 * `innings` tables (see migrations/0002_match_archive.sql). Used by the admin
 * discovery card ("vs OppoName — N archived meetings") and by a public
 * `/api/head-to-head` endpoint for ad-hoc / spectator-page use.
 *
 * Honest about its limits:
 *   - `summary.played` counts archived meetings only — not "all meetings ever".
 *     Pre-archive history is invisible to us by design.
 *   - Team-name matching is exact-after-lowercase-trim. We do NOT fuzzy-match
 *     "My Club 1st XI" vs "My Club 3rd XI" — the scraper hands us the
 *     canonical name, and if that misses some prior meetings, an empty card
 *     is acceptable.
 *   - Win attribution from the stored `status` enum is mostly impossible: the
 *     scraper normalises everything to live|finished|drawn|abandoned|… so we
 *     can only pull "drawn" out cleanly. For finished matches we fall back to
 *     comparing innings runs to attribute a winner; anything ambiguous gets
 *     bucketed as "result unknown" rather than guessed.
 */

export type H2HInnings = {
  innings: number;
  battingTeam: string | null;
  runs: number | null;
  wickets: number | null;
  overs: string | null;
};

export type H2HMatch = {
  matchId: string;
  scope: string;
  archivedAt: number;
  status: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  innings: H2HInnings[];
};

export type H2HSummary = {
  /** Archived meetings between the two teams. NOT "all meetings ever". */
  played: number;
  /** Meetings won by teamA (the first arg passed in). */
  aWins: number;
  /** Meetings won by teamB (the second arg passed in). */
  bWins: number;
  /** Drawn meetings (status === 'drawn'). */
  draws: number;
  /** Meetings whose result couldn't be parsed cleanly. */
  unknown: number;
};

export type H2HResult = {
  prior: H2HMatch[];
  summary: H2HSummary;
};

export type H2HOptions = {
  /** Most recent N meetings. Defaults to 5. */
  limit?: number;
};

const DEFAULT_LIMIT = 5;

function emptyResult(): H2HResult {
  return {
    prior: [],
    summary: { played: 0, aWins: 0, bWins: 0, draws: 0, unknown: 0 },
  };
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase();
}

type MatchRow = {
  match_id: string;
  scope: string;
  home_team: string | null;
  away_team: string | null;
  status: string | null;
  archived_at: number;
};

type InningsRow = {
  match_id: string;
  innings: number;
  batting_team: string | null;
  runs: number | null;
  wickets: number | null;
  overs: string | null;
};

/**
 * Decide who won a given archived match relative to teamA/teamB.
 *
 * Strategy (defensive — we'd rather say "unknown" than guess wrong):
 *   1. status === 'drawn' → 'draw'.
 *   2. status === 'finished' AND we have innings rows for both teams → compare
 *      total runs across innings. Higher run total wins. Equal totals → 'tie'
 *      (still drawn for summary purposes).
 *   3. Anything else → 'unknown'.
 *
 * Note we deliberately skip more aggressive parsing (e.g. "won by 5 wickets"
 * text in status) because the scraper normalises status to a small enum; the
 * raw result-description string isn't archived, so trying to parse it would
 * just fabricate confidence.
 */
function attribute(
  match: MatchRow,
  innings: InningsRow[],
  aNorm: string,
  bNorm: string,
): 'a' | 'b' | 'draw' | 'unknown' {
  const status = norm(match.status);
  if (status === 'drawn') return 'draw';
  if (status !== 'finished') return 'unknown';

  let aRuns = 0;
  let bRuns = 0;
  let aHasInnings = false;
  let bHasInnings = false;
  for (const row of innings) {
    const bt = norm(row.batting_team);
    const r = row.runs ?? 0;
    if (bt === aNorm) {
      aRuns += r;
      aHasInnings = true;
    } else if (bt === bNorm) {
      bRuns += r;
      bHasInnings = true;
    }
  }
  if (!aHasInnings || !bHasInnings) return 'unknown';
  if (aRuns > bRuns) return 'a';
  if (bRuns > aRuns) return 'b';
  return 'draw';
}

/**
 * Look up archived meetings between teamA and teamB.
 *
 * Names are matched case-insensitively (LOWER + trim) and order-independent —
 * (A vs B) and (B vs A) are treated as the same fixture. Returns the most
 * recent `opts.limit` meetings (default 5) with per-innings detail and a
 * summary of wins/losses/draws.
 *
 * Failures (D1 unavailable, missing migration, etc.) bubble up as thrown
 * errors. Callers that need to be defensive should wrap in try/catch.
 */
export async function getHeadToHead(
  env: Env,
  teamA: string,
  teamB: string,
  opts: H2HOptions = {},
): Promise<H2HResult> {
  const aNorm = norm(teamA);
  const bNorm = norm(teamB);
  if (!aNorm || !bNorm) return emptyResult();
  if (aNorm === bNorm) return emptyResult();

  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT));

  // Fixture order is unknown — bind both pairings (A vs B and B vs A).
  const matchesRes = await env.LOG_DB
    .prepare(
      `SELECT match_id, scope, home_team, away_team, status, archived_at
       FROM matches
       WHERE (LOWER(TRIM(home_team)) = ?1 AND LOWER(TRIM(away_team)) = ?2)
          OR (LOWER(TRIM(home_team)) = ?3 AND LOWER(TRIM(away_team)) = ?4)
       ORDER BY archived_at DESC
       LIMIT ?5`,
    )
    .bind(aNorm, bNorm, bNorm, aNorm, limit)
    .all<MatchRow>();

  const matches = matchesRes.results ?? [];
  if (matches.length === 0) return emptyResult();

  // Pull innings rows for all matched fixtures in one query so we don't fan
  // out N+1 reads against D1.
  const placeholders = matches.map((_, i) => `?${i + 1}`).join(',');
  const inningsRes = await env.LOG_DB
    .prepare(
      `SELECT match_id, innings, batting_team, runs, wickets, overs
       FROM innings
       WHERE match_id IN (${placeholders})
       ORDER BY match_id ASC, innings ASC`,
    )
    .bind(...matches.map((m) => m.match_id))
    .all<InningsRow>();

  const inningsByMatch = new Map<string, InningsRow[]>();
  for (const row of inningsRes.results ?? []) {
    const arr = inningsByMatch.get(row.match_id) ?? [];
    arr.push(row);
    inningsByMatch.set(row.match_id, arr);
  }

  const prior: H2HMatch[] = [];
  const summary: H2HSummary = {
    played: matches.length,
    aWins: 0,
    bWins: 0,
    draws: 0,
    unknown: 0,
  };

  for (const m of matches) {
    const innings = inningsByMatch.get(m.match_id) ?? [];
    const verdict = attribute(m, innings, aNorm, bNorm);
    if (verdict === 'a') summary.aWins += 1;
    else if (verdict === 'b') summary.bWins += 1;
    else if (verdict === 'draw') summary.draws += 1;
    else summary.unknown += 1;

    prior.push({
      matchId: m.match_id,
      scope: m.scope,
      archivedAt: m.archived_at,
      status: m.status,
      homeTeam: m.home_team,
      awayTeam: m.away_team,
      innings: innings.map((row) => ({
        innings: row.innings,
        battingTeam: row.batting_team,
        runs: row.runs,
        wickets: row.wickets,
        overs: row.overs,
      })),
    });
  }

  return { prior, summary };
}

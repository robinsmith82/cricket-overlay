import type { Env } from './types';
import type { ArchivedInnings, ArchivedMatch } from './match-archive';

/**
 * Public searchable browser for archived matches.
 *
 * Distinct from `match-archive.ts` (which writes the archive and reads whole
 * matches by id) and from `admin.ts`'s `/admin/archive` (which is an
 * admin-only management surface). This module powers the public `/archive`
 * page and `/api/archive/search` JSON endpoint.
 *
 * Filters:
 *   - q                — free-text against home_team, away_team, or any
 *                         player name appearing in the match's events.
 *   - team             — exact team match against home or away.
 *   - season           — calendar year (against archived_at).
 *   - hasFifty         — match has at least one fifty/hundred event.
 *   - wicketFirstOver  — match has a wicket event with over LIKE '0.%'.
 *
 * Every filter is bound as a parameter — never string-concatenated — so
 * arbitrary user input cannot inject SQL.
 */

export type ArchiveSearchFilters = {
  q?: string | null;
  team?: string | null;
  season?: number | null;
  hasFifty?: boolean;
  wicketFirstOver?: boolean;
  limit?: number;
  offset?: number;
};

export type ArchiveSearchInnings = {
  innings: number;
  battingTeam: string | null;
  runs: number | null;
  wickets: number | null;
  overs: string | null;
};

export type ArchiveSearchRow = {
  matchId: string;
  scope: string;
  homeTeam: string | null;
  awayTeam: string | null;
  status: string | null;
  archivedAt: number;
  totalEvents: number;
  totalBalls: number;
  innings: ArchiveSearchInnings[];
};

export type ArchiveSearchResult = {
  matches: ArchiveSearchRow[];
  total: number;
};

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Build a parameterised WHERE clause + binds list for a given filter set.
 * Returns `''` (no clause) and an empty binds array when there are no
 * filters. The `q` filter spans match-row fields *and* any event row's batter
 * or bowler — implemented via an EXISTS sub-select over the events table so
 * we don't have to GROUP BY.
 */
function buildWhere(filters: ArchiveSearchFilters): { sql: string; binds: unknown[] } {
  const clauses: string[] = [];
  const binds: unknown[] = [];

  const q = (filters.q ?? '').trim();
  if (q) {
    clauses.push(
      `(m.home_team LIKE ?
        OR m.away_team LIKE ?
        OR EXISTS (
          SELECT 1 FROM events e
          WHERE e.match_id = m.match_id
            AND (e.batter LIKE ? OR e.bowler LIKE ?)
        ))`,
    );
    const like = `%${q}%`;
    binds.push(like, like, like, like);
  }

  const team = (filters.team ?? '').trim();
  if (team) {
    clauses.push(`(m.home_team = ? OR m.away_team = ?)`);
    binds.push(team, team);
  }

  if (filters.season != null && Number.isFinite(filters.season)) {
    const year = Math.floor(filters.season);
    const start = Date.UTC(year, 0, 1);
    const end = Date.UTC(year + 1, 0, 1);
    clauses.push(`m.archived_at >= ? AND m.archived_at < ?`);
    binds.push(start, end);
  }

  if (filters.hasFifty) {
    clauses.push(
      `EXISTS (
        SELECT 1 FROM events e
        WHERE e.match_id = m.match_id
          AND e.type IN ('fifty', 'hundred')
      )`,
    );
  }

  if (filters.wicketFirstOver) {
    clauses.push(
      `EXISTS (
        SELECT 1 FROM events e
        WHERE e.match_id = m.match_id
          AND e.type = 'wicket'
          AND e.over LIKE '0.%'
      )`,
    );
  }

  if (!clauses.length) return { sql: '', binds: [] };
  return { sql: `WHERE ${clauses.join(' AND ')}`, binds };
}

/**
 * Search the archive. One D1 query for the filtered match list (with COUNT(*)
 * for total), then a single follow-up query loading all innings rows for the
 * matches we returned. Avoids N+1 and keeps the work proportional to the
 * page size.
 */
export async function searchArchive(
  env: Env,
  filters: ArchiveSearchFilters,
): Promise<ArchiveSearchResult> {
  const limit = clampInt(filters.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(filters.offset, 0, 0, 1_000_000);

  const { sql: whereSql, binds: whereBinds } = buildWhere(filters);

  const listSql = `
    SELECT m.match_id, m.scope, m.home_team, m.away_team, m.status,
           m.archived_at, m.total_events, m.total_balls
    FROM matches m
    ${whereSql}
    ORDER BY m.archived_at DESC
    LIMIT ? OFFSET ?
  `;

  const countSql = `SELECT COUNT(*) AS c FROM matches m ${whereSql}`;

  let matchRows: ArchivedMatch[] = [];
  let total = 0;
  try {
    const [listRes, countRes] = await Promise.all([
      env.LOG_DB
        .prepare(listSql)
        .bind(...whereBinds, limit, offset)
        .all<ArchivedMatch>(),
      env.LOG_DB
        .prepare(countSql)
        .bind(...whereBinds)
        .first<{ c: number }>(),
    ]);
    matchRows = listRes.results ?? [];
    total = countRes?.c ?? 0;
  } catch {
    // If the table doesn't exist (migration not yet applied) or the query
    // fails for any other reason, return an empty result rather than
    // breaking the page. The caller renders the zero-result state.
    return { matches: [], total: 0 };
  }

  if (!matchRows.length) return { matches: [], total };

  const ids = matchRows.map((r) => r.match_id);
  const inningsByMatch = new Map<string, ArchiveSearchInnings[]>();
  try {
    const placeholders = ids.map(() => '?').join(', ');
    const inningsSql = `
      SELECT match_id, innings, batting_team, runs, wickets, overs
      FROM innings
      WHERE match_id IN (${placeholders})
      ORDER BY match_id ASC, innings ASC
    `;
    const inningsRes = await env.LOG_DB
      .prepare(inningsSql)
      .bind(...ids)
      .all<ArchivedInnings>();
    for (const row of inningsRes.results ?? []) {
      const list = inningsByMatch.get(row.match_id) ?? [];
      list.push({
        innings: row.innings,
        battingTeam: row.batting_team,
        runs: row.runs,
        wickets: row.wickets,
        overs: row.overs,
      });
      inningsByMatch.set(row.match_id, list);
    }
  } catch {
    // Innings load failed — fall through with empty innings arrays per
    // match. The match list is still useful by itself.
  }

  const matches: ArchiveSearchRow[] = matchRows.map((r) => ({
    matchId: r.match_id,
    scope: r.scope,
    homeTeam: r.home_team,
    awayTeam: r.away_team,
    status: r.status,
    archivedAt: r.archived_at,
    totalEvents: r.total_events,
    totalBalls: r.total_balls,
    innings: inningsByMatch.get(r.match_id) ?? [],
  }));

  return { matches, total };
}

/** Distinct calendar years for which we have any archived match. */
export async function listSeasons(env: Env): Promise<number[]> {
  try {
    const res = await env.LOG_DB
      .prepare(`SELECT archived_at FROM matches`)
      .all<{ archived_at: number }>();
    const years = new Set<number>();
    for (const row of res.results ?? []) {
      if (!Number.isFinite(row.archived_at)) continue;
      years.add(new Date(row.archived_at).getUTCFullYear());
    }
    return Array.from(years).sort((a, b) => b - a);
  } catch {
    return [];
  }
}

/**
 * Distinct team names across home/away. Sorted alphabetically.
 * Filters out nulls/empties so the dropdown stays clean.
 */
export async function listTeams(env: Env): Promise<string[]> {
  try {
    const res = await env.LOG_DB
      .prepare(
        `SELECT team FROM (
           SELECT home_team AS team FROM matches WHERE home_team IS NOT NULL AND home_team != ''
           UNION
           SELECT away_team AS team FROM matches WHERE away_team IS NOT NULL AND away_team != ''
         )
         ORDER BY team ASC`,
      )
      .all<{ team: string }>();
    return (res.results ?? []).map((r) => r.team).filter((t): t is string => !!t);
  } catch {
    return [];
  }
}

function clampInt(
  value: number | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// ---------- HTML page ------------------------------------------------------

/**
 * Server-rendered `/archive` page. Filters round-trip through the
 * querystring; no JS. Visual style mirrors the rest of the dark-theme
 * surfaces.
 */
export async function renderArchiveBrowserPage(
  env: Env,
  url: URL,
): Promise<Response> {
  const filters = parseFiltersFromUrl(url);
  const [{ matches, total }, seasons, teams] = await Promise.all([
    searchArchive(env, filters),
    listSeasons(env),
    listTeams(env),
  ]);

  const html = renderHtml(filters, matches, total, seasons, teams, url);
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/** JSON twin of the HTML page — same filters, same query, machine-readable. */
export async function handleArchiveSearchApi(
  env: Env,
  url: URL,
): Promise<Response> {
  const filters = parseFiltersFromUrl(url);
  const result = await searchArchive(env, filters);
  return new Response(JSON.stringify({ ...result, filters }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export function parseFiltersFromUrl(url: URL): ArchiveSearchFilters {
  const sp = url.searchParams;
  const seasonRaw = sp.get('season');
  const seasonNum = seasonRaw ? parseInt(seasonRaw, 10) : NaN;
  const limitRaw = sp.get('limit');
  const limitNum = limitRaw ? parseInt(limitRaw, 10) : NaN;
  const offsetRaw = sp.get('offset');
  const offsetNum = offsetRaw ? parseInt(offsetRaw, 10) : NaN;
  return {
    q: sp.get('q'),
    team: sp.get('team'),
    season: Number.isFinite(seasonNum) ? seasonNum : null,
    hasFifty: sp.get('hasFifty') === '1' || sp.get('hasFifty') === 'true',
    wicketFirstOver:
      sp.get('wicketFirstOver') === '1' || sp.get('wicketFirstOver') === 'true',
    limit: Number.isFinite(limitNum) ? limitNum : undefined,
    offset: Number.isFinite(offsetNum) ? offsetNum : undefined,
  };
}

function renderHtml(
  filters: ArchiveSearchFilters,
  matches: ArchiveSearchRow[],
  total: number,
  seasons: number[],
  teams: string[],
  url: URL,
): string {
  const limit = clampInt(filters.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(filters.offset, 0, 0, 1_000_000);
  const hasFilters =
    !!(filters.q && filters.q.trim()) ||
    !!(filters.team && filters.team.trim()) ||
    (filters.season != null && Number.isFinite(filters.season)) ||
    !!filters.hasFifty ||
    !!filters.wicketFirstOver;

  const teamOptions = teams
    .map(
      (t) =>
        `<option value="${escapeHtml(t)}"${filters.team === t ? ' selected' : ''}>${escapeHtml(t)}</option>`,
    )
    .join('');
  const seasonOptions = seasons
    .map(
      (y) =>
        `<option value="${y}"${filters.season === y ? ' selected' : ''}>${y}</option>`,
    )
    .join('');

  const rows = matches
    .map((m) => {
      const teamsLabel =
        [m.homeTeam, m.awayTeam].filter(Boolean).join(' v ') || '—';
      const matchPrefix = m.scope ? `/${m.scope}` : '';
      const inningsLabel = m.innings.length
        ? m.innings
            .map((i) => {
              const score =
                i.runs != null
                  ? `${i.runs}/${i.wickets ?? 0}${i.overs ? ` (${i.overs})` : ''}`
                  : '—';
              const team = i.battingTeam ? escapeHtml(i.battingTeam) : `Innings ${i.innings}`;
              return `<div class="inn"><span class="inn-team">${team}</span> <span class="inn-score">${escapeHtml(score)}</span></div>`;
            })
            .join('')
        : `<span class="muted">no innings recorded</span>`;
      return `<tr>
        <td title="${new Date(m.archivedAt).toISOString()}" class="muted">${escapeHtml(formatDate(m.archivedAt))}</td>
        <td><strong>${escapeHtml(teamsLabel)}</strong><div class="inn-list">${inningsLabel}</div></td>
        <td class="muted">${escapeHtml(m.status ?? '')}</td>
        <td class="muted">${escapeHtml(m.scope || 'default')}</td>
        <td class="num">${m.totalEvents}</td>
        <td class="num">${m.totalBalls}</td>
        <td>
          <a href="${matchPrefix}/summary/${encodeURIComponent(m.matchId)}">summary</a>
          · <a href="${matchPrefix}/highlights/${encodeURIComponent(m.matchId)}">highlights</a>
        </td>
      </tr>`;
    })
    .join('');

  const noResultsMessage = total === 0 && !hasFilters
    ? 'No archived matches yet. Completed matches show up here once they finish.'
    : 'No matches match your filters. Try removing one.';

  const nextOffset = offset + limit;
  const prevOffset = Math.max(0, offset - limit);
  const showPrev = offset > 0;
  const showNext = nextOffset < total;
  const baseHref = pageHrefBase(url);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Archive</title>
<style>
  :root { --bg:#0e1116; --panel:#161a22; --border:#232a35; --accent:#ffd23a; --text:#e8eaed; --muted:#8a93a4; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:var(--bg); color:var(--text); }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { padding: 24px 32px; border-bottom: 1px solid var(--border); display:flex; align-items:baseline; gap:18px; flex-wrap:wrap; }
  header h1 { margin:0; font-size: 18px; letter-spacing: 0.05em; text-transform: uppercase; }
  header .total { color: var(--muted); font-size: 13px; }
  header nav { margin-left:auto; }
  header nav a { color: var(--muted); text-decoration:none; font-size:12px; }
  header nav a:hover { color: var(--accent); }
  main { max-width: 1100px; margin: 24px auto; padding: 0 32px; }
  form.filters { background: var(--panel); border:1px solid var(--border); border-radius: 10px; padding: 16px 18px; display: grid; grid-template-columns: 1fr 200px 140px auto; gap: 12px 14px; align-items: end; }
  form.filters label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
  form.filters input[type=text], form.filters select { background: #0a0d12; border: 1px solid var(--border); color: var(--text); padding: 8px 10px; border-radius: 4px; font: inherit; min-width: 0; }
  form.filters input[type=text]:focus, form.filters select:focus { outline: none; border-color: var(--accent); }
  form.filters .checks { grid-column: 1 / -1; display:flex; gap: 18px; flex-wrap: wrap; padding-top: 4px; border-top: 1px dashed var(--border); margin-top: 4px; padding-top: 12px; }
  form.filters .checks label { flex-direction: row; align-items: center; gap: 8px; text-transform: none; letter-spacing: 0; color: var(--text); font-size: 13px; }
  form.filters .actions { grid-column: 1 / -1; display:flex; gap: 10px; justify-content: flex-end; }
  form.filters button, form.filters a.reset { padding: 9px 18px; border-radius: 4px; font: inherit; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; font-size: 11px; cursor: pointer; text-decoration: none; display: inline-block; }
  form.filters button { background: var(--accent); color: #0a0d12; border: none; }
  form.filters button:hover { background: #ffe066; }
  form.filters a.reset { background: var(--panel); color: var(--text); border: 1px solid var(--border); }
  form.filters a.reset:hover { border-color: var(--accent); color: var(--accent); }
  .results { margin-top: 20px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  table { width: 100%; border-collapse: collapse; }
  thead { background: #11151c; }
  th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  td.muted, .muted { color: var(--muted); }
  td.num { font-variant-numeric: tabular-nums; text-align: right; }
  td a { color: var(--accent); text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .inn-list { margin-top: 4px; display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
  .inn { display: flex; gap: 8px; color: var(--muted); }
  .inn-team { color: var(--text); }
  .inn-score { font-variant-numeric: tabular-nums; }
  .empty { padding: 40px 20px; color: var(--muted); text-align: center; font-size: 14px; }
  .pager { display: flex; gap: 12px; justify-content: space-between; align-items: center; padding: 14px 18px; color: var(--muted); font-size: 12px; }
  .pager a { color: var(--accent); text-decoration: none; }
  .pager a:hover { text-decoration: underline; }
  .pager .ghost { color: #444; }
  @media (max-width: 720px) {
    form.filters { grid-template-columns: 1fr 1fr; }
    main { padding: 0 18px; }
    th:nth-child(4), td:nth-child(4), th:nth-child(5), td:nth-child(5), th:nth-child(6), td:nth-child(6) { display: none; }
  }
</style>
</head>
<body>
<header>
  <h1>Archive</h1>
  <span class="total">${total} archived match${total === 1 ? '' : 'es'}${hasFilters ? ' matching filters' : ''}</span>
  <nav><a href="/">← home</a></nav>
</header>
<main>
  <form class="filters" method="get" action="/archive">
    <label>
      Search
      <input type="text" name="q" value="${escapeHtml(filters.q ?? '')}" placeholder="team or player name" />
    </label>
    <label>
      Team
      <select name="team">
        <option value="">Any team</option>
        ${teamOptions}
      </select>
    </label>
    <label>
      Season
      <select name="season">
        <option value="">Any year</option>
        ${seasonOptions}
      </select>
    </label>
    <div></div>
    <div class="checks">
      <label><input type="checkbox" name="hasFifty" value="1"${filters.hasFifty ? ' checked' : ''} /> Has a 50+ score</label>
      <label><input type="checkbox" name="wicketFirstOver" value="1"${filters.wicketFirstOver ? ' checked' : ''} /> Wicket in the first over</label>
    </div>
    <div class="actions">
      ${hasFilters ? `<a class="reset" href="/archive">Clear</a>` : ''}
      <button type="submit">Search</button>
    </div>
  </form>

  <div class="results">
    ${
      matches.length === 0
        ? `<div class="empty">${escapeHtml(noResultsMessage)}</div>`
        : `<table>
            <thead><tr>
              <th>Archived</th><th>Match</th><th>Status</th><th>Scope</th><th>Events</th><th>Balls</th><th>Links</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="pager">
            <span>${offset + 1}–${Math.min(total, offset + matches.length)} of ${total}</span>
            <span>
              ${
                showPrev
                  ? `<a href="${escapeHtml(pageHref(baseHref, prevOffset, limit))}">← previous</a>`
                  : `<span class="ghost">← previous</span>`
              }
              &nbsp;
              ${
                showNext
                  ? `<a href="${escapeHtml(pageHref(baseHref, nextOffset, limit))}">next →</a>`
                  : `<span class="ghost">next →</span>`
              }
            </span>
          </div>`
    }
  </div>
</main>
</body>
</html>`;
}

function pageHrefBase(url: URL): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (k === 'offset' || k === 'limit') continue;
    if (v) sp.set(k, v);
  }
  return sp;
}

function pageHref(base: URLSearchParams, offset: number, limit: number): string {
  const sp = new URLSearchParams(base);
  if (offset > 0) sp.set('offset', String(offset));
  if (limit !== DEFAULT_LIMIT) sp.set('limit', String(limit));
  const qs = sp.toString();
  return qs ? `/archive?${qs}` : `/archive`;
}

function formatDate(ts: number): string {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

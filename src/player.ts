// Player career page aggregation.
//
// Reads the D1 archive (matches/events) to produce per-player career stats
// across every archived match. The events table only stores *milestone*
// events (wickets, 4s, 6s, fifties, hundreds, team-milestones) — not every
// ball — so we can compute exact counts for things-that-are-events but
// CANNOT derive runs scored, balls faced, strike rate, overs bowled, runs
// conceded, or economy. We only surface what's exact, plus a "best
// milestone reached" approximation for batters.
//
// Player identity is keyed on the slug of the name as it appeared in
// `events.batter` / `events.bowler`. We deliberately don't try to
// `unslugify` — instead we enumerate the distinct names from D1 and
// lookup by exact slug match. Names with diacritics or punctuation
// collapse to the same slug; that's the price of not maintaining a
// canonical players table.

import type { Env } from './types';

/** Lowercase, ASCII, hyphenated. Stable across calls. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks (accents)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type PlayerRecentEvent = {
  matchId: string;
  idx: number;
  type: string;
  over: string | null;
  innings: number | null;
  batter: string | null;
  bowler: string | null;
  runs: number | null;
  context: string | null;
  ts: number | null;
  role: 'batter' | 'bowler';
};

export type PlayerStats = {
  name: string;
  slug: string;
  matches: number;
  asBatter: {
    fours: number;
    sixes: number;
    fifties: number;
    hundreds: number;
    dismissals: number;
    /**
     * Highest milestone (50/100/150/...) we've seen this player reach as
     * a batter. NOT an actual top score — only the largest "fifty" or
     * "hundred" event runs value, since the events table doesn't track
     * per-ball scores. Surface as "best milestone reached".
     */
    bestMilestone: number | null;
  };
  asBowler: {
    wickets: number;
    matchesBowled: number;
  };
  recentEvents: PlayerRecentEvent[];
};

export type KnownPlayer = {
  name: string;
  slug: string;
  matchCount: number;
};

/**
 * Enumerate every distinct batter/bowler name seen across the archive,
 * along with how many matches each appears in. Used to back the
 * /players index and to resolve a slug → canonical name without an
 * `unslugify` round-trip.
 *
 * Sorted by match count descending, then name ascending.
 */
export async function listKnownPlayers(env: Env): Promise<KnownPlayer[]> {
  let rows: Array<{ name: string; match_count: number }>;
  try {
    const res = await env.LOG_DB
      .prepare(
        `SELECT name, COUNT(DISTINCT match_id) AS match_count FROM (
           SELECT batter AS name, match_id FROM events WHERE batter IS NOT NULL AND batter <> ''
           UNION ALL
           SELECT bowler AS name, match_id FROM events WHERE bowler IS NOT NULL AND bowler <> ''
         )
         GROUP BY name
         ORDER BY match_count DESC, name ASC`,
      )
      .all<{ name: string; match_count: number }>();
    rows = res.results ?? [];
  } catch {
    // Table may not exist yet on first deploy.
    return [];
  }

  // Slugs aren't unique (two distinct names can collapse to the same
  // slug). Fold by slug, keep the name with the highest match_count
  // as the canonical display.
  const bySlug = new Map<string, KnownPlayer>();
  for (const r of rows) {
    if (!r.name) continue;
    const slug = slugify(r.name);
    if (!slug) continue;
    const existing = bySlug.get(slug);
    if (!existing || r.match_count > existing.matchCount) {
      bySlug.set(slug, { name: r.name, slug, matchCount: r.match_count });
    } else if (r.match_count === existing.matchCount) {
      // Tiebreak by name asc to stay deterministic.
      if (r.name < existing.name) {
        bySlug.set(slug, { name: r.name, slug, matchCount: r.match_count });
      }
    }
  }

  return [...bySlug.values()].sort(
    (a, b) => b.matchCount - a.matchCount || a.name.localeCompare(b.name),
  );
}

type EventRow = {
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

/**
 * Career stats for a player resolved by slug.
 *
 * Strategy: enumerate the distinct names whose slug matches, then pull
 * every event where this player appears as batter OR bowler. Aggregate
 * in JS — datasets are tiny (one row per milestone event, archived
 * matches only) so a single pass is cheaper than several SQL aggregates.
 */
export async function getPlayerStats(env: Env, slug: string): Promise<PlayerStats | null> {
  if (!slug) return null;

  const known = await listKnownPlayers(env);
  const target = known.find((p) => p.slug === slug);
  if (!target) return null;

  // Find every distinct name in D1 that slugifies to this slug. There may
  // be more than one (e.g. "S. Patel" vs "S Patel" both → "s-patel"). We
  // union them all when querying events.
  let allNames: string[];
  try {
    const res = await env.LOG_DB
      .prepare(
        `SELECT DISTINCT name FROM (
           SELECT batter AS name FROM events WHERE batter IS NOT NULL AND batter <> ''
           UNION
           SELECT bowler AS name FROM events WHERE bowler IS NOT NULL AND bowler <> ''
         )`,
      )
      .all<{ name: string }>();
    allNames = (res.results ?? [])
      .map((r) => r.name)
      .filter((n) => slugify(n) === slug);
  } catch {
    return null;
  }
  if (allNames.length === 0) return null;

  const placeholders = allNames.map((_, i) => `?${i + 1}`).join(',');
  let events: EventRow[];
  try {
    const res = await env.LOG_DB
      .prepare(
        `SELECT match_id, idx, type, innings, over, batter, bowler, runs, context, ts
         FROM events
         WHERE batter IN (${placeholders}) OR bowler IN (${placeholders})
         ORDER BY ts DESC, match_id DESC, idx DESC`,
      )
      .bind(...allNames, ...allNames)
      .all<EventRow>();
    events = res.results ?? [];
  } catch {
    return null;
  }

  const nameSet = new Set(allNames);
  const matchesAny = new Set<string>();
  const matchesBowled = new Set<string>();
  let fours = 0;
  let sixes = 0;
  let fifties = 0;
  let hundreds = 0;
  let dismissals = 0;
  let wickets = 0;
  let bestMilestone: number | null = null;
  const recentEvents: PlayerRecentEvent[] = [];

  for (const e of events) {
    const isBatter = e.batter != null && nameSet.has(e.batter);
    const isBowler = e.bowler != null && nameSet.has(e.bowler);
    if (!isBatter && !isBowler) continue;
    matchesAny.add(e.match_id);
    if (isBowler) matchesBowled.add(e.match_id);

    if (isBatter) {
      if (e.type === '4') fours++;
      else if (e.type === '6') sixes++;
      else if (e.type === 'fifty') {
        fifties++;
        const m = e.runs ?? 50;
        if (bestMilestone === null || m > bestMilestone) bestMilestone = m;
      } else if (e.type === 'hundred') {
        hundreds++;
        const m = e.runs ?? 100;
        if (bestMilestone === null || m > bestMilestone) bestMilestone = m;
      } else if (e.type === 'wicket') {
        // Wicket events store the dismissed batter in `batter` and the
        // claiming bowler in `bowler`. So a wicket where the player IS
        // the batter is a dismissal of them.
        dismissals++;
      }
    }
    if (isBowler && e.type === 'wicket') {
      wickets++;
    }

    if (recentEvents.length < 20) {
      recentEvents.push({
        matchId: e.match_id,
        idx: e.idx,
        type: e.type,
        over: e.over,
        innings: e.innings,
        batter: e.batter,
        bowler: e.bowler,
        runs: e.runs,
        context: e.context,
        ts: e.ts,
        role: isBatter ? 'batter' : 'bowler',
      });
    }
  }

  return {
    name: target.name,
    slug,
    matches: matchesAny.size,
    asBatter: {
      fours,
      sixes,
      fifties,
      hundreds,
      dismissals,
      bestMilestone,
    },
    asBowler: {
      wickets,
      matchesBowled: matchesBowled.size,
    },
    recentEvents,
  };
}

// ---------- HTML rendering ----------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAGE_STYLES = `
  :root { --bg:#0e1116; --panel:#161a22; --border:#232a35; --accent:#ffd23a; --text:#e8eaed; --muted:#8a93a4; --good:#3ddc84; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background: var(--bg); color: var(--text); font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing:antialiased; }
  a { color: var(--text); }
  a:hover { color: var(--accent); }
  header { padding: 22px 28px; border-bottom: 1px solid var(--border); display:flex; align-items:center; gap: 18px; flex-wrap: wrap; }
  header h1 { margin:0; font-size: 18px; letter-spacing: 0.04em; }
  header .kicker { color: var(--accent); font-weight: 800; letter-spacing: 0.18em; font-size: 11px; text-transform: uppercase; }
  header nav { margin-left: auto; display: flex; gap: 8px; }
  header nav a { color: var(--muted); text-decoration: none; padding: 6px 12px; border: 1px solid var(--border); border-radius: 4px; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }
  header nav a:hover { color: var(--accent); border-color: var(--accent); }
  main { max-width: 720px; margin: 24px auto; padding: 0 24px 60px; display: grid; gap: 16px; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 18px 20px; }
  section h2 { margin: 0 0 12px; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); font-weight: 800; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 12px; }
  .stat { background: #0a0d12; border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; }
  .stat .num { font-size: 22px; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--text); line-height: 1; }
  .stat .lbl { display:block; margin-top: 6px; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
  .caveat { color: var(--muted); font-size: 12px; margin: 8px 0 0; line-height: 1.5; }
  ul.players { list-style: none; padding: 0; margin: 0; display: grid; gap: 4px; }
  ul.players li { display: flex; justify-content: space-between; padding: 8px 4px; border-bottom: 1px dashed var(--border); }
  ul.players li:last-child { border-bottom: none; }
  ul.players a { text-decoration: none; font-weight: 700; }
  ul.players .count { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 13px; }
  ul.events { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
  ul.events li { padding: 8px 0; border-bottom: 1px dashed var(--border); display: grid; grid-template-columns: auto auto 1fr auto; gap: 10px; align-items: baseline; }
  ul.events li:last-child { border-bottom: none; }
  ul.events .badge { font-size: 10px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; padding: 2px 8px; border-radius: 3px; background: rgba(138,147,164,0.14); color: var(--muted); }
  ul.events .badge.four { background: rgba(61,220,132,0.14); color: var(--good); }
  ul.events .badge.six { background: rgba(255,210,58,0.18); color: var(--accent); }
  ul.events .badge.wicket { background: rgba(255,77,109,0.16); color: #ff8aa1; }
  ul.events .badge.fifty, ul.events .badge.hundred { background: rgba(255,210,58,0.14); color: var(--accent); }
  ul.events .over { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px; }
  ul.events .ctx { color: var(--text); font-size: 13px; }
  ul.events .role { color: var(--muted); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
  ul.events a { text-decoration: none; }
  .empty { color: var(--muted); font-size: 13px; padding: 8px 0; }
`;

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#0e1116" />
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function eventBadge(type: string): string {
  const cls = type === '4' ? 'four'
    : type === '6' ? 'six'
    : type === 'wicket' ? 'wicket'
    : type === 'fifty' ? 'fifty'
    : type === 'hundred' ? 'hundred'
    : '';
  const label = type === '4' ? '4'
    : type === '6' ? '6'
    : type === 'wicket' ? 'W'
    : type === 'fifty' ? '50'
    : type === 'hundred' ? '100'
    : type;
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

export function renderPlayerPage(stats: PlayerStats): string {
  const b = stats.asBatter;
  const w = stats.asBowler;
  const best = b.bestMilestone == null
    ? '—'
    : `${b.bestMilestone}+`;

  const recent = stats.recentEvents.length
    ? `<ul class="events">${stats.recentEvents.map((e) => {
        const matchSafe = encodeURIComponent(e.matchId);
        const href = `/highlights/${matchSafe}`;
        const over = e.over ? `${e.innings ?? '?'}·${e.over}` : '';
        const ctx = e.context
          ? e.context
          : (e.role === 'batter'
              ? (e.type === 'wicket' && e.bowler ? `out, b ${e.bowler}` : `vs ${e.bowler ?? '?'}`)
              : (e.batter ? `${e.type === 'wicket' ? 'dismissed ' : 'to '}${e.batter}` : ''));
        return `<li>
          ${eventBadge(e.type)}
          <span class="over">${escapeHtml(over)}</span>
          <span class="ctx"><a href="${escapeHtml(href)}">${escapeHtml(ctx)}</a></span>
          <span class="role">${e.role === 'batter' ? 'bat' : 'bowl'}</span>
        </li>`;
      }).join('')}</ul>`
    : `<p class="empty">No events recorded yet.</p>`;

  const body = `<header>
  <span class="kicker">Career</span>
  <h1>${escapeHtml(stats.name)}</h1>
  <nav>
    <a href="/players">all players</a>
    <a href="/">home</a>
  </nav>
</header>
<main>
  <section>
    <h2>Overview</h2>
    <div class="stat-grid">
      <div class="stat"><span class="num">${stats.matches}</span><span class="lbl">Matches</span></div>
      <div class="stat"><span class="num">${w.matchesBowled}</span><span class="lbl">Bowled in</span></div>
    </div>
    <p class="caveat">Aggregated across archived matches only. Live matches appear here once they finish.</p>
  </section>

  <section>
    <h2>Batting (milestone events)</h2>
    <div class="stat-grid">
      <div class="stat"><span class="num">${b.fours}</span><span class="lbl">Fours</span></div>
      <div class="stat"><span class="num">${b.sixes}</span><span class="lbl">Sixes</span></div>
      <div class="stat"><span class="num">${b.fifties}</span><span class="lbl">Fifties</span></div>
      <div class="stat"><span class="num">${b.hundreds}</span><span class="lbl">Hundreds</span></div>
      <div class="stat"><span class="num">${b.dismissals}</span><span class="lbl">Dismissals</span></div>
      <div class="stat"><span class="num">${escapeHtml(best)}</span><span class="lbl">Best milestone reached</span></div>
    </div>
    <p class="caveat">The archive stores milestone events (4s / 6s / 50s / 100s / wickets), not every ball, so we don't have runs scored, balls faced, or strike rate. "Best milestone reached" is the largest 50/100/150 mark hit, not a true high score.</p>
  </section>

  <section>
    <h2>Bowling (milestone events)</h2>
    <div class="stat-grid">
      <div class="stat"><span class="num">${w.wickets}</span><span class="lbl">Wickets</span></div>
      <div class="stat"><span class="num">${w.matchesBowled}</span><span class="lbl">Matches bowled</span></div>
    </div>
    <p class="caveat">Overs bowled, runs conceded, and economy aren't derivable from milestone events.</p>
  </section>

  <section>
    <h2>Recent events</h2>
    ${recent}
  </section>
</main>`;

  return pageShell(`${stats.name} · career`, body);
}

export function renderPlayerNotFound(slug: string): string {
  const body = `<header>
  <span class="kicker">Career</span>
  <h1>Player not found</h1>
  <nav>
    <a href="/players">all players</a>
    <a href="/">home</a>
  </nav>
</header>
<main>
  <section>
    <p>No archived player matches the slug <code>${escapeHtml(slug)}</code>.</p>
    <p class="caveat">Players appear here once a match they featured in is promoted to the D1 archive (auto-archive runs when a match reaches a terminal status).</p>
  </section>
</main>`;
  return pageShell('Player not found', body);
}

export function renderPlayersIndex(players: KnownPlayer[]): string {
  const list = players.length
    ? `<ul class="players">${players.map((p) => `
        <li>
          <a href="/player/${encodeURIComponent(p.slug)}">${escapeHtml(p.name)}</a>
          <span class="count">${p.matchCount} match${p.matchCount === 1 ? '' : 'es'}</span>
        </li>`).join('')}</ul>`
    : `<p class="empty">No archived matches yet. Players will appear here once a match reaches a terminal status and is promoted to D1.</p>`;

  const body = `<header>
  <span class="kicker">Archive</span>
  <h1>Players</h1>
  <nav>
    <a href="/">home</a>
  </nav>
</header>
<main>
  <section>
    <h2>Known players (${players.length})</h2>
    ${list}
    <p class="caveat">Sorted by archived-match count. Names come from the milestone events recorded during each match.</p>
  </section>
</main>`;
  return pageShell('Players', body);
}

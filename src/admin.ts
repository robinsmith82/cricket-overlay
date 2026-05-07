import type { Env } from './types';
import { readBranding, writeSponsors, writeTeams, type Sponsor, type TeamBrand } from './branding';
import { discoverMatches, type DiscoveredMatch } from './discovery';
import { readYouTube, writeYouTube, refreshYouTubeStartTime, type YouTubeConfig } from './archive';
import { seedMockMatch } from './mock-seed';
import { renderDiagnose } from './diagnose';
import { listArchivedMatches, isArchived, type ArchivedMatch } from './match-archive';
import { getHeadToHead, type H2HResult } from './head-to-head';
import { renderSetup } from './setup';

/** H2H lookup per discovered fixture, keyed by matchId. Empty/missing means
 *  the lookup either failed or returned no prior meetings — render the
 *  explicit-empty state. */
type H2HByMatchId = Record<string, H2HResult>;

function activeKey(scope: string): string {
  return scope ? `active_match_id:${scope}` : 'active_match_id';
}

export async function getActiveMatchId(env: Env, scope = ''): Promise<string | null> {
  return (await env.CRICKET_CACHE.get(activeKey(scope))) ?? null;
}

async function setActiveMatchId(env: Env, id: string, scope = ''): Promise<void> {
  await env.CRICKET_CACHE.put(activeKey(scope), id);
}

function unauth(): Response {
  return new Response('Unauthorized', { status: 401 });
}

function adminKeyFor(env: Env, scope: string): string | undefined {
  if (scope === '3s') return env.ADMIN_KEY_3S;
  if (scope === '4s') return env.ADMIN_KEY_4S;
  return env.ADMIN_KEY;
}

function isAuthed(env: Env, url: URL, scope: string): boolean {
  const expected = adminKeyFor(env, scope);
  if (!expected) return false;
  return url.searchParams.get('key') === expected;
}

/**
 * Public admin-auth check for routes outside `handleAdmin`. Mirrors the
 * `?key=…` pattern used by every other admin surface — no cookies, no
 * sessions; the URL key is the only credential.
 */
export function isAdmin(env: Env, url: URL, scope = ''): boolean {
  return isAuthed(env, url, scope);
}

export async function handleAdmin(request: Request, env: Env, url: URL, scope = ''): Promise<Response> {
  if (!isAuthed(env, url, scope)) return unauth();

  // Game-day setup wizard. Lives at /[scope]/admin/setup. Each step is GET
  // with `?step=N`; form submits go to existing /[scope]/admin/<action>
  // handlers (set-active, youtube, youtube-refresh) with a `next` field so
  // the redirect lands back in the wizard instead of /admin.
  if (url.pathname.endsWith('/setup') || url.pathname.endsWith('/setup/')) {
    return new Response(await renderSetup(env, scope, url, url.origin), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  if (url.pathname.endsWith('/logs') || url.pathname.endsWith('/logs/')) {
    return renderLogsPage(env, url, scope);
  }

  if (url.pathname.endsWith('/archive') || url.pathname.endsWith('/archive/')) {
    return renderArchivePage(env, url, scope);
  }

  // /admin/diagnose[/:matchId] — match-level health check page.
  // Defaults to the scope's active match if no id is given.
  const diagPathMatch = url.pathname.match(/\/admin\/diagnose(?:\/([^/]+))?\/?$/);
  if (diagPathMatch) {
    const matchId = diagPathMatch[1]
      ? decodeURIComponent(diagPathMatch[1])
      : ((await getActiveMatchId(env, scope)) ?? '');
    if (!matchId) {
      return new Response('No active match for this scope and no matchId in URL.', { status: 400 });
    }
    return new Response(await renderDiagnose(env, matchId, scope), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  if (request.method === 'POST') {
    return handleAdminPost(request, env, url, scope);
  }

  const [branding, active, fixtures, youtube] = await Promise.all([
    readBranding(env, scope),
    getActiveMatchId(env, scope),
    discoverMatches(env).catch(() => [] as DiscoveredMatch[]),
    readYouTube(env, scope),
  ]);
  // Per-fixture head-to-head against the D1 archive. Looked up in parallel,
  // each individually try-caught — a single bad lookup must not break the
  // discovery list. Fixtures missing one of the team names are skipped.
  const h2h: H2HByMatchId = {};
  await Promise.all(
    fixtures.map(async (f) => {
      if (!f.battingTeam || !f.bowlingTeam) return;
      try {
        h2h[f.matchId] = await getHeadToHead(env, f.battingTeam, f.bowlingTeam);
      } catch {
        // Swallow — explicit-empty render is the fallback.
      }
    }),
  );
  const key = adminKeyFor(env, scope) ?? '';
  return new Response(
    renderAdmin(active, branding.sponsors, branding.teams, key, scope, env, fixtures, youtube, h2h),
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}

async function handleAdminPost(request: Request, env: Env, url: URL, scope: string): Promise<Response> {
  const action = url.pathname.split('/').filter(Boolean).pop();
  const form = await request.formData();
  if (action === 'set-active') {
    const id = String(form.get('matchId') ?? '').trim();
    if (id) await setActiveMatchId(env, id, scope);
  } else if (action === 'sponsors') {
    const json = String(form.get('json') ?? '[]');
    try { await writeSponsors(env, JSON.parse(json) as Sponsor[], scope); } catch { /* ignore parse */ }
  } else if (action === 'teams') {
    const json = String(form.get('json') ?? '{}');
    try { await writeTeams(env, JSON.parse(json) as Record<string, TeamBrand>, scope); } catch { /* ignore parse */ }
  } else if (action === 'youtube') {
    const url = String(form.get('url') ?? '');
    await writeYouTube(env, url, scope);
  } else if (action === 'youtube-refresh') {
    await refreshYouTubeStartTime(env, scope);
  } else if (action === 'mock-seed') {
    // Seed a fake match with synthetic events / tags / vibes so the v2
    // surfaces all populate without needing a live game. Default matchId
    // is `mock-demo` (per scope, so the 3s and 4s seeds don't collide).
    const matchId = (String(form.get('matchId') ?? '').trim()) || `mock-demo${scope ? '-' + scope : ''}`;
    const result = await seedMockMatch(env, matchId, scope);
    const adminPath = scope ? `/${scope}/admin` : '/admin';
    const key = adminKeyFor(env, scope) ?? '';
    const params = new URLSearchParams({ key, seeded: matchId, events: String(result.events), tags: String(result.tags), vibes: String(result.vibes) });
    return Response.redirect(`${url.origin}${adminPath}?${params.toString()}`, 303);
  }
  const adminPath = scope ? `/${scope}/admin` : '/admin';
  const key = adminKeyFor(env, scope) ?? '';
  // Wizard steps post here with a `next` field that routes the redirect into
  // the next wizard step instead of dumping the user back at /admin. We only
  // honour same-origin paths under this scope's /admin/setup, so a hostile
  // value can't turn this into an open redirect.
  const next = String(form.get('next') ?? '').trim();
  const setupPrefix = `${adminPath}/setup`;
  if (next.startsWith('/') && (next === setupPrefix || next.startsWith(`${setupPrefix}?`) || next.startsWith(`${setupPrefix}/`))) {
    return Response.redirect(`${url.origin}${next}`, 303);
  }
  return Response.redirect(`${url.origin}${adminPath}?key=${encodeURIComponent(key)}`, 303);
}

function renderAdmin(
  active: string | null,
  sponsors: Sponsor[],
  teams: Record<string, TeamBrand>,
  key: string,
  scope: string,
  env: Env,
  fixtures: DiscoveredMatch[],
  youtube: YouTubeConfig | null,
  h2h: H2HByMatchId,
): string {
  const sponsorsJson = JSON.stringify(sponsors, null, 2);
  const teamsJson = JSON.stringify(teams, null, 2);
  const prefix = scope ? `/${scope}` : '';
  const overlayActiveUrl = `${prefix}/overlay/active`;
  const adminPath = `${prefix}/admin`;
  const scopeLabel = scope ? scope.toUpperCase() : 'DEFAULT';

  const otherScopes = ['', '3s', '4s'].filter((s) => s !== scope);
  function urlForScope(s: string): string {
    const k = adminKeyFor(env, s) ?? '';
    const path = s ? `/${s}/admin` : '/admin';
    return `${path}?key=${encodeURIComponent(k)}`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Cricket overlay admin · ${escapeHtml(scopeLabel)}</title>
<style>
  :root {
    --bg: #0e1116;
    --panel: #161a22;
    --border: #232a35;
    --accent: #ffd23a;
    --text: #e8eaed;
    --muted: #8a93a4;
  }
  body { margin:0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 24px 32px; border-bottom: 1px solid var(--border); display:flex; align-items:center; gap: 18px; flex-wrap: wrap; }
  header h1 { margin:0; font-size: 18px; letter-spacing: 0.05em; text-transform: uppercase; }
  header .scope { color: var(--accent); font-weight: 800; letter-spacing: 0.18em; }
  header .live { display:inline-flex; align-items:center; gap:8px; color: var(--muted); font-size: 12px; }
  header .dot { width:8px; height:8px; border-radius:50%; background:#3ddc84; box-shadow:0 0 8px #3ddc84; }
  header nav { margin-left: auto; display: flex; gap: 8px; }
  header nav a {
    color: var(--muted);
    text-decoration: none;
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    font-size: 12px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  header nav a:hover { color: var(--accent); border-color: var(--accent); }
  main { max-width: 1100px; margin: 24px auto; padding: 0 32px; display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
  section h2 { margin: 0 0 12px; font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
  label { display: block; font-size: 12px; color: var(--muted); margin-top: 12px; }
  input[type=text], textarea {
    width: 100%; box-sizing: border-box;
    padding: 10px 12px; margin-top: 6px;
    background: #0a0d12; color: var(--text);
    border: 1px solid var(--border); border-radius: 4px;
    font: 13px/1.4 ui-monospace, Menlo, Consolas, monospace;
  }
  textarea { min-height: 220px; resize: vertical; }
  button {
    margin-top: 14px;
    padding: 9px 18px;
    background: var(--accent); color: #0a0d12;
    border: none; border-radius: 4px;
    font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    cursor: pointer;
  }
  button:hover { background: #ffe066; }
  .meta { color: var(--muted); font-size: 12px; }
  .meta code { color: var(--text); background:#0a0d12; padding: 2px 6px; border-radius: 3px; }
  a.link { color: var(--accent); text-decoration: none; }
  a.link:hover { text-decoration: underline; }
  .full { grid-column: 1 / -1; }
  .row { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: end; }
  .fixtures { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
  .fixture {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px 14px;
    background: #0a0d12;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .fixture.active { border-color: var(--accent); background: #1a1612; }
  .fix-meta { flex: 1; min-width: 0; }
  .fix-teams { font-size: 14px; font-weight: 700; color: var(--text); }
  .fix-teams .vs { color: var(--muted); font-weight: 500; margin: 0 6px; }
  .fix-sub { color: var(--muted); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 3px; }
  .fix-sub code { background: transparent; padding: 0; }
  .fixture button {
    margin: 0;
    padding: 6px 14px;
    font-size: 11px;
    flex-shrink: 0;
  }
  .fixture.active button { background: #2a2e36; color: var(--muted); cursor: default; }
  .fix-wrap { display: flex; flex-direction: column; gap: 6px; }
  .h2h {
    margin: 0 0 0 14px;
    padding: 8px 12px;
    background: #0a0d12;
    border: 1px solid var(--border);
    border-left: 2px solid var(--accent);
    border-radius: 0 4px 4px 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }
  .h2h.empty { border-left-color: #2a2e36; }
  .h2h-head { color: var(--text); font-weight: 600; }
  .h2h-tally { color: var(--accent); font-weight: 700; letter-spacing: 0.04em; }
  .h2h-list { margin: 6px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 3px; }
  .h2h-list li { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .h2h-list a { color: var(--text); text-decoration: none; }
  .h2h-list a:hover { color: var(--accent); text-decoration: underline; }
  .h2h-list .verdict { color: var(--muted); margin-left: 6px; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
  .h2h-list .verdict.win { color: #3ddc84; }
  .h2h-list .verdict.loss { color: #ff8a8a; }
  .h2h-list .verdict.draw { color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>Cricket overlay admin · <span class="scope">${escapeHtml(scopeLabel)}</span></h1>
  <span class="live"><span class="dot"></span>active match: <code>${escapeHtml(active ?? '— none —')}</code></span>
  <nav>
    <a href="${adminPath}/setup?key=${encodeURIComponent(key)}" style="background:var(--accent);color:#0a0d12;border-color:var(--accent);font-weight:700">▶ Setup wizard</a>
    <a href="${adminPath}/logs?key=${encodeURIComponent(key)}">Logs</a>
    <a href="${adminPath}/archive?key=${encodeURIComponent(key)}">Archive</a>
    ${otherScopes
      .map((s) => {
        const label = s ? s.toUpperCase() : 'DEFAULT';
        return `<a href="${urlForScope(s)}">${escapeHtml(label)}</a>`;
      })
      .join('')}
  </nav>
</header>
<main>
  <section>
    <h2>Active match — ${escapeHtml(scopeLabel)}</h2>
    <p class="meta">Set the Play-Cricket numeric match ID. Point OBS at <a class="link" href="${overlayActiveUrl}" target="_blank" rel="noopener">${overlayActiveUrl}</a> once and never edit OBS again.</p>
    ${
      fixtures.length
        ? `<div class="fixtures">
        ${fixtures
          .map(
            (f) => `
          <div class="fix-wrap">
            <form method="POST" action="${adminPath}/set-active?key=${encodeURIComponent(key)}" class="fixture ${f.matchId === active ? 'active' : ''}">
              <input type="hidden" name="matchId" value="${escapeHtml(f.matchId)}" />
              <div class="fix-meta">
                <div class="fix-teams">${escapeHtml(f.battingTeam)} <span class="vs">vs</span> ${escapeHtml(f.bowlingTeam)}</div>
                <div class="fix-sub"><code>${escapeHtml(f.matchId)}</code> · ${escapeHtml(f.status)}${f.matchId === active ? ' · <strong>active</strong>' : ''}</div>
              </div>
              <button type="submit">Set active</button>
            </form>
            ${renderH2H(f, h2h[f.matchId], scope)}
          </div>`,
          )
          .join('')}
      </div>
      <p class="meta">Auto-discovered from the configured Play-Cricket home page (set <code>DISCOVERY_HOME_URL</code> in <code>wrangler.toml</code>). Refreshes every 5 minutes; if you don't see what you expect, it'll catch up shortly.</p>`
        : `<p class="meta"><em>No discovered fixtures right now — either set <code>DISCOVERY_HOME_URL</code> in <code>wrangler.toml</code>, or paste a match ID manually below.</em></p>`
    }
    <p class="meta">Or paste a match ID manually:</p>
    <form method="POST" action="${adminPath}/set-active?key=${encodeURIComponent(key)}">
      <div class="row">
        <input type="text" name="matchId" placeholder="e.g. 7591652" value="${escapeHtml(active ?? '')}" />
        <button type="submit">Set active</button>
      </div>
    </form>
    <label>OBS URL (copy this once):</label>
    <input type="text" readonly value="${overlayActiveUrl}" placeholder="https://&lt;your-worker&gt;.workers.dev${overlayActiveUrl}" />
  </section>

  <section>
    <h2>Quick links</h2>
    <p><a class="link" href="${prefix}/overlay/test?mock=1" target="_blank" rel="noopener">Mock overlay (for OBS testing)</a></p>
    <p><a class="link" href="${overlayActiveUrl}" target="_blank" rel="noopener">Live overlay (current active match)</a></p>
    <p><a class="link" href="/api/score/${escapeHtml(active ?? 'test')}" target="_blank" rel="noopener">Raw score JSON</a></p>
    <p><a class="link" href="${prefix}/live" target="_blank" rel="noopener">Mobile spectator page</a> <span class="meta">— share this with parents (QR-friendly)</span></p>
    <p><a class="link" href="${prefix}/tag?key=${encodeURIComponent(key)}" target="_blank" rel="noopener">Wagon-wheel tagger</a> <span class="meta">— second iPad/phone, scorer-side</span></p>
    <p class="meta">Tip: refresh OBS Browser Source after changing branding by tweaking the URL or removing/re-adding the source.</p>
  </section>

  <section>
    <h2>YouTube live stream — ${escapeHtml(scopeLabel)}</h2>
    <p class="meta">Paste the YouTube URL when you start streaming. Used to deep-link replay clips for highlights and the WhatsApp summary card.</p>
    <form method="POST" action="${adminPath}/youtube?key=${encodeURIComponent(key)}">
      <label>Stream URL (youtube.com/watch?v=… · youtu.be/… · youtube.com/live/…)</label>
      <input type="text" name="url" placeholder="https://www.youtube.com/watch?v=…" value="${escapeHtml(youtube?.url ?? '')}" />
      <button type="submit">Save URL</button>
    </form>
    ${
      youtube
        ? `<p class="meta" style="margin-top:14px">Active: <code>${escapeHtml(youtube.videoId)}</code> · started ${escapeHtml(formatRelative(youtube.startedAt))} ago${
            youtube.startSource === 'youtube'
              ? ' <span style="color:#3ddc84">(from YouTube)</span>'
              : ' <span style="color:#ffd23a">(fallback — pasted-at time; click refresh once the broadcast is live)</span>'
          }</p>
          <form method="POST" action="${adminPath}/youtube-refresh?key=${encodeURIComponent(key)}" style="margin-top:8px">
            <button type="submit">Refresh start time from YouTube</button>
          </form>`
        : `<p class="meta" style="margin-top:14px"><em>No stream URL set — highlights/summary won't have replay links.</em></p>`
    }
  </section>

  <section>
    <h2>Mock match seeder — ${escapeHtml(scopeLabel)}</h2>
    <p class="meta">Writes ~30 fake events, ~80 wagon-wheel tags, and ~50 vibe reactions against a mock match id so every v2 surface (highlights, summary, reel, share cards, embed/clip) lights up without a live game. Re-running clears and reseeds.</p>
    <form method="POST" action="${adminPath}/mock-seed?key=${encodeURIComponent(key)}">
      <label>Match id <span class="meta">(default: <code>mock-demo${scope ? '-' + scope : ''}</code>)</span></label>
      <input type="text" name="matchId" placeholder="mock-demo${scope ? '-' + scope : ''}" />
      <button type="submit">Seed mock match</button>
    </form>
    <p class="meta" style="margin-top:14px">After seeding, try:
      <a class="link" href="${prefix}/summary/mock-demo${scope ? '-' + scope : ''}">summary</a> ·
      <a class="link" href="${prefix}/highlights/mock-demo${scope ? '-' + scope : ''}">highlights</a> ·
      <a class="link" href="${prefix}/reel/mock-demo${scope ? '-' + scope : ''}">reel</a> ·
      <a class="link" href="${prefix}/live/mock-demo${scope ? '-' + scope : ''}">live</a>
    </p>
  </section>

  <section class="full">
    <h2>Sponsors — ${escapeHtml(scopeLabel)}</h2>
    <p class="meta">JSON array. Each entry: <code>{ "name": "...", "imageUrl": "...", "text": "...", "durationMs": 12000 }</code>. Rotates every <code>durationMs</code> (default 12s).</p>
    <form method="POST" action="${adminPath}/sponsors?key=${encodeURIComponent(key)}">
      <textarea name="json">${escapeHtml(sponsorsJson)}</textarea>
      <button type="submit">Save sponsors</button>
    </form>
  </section>

  <section class="full">
    <h2>Team branding — ${escapeHtml(scopeLabel)}</h2>
    <p class="meta">JSON object keyed by case-insensitive substring of the team name. Each value: <code>{ "primary": "#ffd23a", "secondary": "#000", "crestUrl": "https://..." }</code>. Substring match means <code>"shire"</code> matches "Shire CC, 1st XI" — pick a key that's distinctive to one team.</p>
    <form method="POST" action="${adminPath}/teams?key=${encodeURIComponent(key)}">
      <textarea name="json">${escapeHtml(teamsJson)}</textarea>
      <button type="submit">Save team branding</button>
    </form>
  </section>
</main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * Render the head-to-head card for a discovered fixture. The card is
 * deliberately compact — it slots in under each fixture row and shows the
 * tally plus the most recent meetings, each linking to its summary page.
 *
 * Three render states:
 *   - lookup failed / never ran (h2h undefined) → render the empty-state line
 *     ("first archived meeting") so the operator knows we didn't silently
 *     skip the lookup.
 *   - played === 0 → same explicit-empty state.
 *   - played > 0  → tally + list.
 *
 * `f.battingTeam` is the perspective we count wins from (the "A" side passed
 * to getHeadToHead). Verdicts are rendered relative to that team.
 */
function renderH2H(f: DiscoveredMatch, result: H2HResult | undefined, scope: string): string {
  const oppo = f.bowlingTeam || 'opposition';
  if (!result || result.summary.played === 0) {
    return `<div class="h2h empty">vs <span class="h2h-head">${escapeHtml(oppo)}</span> · <em>first archived meeting (no prior results in archive)</em></div>`;
  }

  const { played, aWins, bWins, draws, unknown } = result.summary;
  const tally = `${aWins}W / ${bWins}L / ${draws}D${unknown ? ` / ${unknown}?` : ''}`;
  const matchPrefix = scope ? `/${scope}` : '';

  const items = result.prior
    .map((m) => {
      // Score line: "Home 145/8 · Away 142/10". Falls back gracefully if
      // innings rows are missing.
      const scoreLine = m.innings.length
        ? m.innings
            .map((i) => {
              const team = i.battingTeam ?? '?';
              const runs = i.runs ?? 0;
              const wkts = i.wickets ?? 0;
              return `${escapeHtml(team)} ${runs}/${wkts}`;
            })
            .join(' · ')
        : (m.status ? `<em>${escapeHtml(m.status)}</em>` : '<em>no innings recorded</em>');

      // Verdict relative to the fixture's batting team (the "A" side).
      const verdict = verdictLabel(m, f.battingTeam, f.bowlingTeam);

      const date = new Date(m.archivedAt);
      const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

      return `<li><a href="${matchPrefix}/summary/${encodeURIComponent(m.matchId)}">${dateStr} · ${scoreLine}</a>${verdict}</li>`;
    })
    .join('');

  return `<div class="h2h">
    <div>vs <span class="h2h-head">${escapeHtml(oppo)}</span> · <span class="h2h-tally">${played} archived meeting${played === 1 ? '' : 's'} (${tally})</span></div>
    <ul class="h2h-list">${items}</ul>
  </div>`;
}

/**
 * Compute the verdict pill for a single archived meeting, from the
 * perspective of `aTeam` (the fixture's batting team / "A" side). Mirrors
 * the attribution logic in head-to-head.ts but stays decoupled — the H2H
 * module returns aggregate counts only, not per-match verdicts, so we
 * recompute here for display.
 */
function verdictLabel(m: { status: string | null; innings: { battingTeam: string | null; runs: number | null }[] }, aTeam: string, bTeam: string): string {
  const aN = aTeam.trim().toLowerCase();
  const bN = bTeam.trim().toLowerCase();
  const status = (m.status ?? '').trim().toLowerCase();
  if (status === 'drawn') return ' <span class="verdict draw">drew</span>';
  if (status !== 'finished') return ' <span class="verdict">result unknown</span>';

  let aRuns = 0;
  let bRuns = 0;
  let aSeen = false;
  let bSeen = false;
  for (const i of m.innings) {
    const bt = (i.battingTeam ?? '').trim().toLowerCase();
    const r = i.runs ?? 0;
    if (bt === aN) { aRuns += r; aSeen = true; }
    else if (bt === bN) { bRuns += r; bSeen = true; }
  }
  if (!aSeen || !bSeen) return ' <span class="verdict">result unknown</span>';
  if (aRuns > bRuns) return ' <span class="verdict win">won</span>';
  if (bRuns > aRuns) return ' <span class="verdict loss">lost</span>';
  return ' <span class="verdict draw">tied</span>';
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return `${Math.max(0, Math.floor(diffMs / 1000))}s`;
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h`;
  return `${Math.floor(diffMs / 86_400_000)}d`;
}

// ---------- Scrape log viewer ----------------------------------------------

type LogRow = {
  ts: number;
  match_id: string;
  source: string;
  ok: number;
  status: string | null;
  runs: number | null;
  wickets: number | null;
  overs: string | null;
  batting_team: string | null;
  changed: number;
  error: string | null;
};

async function renderLogsPage(env: Env, url: URL, scope: string): Promise<Response> {
  const key = adminKeyFor(env, scope) ?? '';
  const adminPath = scope ? `/${scope}/admin` : '/admin';
  const scopeLabel = scope ? scope.toUpperCase() : 'DEFAULT';

  const filterMatchId = url.searchParams.get('matchId') ?? (await getActiveMatchId(env, scope)) ?? '';
  const onlyChanges = url.searchParams.get('changes') === '1';
  const refresh = url.searchParams.get('refresh') === '1';

  let rows: LogRow[] = [];
  let queryError: string | null = null;
  try {
    const stmt = filterMatchId
      ? env.LOG_DB
          .prepare(
            `SELECT ts, match_id, source, ok, status, runs, wickets, overs, batting_team, changed, error
             FROM scrape_log
             WHERE match_id = ?1 ${onlyChanges ? 'AND changed = 1' : ''}
             ORDER BY id DESC LIMIT 500`,
          )
          .bind(filterMatchId)
      : env.LOG_DB.prepare(
          `SELECT ts, match_id, source, ok, status, runs, wickets, overs, batting_team, changed, error
           FROM scrape_log
           ${onlyChanges ? 'WHERE changed = 1' : ''}
           ORDER BY id DESC LIMIT 500`,
        );
    const res = await stmt.all<LogRow>();
    rows = res.results ?? [];
  } catch (e) {
    queryError = e instanceof Error ? e.message : String(e);
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
${refresh ? '<meta http-equiv="refresh" content="5" />' : ''}
<title>Scrape log · ${escapeHtml(scopeLabel)}</title>
<style>
  :root { --bg:#0e1116; --panel:#161a22; --border:#232a35; --accent:#ffd23a; --text:#e8eaed; --muted:#8a93a4; --ok:#3ddc84; --err:#ff5d5d; --change:#ffd23a; }
  body { margin:0; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 20px 32px; border-bottom: 1px solid var(--border); display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
  header h1 { margin:0; font-size: 16px; letter-spacing: 0.05em; text-transform: uppercase; }
  header .scope { color: var(--accent); font-weight: 800; letter-spacing: 0.18em; }
  header nav { margin-left:auto; display:flex; gap:8px; }
  header nav a { color: var(--muted); text-decoration:none; padding: 6px 12px; border:1px solid var(--border); border-radius:4px; font-size:12px; letter-spacing: 0.1em; text-transform: uppercase; }
  header nav a:hover { color: var(--accent); border-color: var(--accent); }
  .filters { padding: 14px 32px; border-bottom: 1px solid var(--border); background: var(--panel); display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  .filters label { color: var(--muted); font-size: 12px; display:flex; align-items:center; gap:6px; }
  .filters input[type=text] { padding: 6px 10px; background:#0a0d12; color: var(--text); border:1px solid var(--border); border-radius:4px; font: 12px ui-monospace, Menlo, Consolas, monospace; min-width: 180px; }
  .filters button { padding: 6px 14px; background: var(--accent); color:#0a0d12; border:none; border-radius:4px; font-weight:700; letter-spacing:0.04em; text-transform: uppercase; cursor:pointer; font-size: 11px; }
  .scroll { max-height: calc(100vh - 130px); overflow-y: auto; }
  table { width:100%; border-collapse: collapse; }
  thead { position: sticky; top: 0; background: var(--panel); z-index: 1; }
  th, td { padding: 6px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; font-variant-numeric: tabular-nums; }
  th { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  tr.err td { background: rgba(255, 93, 93, 0.08); }
  tr.changed td { background: rgba(255, 210, 58, 0.06); }
  tr.err.changed td { background: rgba(255, 93, 93, 0.10); }
  td.ok-cell { color: var(--ok); }
  td.err-cell { color: var(--err); }
  td.change-cell { color: var(--change); font-weight: 700; }
  td.muted { color: var(--muted); }
  .empty, .qerr { padding: 40px 32px; color: var(--muted); text-align: center; }
  .qerr { color: var(--err); font-family: ui-monospace, Menlo, monospace; font-size: 12px; text-align: left; padding: 16px 32px; }
  .qerr strong { display:block; margin-bottom: 6px; color: var(--err); }
</style>
</head>
<body>
<header>
  <h1>Scrape log · <span class="scope">${escapeHtml(scopeLabel)}</span></h1>
  <span style="color:var(--muted); font-size:12px;">${rows.length} row${rows.length === 1 ? '' : 's'}${filterMatchId ? ` for match <code style="color:var(--text);background:#0a0d12;padding:2px 6px;border-radius:3px;">${escapeHtml(filterMatchId)}</code>` : ' (all matches)'}</span>
  <nav>
    <a href="${adminPath}?key=${encodeURIComponent(key)}">← Back to admin</a>
  </nav>
</header>
<form class="filters" method="GET" action="${adminPath}/logs">
  <input type="hidden" name="key" value="${escapeHtml(key)}" />
  <label>Match ID
    <input type="text" name="matchId" value="${escapeHtml(filterMatchId)}" placeholder="(blank = all)" />
  </label>
  <label><input type="checkbox" name="changes" value="1" ${onlyChanges ? 'checked' : ''} /> Only changes</label>
  <label><input type="checkbox" name="refresh" value="1" ${refresh ? 'checked' : ''} /> Auto-refresh (5s)</label>
  <button type="submit">Apply</button>
</form>
${
  queryError
    ? `<div class="qerr"><strong>D1 query failed</strong>${escapeHtml(queryError)}<br><br>Have you created the database and applied the migration? See README.</div>`
    : rows.length === 0
      ? `<div class="empty">No log rows yet. Hit <code>/api/score/&lt;matchId&gt;</code> to generate some.</div>`
      : `<div class="scroll">
<table>
  <thead><tr>
    <th>When</th><th>Match</th><th>Source</th><th>OK</th><th>Status</th><th>Score</th><th>Batting</th><th>Δ</th><th>Error</th>
  </tr></thead>
  <tbody>
    ${rows
      .map((r) => {
        const cls = [r.ok === 0 ? 'err' : '', r.changed === 1 ? 'changed' : ''].filter(Boolean).join(' ');
        const score = r.ok === 0 ? '—' : `${r.runs ?? 0}/${r.wickets ?? 0} (${escapeHtml(r.overs ?? '0.0')})`;
        return `<tr class="${cls}">
          <td title="${new Date(r.ts).toISOString()}">${formatRelative(r.ts)} ago</td>
          <td><code>${escapeHtml(r.match_id)}</code></td>
          <td class="muted">${escapeHtml(r.source)}</td>
          <td class="${r.ok === 0 ? 'err-cell' : 'ok-cell'}">${r.ok === 0 ? '✗' : '✓'}</td>
          <td class="muted">${escapeHtml(r.status ?? '')}</td>
          <td>${score}</td>
          <td class="muted">${escapeHtml(r.batting_team ?? '')}</td>
          <td class="${r.changed === 1 ? 'change-cell' : 'muted'}">${r.changed === 1 ? '●' : '·'}</td>
          <td class="err-cell">${escapeHtml(r.error ?? '')}</td>
        </tr>`;
      })
      .join('')}
  </tbody>
</table>
</div>`
}
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ---------- Match archive viewer -------------------------------------------

async function renderArchivePage(env: Env, _url: URL, scope: string): Promise<Response> {
  const key = adminKeyFor(env, scope) ?? '';
  const adminPath = scope ? `/${scope}/admin` : '/admin';
  const scopeLabel = scope ? scope.toUpperCase() : 'DEFAULT';

  let rows: ArchivedMatch[] = [];
  let queryError: string | null = null;
  try {
    rows = await listArchivedMatches(env, 50);
  } catch (e) {
    queryError = e instanceof Error ? e.message : String(e);
  }

  const active = await getActiveMatchId(env, scope);
  const activeArchived = active ? await isArchived(env, active) : false;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Match archive · ${escapeHtml(scopeLabel)}</title>
<style>
  :root { --bg:#0e1116; --panel:#161a22; --border:#232a35; --accent:#ffd23a; --text:#e8eaed; --muted:#8a93a4; --ok:#3ddc84; --err:#ff5d5d; }
  body { margin:0; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 20px 32px; border-bottom: 1px solid var(--border); display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
  header h1 { margin:0; font-size: 16px; letter-spacing: 0.05em; text-transform: uppercase; }
  header .scope { color: var(--accent); font-weight: 800; letter-spacing: 0.18em; }
  header nav { margin-left:auto; display:flex; gap:8px; }
  header nav a { color: var(--muted); text-decoration:none; padding: 6px 12px; border:1px solid var(--border); border-radius:4px; font-size:12px; letter-spacing: 0.1em; text-transform: uppercase; }
  header nav a:hover { color: var(--accent); border-color: var(--accent); }
  .panel { margin: 18px 32px; padding: 16px 20px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
  .panel h2 { margin: 0 0 10px; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
  .panel p { margin: 0; color: var(--muted); }
  .panel form { display: inline; }
  .panel button { padding: 8px 16px; background: var(--accent); color: #0a0d12; border: none; border-radius: 4px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; cursor: pointer; font-size: 11px; }
  .panel button:hover { background: #ffe066; }
  .panel button[disabled] { background: #2a2e36; color: var(--muted); cursor: default; }
  .scroll { max-height: calc(100vh - 240px); overflow-y: auto; margin: 0 32px; }
  table { width:100%; border-collapse: collapse; }
  thead { position: sticky; top: 0; background: var(--panel); z-index: 1; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; font-variant-numeric: tabular-nums; }
  th { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  tr:hover td { background: rgba(255, 210, 58, 0.04); }
  td.muted { color: var(--muted); }
  td a { color: var(--accent); text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .empty, .qerr { padding: 40px 32px; color: var(--muted); text-align: center; }
  .qerr { color: var(--err); font-family: ui-monospace, Menlo, monospace; font-size: 12px; text-align: left; padding: 16px 32px; }
  .qerr strong { display:block; margin-bottom: 6px; color: var(--err); }
</style>
</head>
<body>
<header>
  <h1>Match archive · <span class="scope">${escapeHtml(scopeLabel)}</span></h1>
  <span style="color:var(--muted); font-size:12px;">${rows.length} archived match${rows.length === 1 ? '' : 'es'}</span>
  <nav>
    <a href="${adminPath}?key=${encodeURIComponent(key)}">← Back to admin</a>
  </nav>
</header>

<div class="panel">
  <h2>Archive active match — ${escapeHtml(scopeLabel)}</h2>
  ${
    active
      ? activeArchived
        ? `<p>Active match <code>${escapeHtml(active)}</code> is already archived. Re-archiving will overwrite (idempotent).</p>
           <form method="POST" action="/api/admin/archive/${encodeURIComponent(active)}?key=${encodeURIComponent(key)}${scope ? '&scope=' + encodeURIComponent(scope) : ''}" style="margin-top:10px">
             <button type="submit">Re-archive ${escapeHtml(active)}</button>
           </form>`
        : `<p>Active match: <code>${escapeHtml(active)}</code></p>
           <form method="POST" action="/api/admin/archive/${encodeURIComponent(active)}?key=${encodeURIComponent(key)}${scope ? '&scope=' + encodeURIComponent(scope) : ''}" style="margin-top:10px">
             <button type="submit">Archive now</button>
           </form>`
      : `<p><em>No active match for this scope. Set one on the admin page first.</em></p>`
  }
</div>

${
  queryError
    ? `<div class="qerr"><strong>D1 query failed</strong>${escapeHtml(queryError)}<br><br>Have you applied migration 0002_match_archive.sql?</div>`
    : rows.length === 0
      ? `<div class="empty">No archived matches yet. Completed matches auto-archive once the scrape pipeline detects a terminal status.</div>`
      : `<div class="scroll">
<table>
  <thead><tr>
    <th>Archived</th><th>Match ID</th><th>Scope</th><th>Teams</th><th>Status</th><th>Events</th><th>Balls</th><th>Links</th>
  </tr></thead>
  <tbody>
    ${rows
      .map((r) => {
        const teams = [r.home_team, r.away_team].filter(Boolean).join(' v ') || '—';
        const matchPrefix = r.scope ? `/${r.scope}` : '';
        return `<tr>
          <td title="${new Date(r.archived_at).toISOString()}">${formatRelative(r.archived_at)} ago</td>
          <td><code>${escapeHtml(r.match_id)}</code></td>
          <td class="muted">${escapeHtml(r.scope || 'default')}</td>
          <td>${escapeHtml(teams)}</td>
          <td class="muted">${escapeHtml(r.status ?? '')}</td>
          <td>${r.total_events}</td>
          <td>${r.total_balls}</td>
          <td>
            <a href="/api/archive/${encodeURIComponent(r.match_id)}" target="_blank" rel="noopener">JSON</a>
            · <a href="${matchPrefix}/summary/${encodeURIComponent(r.match_id)}" target="_blank" rel="noopener">summary</a>
          </td>
        </tr>`;
      })
      .join('')}
  </tbody>
</table>
</div>`
}
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

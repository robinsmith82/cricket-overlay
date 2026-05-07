import type { Env, Score } from './types';
import { generateMockScore, scrapeMatch } from './scraper';
import { renderOverlay } from './overlay';
import { readBranding } from './branding';
import { handleAdmin, getActiveMatchId, isAdmin } from './admin';
import { archiveMatch, isArchived, readArchivedMatch, isTerminalStatus, recordInningsTransition } from './match-archive';
import { discoverMatches } from './discovery';
import { getHeadToHead } from './head-to-head';
import { readAllBallTags, readYouTube } from './archive';
import { readEvents, detectAndAppendEvents, appendEvent, type MatchEvent } from './events';
import { renderSpectator } from './spectator';
import { handleTaggerPost, renderTaggerPage } from './tagger';
import { logScrape } from './log';
import { renderNonTechSpec } from './docs';
import { renderHighlights } from './highlights';
import { renderSummary } from './summary';
import { renderEmbedScore, renderEmbedClip } from './embed';
import { renderShareCardSvg } from './share';
import { svgToPng } from './png';
import { renderReel } from './reel';
import { mintScorerCookieIfAuth, resolveVoter, checkRateLimit } from './voting';
import { bumpVibe, readAllVibes, VIBES, type Vibe } from './vibes';
import { getCommentaryForOver } from './commentary';
import { getPlayerStats, listKnownPlayers, renderPlayerPage, renderPlayerNotFound, renderPlayersIndex } from './player';
import { renderArchiveBrowserPage, handleArchiveSearchApi } from './archive-browser';
import { getMatchReport, MODEL as REPORT_MODEL } from './report';
import { getCaption } from './captions';
import { listClubs, upsertClub, deleteClub, ensureSeeded, type Club } from './clubs';
import { SCRAPERS } from './scrapers';
import { DISCOVERIES } from './discoveries';

const CACHE_MAX_AGE_MS = 25_000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

function jsonResponse(body: Score, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

function escapeHtmlForReport(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

async function renderReportPage(env: Env, scope: string, matchId: string, origin: string): Promise<string> {
  const safeId = matchId.replace(/[^a-zA-Z0-9_-]/g, '');
  const report = await getMatchReport(env, scope, matchId).catch(() => null);
  const text = report && !report.empty ? report.text : '';
  const generatedAt = report?.generatedAt ?? 0;
  const model = report?.model ?? REPORT_MODEL;
  const stamp = generatedAt
    ? new Date(generatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : '';
  const title = 'Match report';
  const summaryUrl = `${scope ? '/' + scope : ''}/summary/${encodeURIComponent(safeId)}`;
  // OG image: re-use the share card if it exists for event 0. Defensive — the
  // share card route returns 200 even when there's no event there.
  const ogImage = `${origin}${scope ? '/' + scope : ''}/share/${encodeURIComponent(safeId)}/0.png`;
  const paragraphs = text
    ? text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    : [];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0e1116" />
<title>${escapeHtmlForReport(title)}</title>
<meta property="og:type" content="article" />
<meta property="og:title" content="${escapeHtmlForReport(title)}" />
<meta property="og:image" content="${escapeHtmlForReport(ogImage)}" />
<meta name="twitter:card" content="summary_large_image" />
<style>
  :root { --bg:#0e1116; --panel:#161a22; --border:#232a35; --accent:#ffd23a; --text:#e8eaed; --muted:#8a93a4; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:var(--bg); color:var(--text); }
  body { font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
  main { max-width: 640px; margin: 0 auto; padding: 28px 18px 36px; }
  h1 { font-size: 13px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent); margin: 0 0 18px; }
  article { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 22px 24px; }
  article p { margin: 0 0 14px; }
  article p:last-child { margin-bottom: 0; }
  .empty { color: var(--muted); font-style: italic; }
  .footer { margin-top: 18px; color: var(--muted); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }
  .footer a { color: var(--muted); text-decoration: none; border-bottom: 1px dotted var(--muted); }
  .footer a:hover { color: var(--accent); border-color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Match report</h1>
  <article>
    ${
      paragraphs.length
        ? paragraphs.map((p) => `<p>${escapeHtmlForReport(p)}</p>`).join('')
        : `<p class="empty">No report yet — match data is still coming in.</p>`
    }
  </article>
  <div class="footer">
    ${stamp ? `Generated by Llama 3.1 · ${escapeHtmlForReport(stamp)} · ` : `Model: ${escapeHtmlForReport(model)} · `}
    <a href="${escapeHtmlForReport(summaryUrl)}">Match summary</a>
  </div>
</main>
</body>
</html>`;
}

async function renderIndexPage(env: Env): Promise<string> {
  // Demo links should land on something real. Pick the 3rd XI's active match
  // when set; otherwise fall back to the mock seed (which /admin/mock-seed
  // populates for exactly this purpose).
  const active3s = await getActiveMatchId(env, '3s').catch(() => null);
  const demoLiveMatch = active3s ?? 'mock-demo-3s';
  const demoHighlightsMatch = active3s ?? 'mock-demo-3s';
  const githubUrl = 'https://github.com/robinsmith82/cricket-overlay-oss';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cricket overlay — streaming kit for club cricket</title>
<meta name="description" content="TV-style score bar in OBS, per-ball clips, auto-ranked highlights, on-phone moment stamping. One Cloudflare Worker, free tier. Open source." />
<style>
  :root { --bg:#0e1116; --panel:#161a22; --border:#232a35; --accent:#ffd23a; --text:#e8eaed; --muted:#8a93a4; --green:#3ddc84; }
  * { box-sizing: border-box; }
  body { margin:0; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
  main { max-width: 720px; margin: 0 auto; padding: 56px 24px 80px; }
  .hero h1 { margin: 0 0 10px; font-size: 38px; letter-spacing: -0.01em; line-height: 1.1; }
  .hero p.lede { margin: 0 0 20px; color: var(--muted); font-size: 17px; line-height: 1.5; }
  .hero .ctas { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
  .btn { display: inline-block; padding: 11px 20px; border-radius: 999px; font-weight: 700; font-size: 14px; text-decoration: none; border: 1px solid var(--border); color: var(--text); }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn.primary { background: var(--accent); color: #0a0d12; border-color: var(--accent); }
  .btn.primary:hover { background: #ffe066; color: #0a0d12; }
  section.block { margin-top: 48px; }
  section.block h2 { font-size: 14px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); margin: 0 0 16px; }
  ol.howto { padding: 0; margin: 0; list-style: none; counter-reset: step; }
  ol.howto li { counter-increment: step; padding: 16px 18px 16px 56px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 10px; position: relative; }
  ol.howto li::before { content: counter(step); position: absolute; left: 18px; top: 16px; width: 26px; height: 26px; line-height: 26px; text-align: center; border-radius: 50%; background: var(--accent); color: #0a0d12; font-weight: 800; font-size: 13px; }
  ol.howto li strong { display: block; font-size: 16px; margin-bottom: 4px; }
  ol.howto li p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.55; }
  .fork { background: var(--panel); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 10px; padding: 22px 24px; }
  .fork h2 { margin: 0 0 10px; font-size: 18px; letter-spacing: normal; text-transform: none; color: var(--text); }
  .fork p { color: var(--muted); margin: 0 0 14px; font-size: 14px; }
  .fork ul { color: var(--muted); margin: 0 0 16px; padding-left: 20px; font-size: 13px; }
  .fork ul li { margin: 4px 0; }
  .deploy-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); }
  .deploy { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
  .deploy h3 { margin: 0 0 10px; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent); }
  .deploy ul { list-style: none; padding: 0; margin: 0; }
  .deploy a { color: var(--text); text-decoration: none; font-size: 13px; }
  .deploy a:hover { color: var(--accent); }
  .deploy code { color: var(--muted); font-size: 11px; }
  footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
  footer p { margin: 6px 0; }
  footer code { color: var(--text); background: #0a0d12; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
  footer a { color: var(--accent); text-decoration: none; }
  footer a:hover { text-decoration: underline; }
</style>
</head>
<body>
<main>
  <section class="hero">
    <h1>Cricket overlay</h1>
    <p class="lede">Streaming kit for club cricket. TV-style score bar in OBS, per-ball clips, auto-ranked highlights, on-phone moment stamping. One Cloudflare Worker — free tier.</p>
    <div class="ctas">
      <a class="btn primary" href="/3s/live/${encodeURIComponent(demoLiveMatch)}">▶ See it live (3rd XI)</a>
      <a class="btn" href="/3s/highlights/${encodeURIComponent(demoHighlightsMatch)}">★ Highlights demo</a>
      <a class="btn" href="/docs">Plain-English spec</a>
    </div>
  </section>

  <section class="block">
    <h2>How it works</h2>
    <ol class="howto">
      <li>
        <strong>Score</strong>
        <p>Every ~25 seconds we poll Play-Cricket for the live score. Runs, wickets, overs, batters, last ball, partnership and run-rate go into a Cloudflare KV cache. The match ID is the number at the end of the Play-Cricket match URL — that's the only key the system needs to plug into a fixture.</p>
      </li>
      <li>
        <strong>Overlay</strong>
        <p>OBS pulls a single Browser Source URL that always tracks whichever match is set active. The score bar, sponsor strip and last-out ribbon render at 1920×1080 over your camera. Set up the URL in OBS once — it follows you to the next match without edits.</p>
      </li>
      <li>
        <strong>Clips</strong>
        <p>Paste the YouTube watch URL into admin once you've clicked Start Streaming. We ask the YouTube Data API for the broadcast's actual start time, so every wicket / four / six / fifty becomes a deep-link to the exact second of the replay.</p>
      </li>
      <li>
        <strong>Stamp</strong>
        <p>The scorer keeps the highlights page open on a phone. When something happens that the scrape would miss — a great catch, a dropped one, a wild appeal — they tap <strong>Stamp now</strong> with an optional note. A clip card appears immediately, with a YouTube deep-link bounded to the moment.</p>
      </li>
    </ol>
  </section>

  <section class="block">
    <div class="fork">
      <h2>Want this for your own club?</h2>
      <p>Everything here is open source. One Cloudflare Worker, ~5k lines of TypeScript, no servers to run. Free tier covers a full club season comfortably.</p>
      <ul>
        <li>A Cloudflare account (free)</li>
        <li>A Play-Cricket club whose match centre we can scrape</li>
        <li>OBS on a Mac or PC, linked to a YouTube account</li>
        <li>Optional: a YouTube Data API key (free) for accurate clip timestamps</li>
      </ul>
      <a class="btn primary" href="${githubUrl}">View source on GitHub →</a>
    </div>
  </section>

  <section class="block">
    <h2>Live deployments</h2>
    <div class="deploy-grid">
      <div class="deploy">
        <h3>3rd XI</h3>
        <ul>
          <li><a href="/3s/overlay/active">/3s/overlay/active</a> <code>OBS source</code></li>
          <li><a href="/3s/live">/3s/live</a> <code>spectator</code></li>
          <li><a href="/3s/highlights">/3s/highlights</a> <code>highlights</code></li>
          <li><a href="/3s/admin">/3s/admin</a> <code>admin (?key=…)</code></li>
        </ul>
      </div>
      <div class="deploy">
        <h3>4th XI</h3>
        <ul>
          <li><a href="/4s/overlay/active">/4s/overlay/active</a> <code>OBS source</code></li>
          <li><a href="/4s/live">/4s/live</a> <code>spectator</code></li>
          <li><a href="/4s/highlights">/4s/highlights</a> <code>highlights</code></li>
          <li><a href="/4s/admin">/4s/admin</a> <code>admin (?key=…)</code></li>
        </ul>
      </div>
      <div class="deploy">
        <h3>Default (legacy)</h3>
        <ul>
          <li><a href="/overlay/active">/overlay/active</a></li>
          <li><a href="/overlay/test?mock=1">/overlay/test?mock=1</a></li>
          <li><a href="/admin">/admin</a></li>
        </ul>
      </div>
    </div>
  </section>

  <footer>
    <p>Admin keys are Cloudflare Workers secrets — set with <code>wrangler secret put ADMIN_KEY</code> (also <code>ADMIN_KEY_3S</code> / <code>ADMIN_KEY_4S</code> for the 3rd/4th XI scopes). Append <code>?key=&lt;value&gt;</code> to admin URLs.</p>
    <p>Raw score JSON: <code>/api/score/&lt;matchId&gt;</code>. Add <code>?mock=1</code> for fake ticking data.</p>
    <p>Source on <a href="${githubUrl}">GitHub</a>. Longer read: <a href="/docs">plain-English spec</a>.</p>
  </footer>
</main>
</body>
</html>`;
}

/**
 * Auto-archive trigger. Called from the scrape pipeline after every successful
 * cache-miss scrape. Only runs the heavy archive work when:
 *   1. The score reports a terminal status (finished / drawn / abandoned / no_result), AND
 *   2. We haven't already archived this match.
 * Both checks are cheap (string compare + indexed D1 lookup). Archive
 * failures throw out of `archiveMatch`; the caller catches so a broken
 * archive never breaks the live overlay.
 */
async function maybeAutoArchive(env: Env, score: Score): Promise<void> {
  if (!score.matchId) return;
  if (!isTerminalStatus(score)) return;
  if (await isArchived(env, score.matchId)) return;
  await archiveMatch(env, score.matchId, '');
}

async function getScore(env: Env, matchId: string): Promise<Score> {
  const cacheKey = `score:${matchId}`;
  const lastGoodKey = `score:${matchId}:last_good`;

  const cachedRaw = await env.CRICKET_CACHE.get(cacheKey);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as Score;
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < CACHE_MAX_AGE_MS) return cached;
    } catch {
      // fall through to re-scrape
    }
  }

  const fresh = await scrapeMatch(matchId, env);
  // Audit every real scrape attempt (cache miss). Logging never blocks the
  // response and never throws — see src/log.ts.
  await logScrape(env, fresh);
  if (!fresh.error) {
    // Seal the previous innings *before* we overwrite last_good, since the
    // transition detector reads last_good to capture the previous innings'
    // final state. Idempotent (won't overwrite an existing sealed snapshot)
    // and tolerant of failure — never blocks the live overlay.
    await recordInningsTransition(env, fresh).catch(() => { /* never block scrape */ });
    await Promise.all([
      env.CRICKET_CACHE.put(cacheKey, JSON.stringify(fresh)),
      env.CRICKET_CACHE.put(lastGoodKey, JSON.stringify(fresh)),
      // Detect wickets / 4 / 6 / 50 / 100 / team milestones by diffing this
      // scrape against the previous snapshot. Idempotent on identical
      // scores — safe to call on every cache miss. This was the silently
      // broken bit: the detector existed but was never invoked, so
      // events:{matchId} stayed empty for every real match.
      detectAndAppendEvents(env, fresh).catch(() => { /* never block scrape */ }),
      // Auto-archive when the match reaches a terminal status. Guarded by
      // isArchived so we only run once per match (idempotent INSERT OR
      // REPLACE on retry, but no point retrying every cache miss). Wrapped
      // in catch — archive failures must never break the live overlay.
      maybeAutoArchive(env, fresh).catch(() => { /* never block scrape */ }),
    ]);
    return fresh;
  }

  const lastGoodRaw = await env.CRICKET_CACHE.get(lastGoodKey);
  if (lastGoodRaw) {
    try {
      const lastGood = JSON.parse(lastGoodRaw) as Score;
      return { ...lastGood, stale: true };
    } catch {
      // ignore parse errors, fall through
    }
  }

  return fresh;
}

/**
 * GET /tag/:matchId handler. Anyone can hit this URL; the page is the same.
 * The only difference between scorer and crowd: scorer has a signed cookie
 * that weights their votes 5×. The cookie is minted server-side here when
 * a request arrives with `?key=<admin>` and the key matches; we then drop
 * the key from the URL via a 303 redirect so it doesn't sit in browser
 * history / get accidentally shared.
 */
async function renderTaggerWithMaybeScorerCookie(
  request: Request,
  env: Env,
  scope: string,
  matchId: string,
  url: URL,
): Promise<Response> {
  const providedKey = url.searchParams.get('key');
  if (providedKey) {
    const cookie = await mintScorerCookieIfAuth(env, scope, providedKey);
    if (cookie) {
      // Strip ?key= from the URL on the way out so the URL the user shares
      // doesn't accidentally hand out scorer status to anyone who taps it.
      const clean = new URL(url.toString());
      clean.searchParams.delete('key');
      const headers = new Headers({ Location: clean.toString() });
      headers.append('Set-Cookie', cookie);
      return new Response(null, { status: 303, headers });
    }
  }
  const voter = await resolveVoter(request, env, scope);
  const html = await renderTaggerPage(env, scope, matchId, voter.isScorer);
  const res = new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
  for (const c of voter.setCookieHeaders) res.headers.append('Set-Cookie', c);
  return res;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/api/discover' || url.pathname === '/api/discover/') {
      const matches = await discoverMatches(env);
      return new Response(JSON.stringify({ matches }), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...CORS_HEADERS,
        },
      });
    }

    // Public head-to-head lookup. Scope-agnostic: the archive is one
    // database, queried by team name. Returns the same shape as the internal
    // helper so the spectator page (or future surfaces) can consume it
    // directly. ?limit= caps how many recent meetings come back.
    if (url.pathname === '/api/head-to-head' || url.pathname === '/api/head-to-head/') {
      const teamA = url.searchParams.get('teamA') ?? '';
      const teamB = url.searchParams.get('teamB') ?? '';
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw ? Math.min(50, Math.max(1, parseInt(limitRaw, 10) || 5)) : undefined;
      if (!teamA || !teamB) {
        return new Response(JSON.stringify({ error: 'teamA and teamB query params are required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
        });
      }
      try {
        const result = await getHeadToHead(env, teamA, teamB, limit ? { limit } : undefined);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ error: 'lookup_failed', message: msg }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
        });
      }
    }

    if (
      url.pathname === '/docs' ||
      url.pathname === '/docs/' ||
      url.pathname === '/docs/non-tech-spec' ||
      url.pathname === '/docs/non-tech-spec/'
    ) {
      return htmlResponse(renderNonTechSpec());
    }

    // Player career pages — scope-agnostic, since the archive aggregates
    // across all scopes. Read raw url.pathname (not the scope-stripped
    // routePath) so /3s/player/foo and /player/foo resolve identically.
    if (url.pathname === '/players' || url.pathname === '/players/') {
      const players = await listKnownPlayers(env);
      return htmlResponse(renderPlayersIndex(players));
    }
    const playerMatch = url.pathname.match(/^\/player\/([^/]+)\/?$/);
    if (playerMatch) {
      const slug = decodeURIComponent(playerMatch[1]);
      const stats = await getPlayerStats(env, slug);
      if (!stats) {
        return new Response(renderPlayerNotFound(slug), {
          status: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
        });
      }
      return htmlResponse(renderPlayerPage(stats));
    }

    const apiMatch = url.pathname.match(/^\/api\/score\/([^/]+)\/?$/);
    if (apiMatch) {
      const matchId = decodeURIComponent(apiMatch[1]);
      const mockParam = url.searchParams.get('mock');
      if (mockParam === '1' || mockParam === '2') {
        const mock = generateMockScore(mockParam === '2' ? 2 : 1);
        return jsonResponse({ ...mock, matchId });
      }
      const score = await getScore(env, matchId);
      return jsonResponse(score);
    }

    // Scope-aware routing: /3s/..., /4s/... carry a scope prefix; root paths
    // are the default scope.
    const SCOPES = ['3s', '4s'];
    let scope = '';
    let routePath = url.pathname;
    for (const s of SCOPES) {
      if (routePath === `/${s}` || routePath.startsWith(`/${s}/`)) {
        scope = s;
        routePath = routePath.slice(s.length + 1) || '/';
        break;
      }
    }

    const apiTagsMatch = routePath.match(/^\/api\/tags\/([^/]+)\/?$/);
    if (apiTagsMatch) {
      const matchId = decodeURIComponent(apiTagsMatch[1]);
      const tags = await readAllBallTags(env, matchId);
      const counts = new Array(9).fill(0);
      const shots: Record<string, number> = {};
      for (const t of tags) {
        counts[t.tag.zone] = (counts[t.tag.zone] ?? 0) + 1;
        if (t.tag.shot) shots[t.tag.shot] = (shots[t.tag.shot] ?? 0) + 1;
      }
      return new Response(JSON.stringify({ counts, shots, total: tags.length, lastTaggedAt: tags.length ? tags[tags.length - 1].tag.taggedAt : 0 }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
      });
    }

    const apiEventsMatch = routePath.match(/^\/api\/events\/([^/]+)\/?$/);
    if (apiEventsMatch) {
      const matchId = decodeURIComponent(apiEventsMatch[1]);
      const [events, youtube] = await Promise.all([readEvents(env, matchId), readYouTube(env, scope)]);
      return new Response(JSON.stringify({ events, youtube }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
      });
    }

    // Admin-only manual event stamp. Drives the "Stamp now" button on
    // /highlights — appends a MatchEvent at Date.now() and auto-closes the
    // previous open manual stamp's endTs. Returns the new event index so the
    // client can deep-link to /embed/clip/:matchId/:idx straight away.
    const apiStampMatch = routePath.match(/^\/api\/admin\/stamp\/([^/]+)\/?$/);
    if (apiStampMatch && request.method === 'POST') {
      if (!isAdmin(env, url, scope)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      const matchId = decodeURIComponent(apiStampMatch[1]);
      let body: { type?: unknown; note?: unknown } = {};
      try { body = await request.json() as typeof body; } catch { body = {}; }
      const ALLOWED_TYPES: MatchEvent['type'][] = ['moment', '4', '6', 'wicket'];
      const rawType = typeof body.type === 'string' ? body.type : 'moment';
      const type = (ALLOWED_TYPES as string[]).includes(rawType)
        ? (rawType as MatchEvent['type'])
        : 'moment';
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
      // Snapshot current score so the stamp carries over/innings context.
      // getScore can throw on transient scrape failures — fall back to safe
      // defaults rather than 500-ing the stamp.
      let over = '0.0';
      let innings = 1;
      try {
        const score = await getScore(env, matchId);
        if (!score.error) {
          over = score.overs ?? '0.0';
          innings = score.innings ?? 1;
        }
      } catch {
        // keep defaults
      }
      const evt: MatchEvent = {
        ts: Date.now(),
        type,
        over,
        innings,
        manual: true,
        ...(note ? { note } : {}),
      };
      const combined = await appendEvent(env, matchId, evt);
      return new Response(JSON.stringify({ ok: true, idx: combined.length - 1, event: evt }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
      });
    }

    // Public archive browser. Global (not per-scope) — the matches row
    // already carries its scope, so the listing is unified across scopes.
    if (url.pathname === '/archive' || url.pathname === '/archive/') {
      return renderArchiveBrowserPage(env, url);
    }
    if (url.pathname === '/api/archive/search' || url.pathname === '/api/archive/search/') {
      return handleArchiveSearchApi(env, url);
    }

    // Public read of an archived match. Returns 404 when the match hasn't
    // been promoted to D1 yet. Uses raw url.pathname (not the scope-stripped
    // routePath) so /api/archive/:id is identical across all scopes — the
    // scope was already saved into the matches row at archive time.
    const apiArchiveMatch = url.pathname.match(/^\/api\/archive\/([^/]+)\/?$/);
    if (apiArchiveMatch) {
      const matchId = decodeURIComponent(apiArchiveMatch[1]);
      try {
        const bundle = await readArchivedMatch(env, matchId);
        if (!bundle) {
          return new Response(JSON.stringify({ error: 'not_archived', matchId }), {
            status: 404,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
          });
        }
        return new Response(JSON.stringify(bundle), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', ...CORS_HEADERS },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ error: 'archive_read_failed', message: msg }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
        });
      }
    }

    // Admin-gated archive trigger. Honours the ?key=… auth pattern; the scope
    // for key-matching can be passed via ?scope= (defaults to default scope).
    const apiAdminArchiveMatch = url.pathname.match(/^\/api\/admin\/archive\/([^/]+)\/?$/);
    if (apiAdminArchiveMatch && request.method === 'POST') {
      const matchId = decodeURIComponent(apiAdminArchiveMatch[1]);
      const archiveScope = url.searchParams.get('scope') ?? '';
      if (!isAdmin(env, url, archiveScope)) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      try {
        const result = await archiveMatch(env, matchId, archiveScope);
        // Form posts come from the /admin/archive page — bounce back to it.
        const accept = request.headers.get('accept') ?? '';
        if (accept.includes('text/html')) {
          const adminPath = archiveScope ? `/${archiveScope}/admin/archive` : '/admin/archive';
          const k = url.searchParams.get('key') ?? '';
          return Response.redirect(`${url.origin}${adminPath}?key=${encodeURIComponent(k)}`, 303);
        }
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ error: 'archive_failed', message: msg }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
    }

    // Admin-gated club registry write API. Mirrors the auth pattern of
    // /api/admin/archive — `?key=…` against the default `ADMIN_KEY`. The
    // registry is global (not per-scope) so we don't take a `?scope=` param.
    //
    // Accepts both application/json (for programmatic callers) and
    // application/x-www-form-urlencoded (for the <form> on /admin/clubs).
    // On HTML form posts we 303-redirect back to the page; JSON callers get
    // the saved Club back.
    if (url.pathname === '/api/admin/clubs' || url.pathname === '/api/admin/clubs/') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      if (!isAdmin(env, url, '')) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      const ctype = (request.headers.get('content-type') ?? '').toLowerCase();
      const isJson = ctype.includes('application/json');
      let payload: {
        slug?: unknown;
        name?: unknown;
        scraperId?: unknown;
        discoveryId?: unknown;
        scraperConfig?: unknown;
        discoveryConfig?: unknown;
      } = {};
      try {
        if (isJson) {
          payload = (await request.json()) as typeof payload;
        } else {
          const form = await request.formData();
          payload = {
            slug: form.get('slug'),
            name: form.get('name'),
            scraperId: form.get('scraperId'),
            discoveryId: form.get('discoveryId'),
          };
        }
      } catch {
        return new Response(JSON.stringify({ error: 'bad_body', message: 'Could not parse body.' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      try {
        const saved = await upsertClub(env, {
          slug: String(payload.slug ?? ''),
          name: String(payload.name ?? ''),
          scraperId: String(payload.scraperId ?? ''),
          discoveryId: String(payload.discoveryId ?? ''),
          scraperConfig: typeof payload.scraperConfig === 'object' && payload.scraperConfig !== null
            ? (payload.scraperConfig as Record<string, string>)
            : undefined,
          discoveryConfig: typeof payload.discoveryConfig === 'object' && payload.discoveryConfig !== null
            ? (payload.discoveryConfig as Record<string, string>)
            : undefined,
        });
        if (!isJson) {
          const k = url.searchParams.get('key') ?? '';
          return Response.redirect(`${url.origin}/admin/clubs?key=${encodeURIComponent(k)}`, 303);
        }
        return new Response(JSON.stringify(saved), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ error: 'validation_failed', message: msg }), {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
    }

    // Admin-gated club delete. Same auth as upsert. Both JSON and form posts
    // are accepted; form posts redirect back to /admin/clubs.
    const apiAdminClubsDelete = url.pathname.match(/^\/api\/admin\/clubs\/([^/]+)\/delete\/?$/);
    if (apiAdminClubsDelete && request.method === 'POST') {
      if (!isAdmin(env, url, '')) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      const slug = decodeURIComponent(apiAdminClubsDelete[1]);
      const accept = request.headers.get('accept') ?? '';
      const wantsHtml = accept.includes('text/html');
      try {
        await deleteClub(env, slug);
        if (wantsHtml) {
          const k = url.searchParams.get('key') ?? '';
          return Response.redirect(`${url.origin}/admin/clubs?key=${encodeURIComponent(k)}`, 303);
        }
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return new Response(JSON.stringify({ error: 'delete_failed', message: msg }), {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
    }

    // Embed: /embed/score/:matchId — tiny score iframe
    const embedScoreMatch = routePath.match(/^\/embed\/score\/([^/]+)\/?$/);
    if (embedScoreMatch) {
      const matchId = decodeURIComponent(embedScoreMatch[1]);
      return htmlResponse(renderEmbedScore(matchId, scope));
    }
    // Embed: /embed/clip/:matchId/:eventIdx — YouTube iframe cued to that ball
    const embedClipMatch = routePath.match(/^\/embed\/clip\/([^/]+)\/(\d+)\/?$/);
    if (embedClipMatch) {
      const matchId = decodeURIComponent(embedClipMatch[1]);
      const eventIdx = parseInt(embedClipMatch[2], 10);
      // Caption generation must never break the embed. If Workers AI is
      // down or the call throws, fall through with no caption — embed.ts
      // will use the mechanical describe() text as before.
      let caption = '';
      try {
        const c = await getCaption(env, matchId, eventIdx);
        if (!c.empty) caption = c.text;
      } catch {
        caption = '';
      }
      return htmlResponse(await renderEmbedClip(env, matchId, scope, eventIdx, caption));
    }

    // Share card: /share/:matchId/:eventIdx.svg
    const shareSvgMatch = routePath.match(/^\/share\/([^/]+)\/(\d+)\.svg$/);
    if (shareSvgMatch) {
      const matchId = decodeURIComponent(shareSvgMatch[1]);
      const eventIdx = parseInt(shareSvgMatch[2], 10);
      const branding = await readBranding(env, scope);
      // Caption is best-effort; share-card rendering must never break if
      // Workers AI is unavailable. Fall through with an empty string and
      // share.ts will use the mechanical subline.
      let caption = '';
      try {
        const c = await getCaption(env, matchId, eventIdx);
        if (!c.empty) caption = c.text;
      } catch {
        caption = '';
      }
      const svg = await renderShareCardSvg(env, matchId, scope, eventIdx, branding, caption);
      return new Response(svg, {
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          ...CORS_HEADERS,
        },
      });
    }

    // Share card PNG: /share/:matchId/:eventIdx.png — same content as the SVG
    // route, but rasterised via resvg-wasm so WhatsApp/Twitter/iMessage link
    // previews actually render (they don't rasterise SVG).
    const sharePngMatch = routePath.match(/^\/share\/([^/]+)\/(\d+)\.png$/);
    if (sharePngMatch) {
      const matchId = decodeURIComponent(sharePngMatch[1]);
      const eventIdx = parseInt(sharePngMatch[2], 10);
      const branding = await readBranding(env, scope);
      let caption = '';
      try {
        const c = await getCaption(env, matchId, eventIdx);
        if (!c.empty) caption = c.text;
      } catch {
        caption = '';
      }
      const svg = await renderShareCardSvg(env, matchId, scope, eventIdx, branding, caption);
      const png = await svgToPng(svg, 1200, 630);
      return new Response(png, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=300',
          ...CORS_HEADERS,
        },
      });
    }

    if (routePath === '/overlay/active' || routePath === '/overlay/active/') {
      const active = (await getActiveMatchId(env, scope)) ?? 'test';
      const branding = await readBranding(env, scope);
      return htmlResponse(renderOverlay(active, branding, scope));
    }

    if (routePath === '/live' || routePath === '/live/') {
      const isMock = url.searchParams.get('mock') === '1' || url.searchParams.get('mock') === '2';
      const active = isMock ? 'test' : ((await getActiveMatchId(env, scope)) ?? 'test');
      return htmlResponse(renderSpectator(active, scope));
    }
    const liveMatch = routePath.match(/^\/live\/([^/]+)\/?$/);
    if (liveMatch) {
      const matchId = decodeURIComponent(liveMatch[1]);
      return htmlResponse(renderSpectator(matchId, scope));
    }

    if (routePath === '/highlights' || routePath === '/highlights/') {
      const active = (await getActiveMatchId(env, scope)) ?? 'test';
      return htmlResponse(await renderHighlights(env, active, scope, url));
    }
    const highlightsMatch = routePath.match(/^\/highlights\/([^/]+)\/?$/);
    if (highlightsMatch) {
      const matchId = decodeURIComponent(highlightsMatch[1]);
      return htmlResponse(await renderHighlights(env, matchId, scope, url));
    }

    // Score fetcher used by /summary. Honours ?mock=1|2 by short-circuiting
    // to the synthetic score generator (same as /api/score does), so the
    // hero / current-state panels populate against fake data without
    // requiring a live match. Persisted events/tags are still empty under
    // mock — that's what the mock seeder is for.
    const summaryMockParam = url.searchParams.get('mock');
    const summaryFetcher = (id: string): Promise<Score> => {
      if (summaryMockParam === '1' || summaryMockParam === '2') {
        const m = generateMockScore(summaryMockParam === '2' ? 2 : 1);
        return Promise.resolve({ ...m, matchId: id });
      }
      return getScore(env, id);
    };

    if (routePath === '/summary' || routePath === '/summary/') {
      const isMock = summaryMockParam === '1' || summaryMockParam === '2';
      const active = isMock ? 'test' : ((await getActiveMatchId(env, scope)) ?? 'test');
      return htmlResponse(await renderSummary(env, active, scope, summaryFetcher, url.origin));
    }
    const summaryMatch = routePath.match(/^\/summary\/([^/]+)\/?$/);
    if (summaryMatch) {
      const matchId = decodeURIComponent(summaryMatch[1]);
      return htmlResponse(await renderSummary(env, matchId, scope, summaryFetcher, url.origin));
    }

    // Tagger POST: /[scope]/tag/:matchId/zone — open, cookie-driven
    const tagPostMatch = routePath.match(/^\/tag\/([^/]+)\/zone\/?$/);
    if (tagPostMatch && request.method === 'POST') {
      const matchId = decodeURIComponent(tagPostMatch[1]);
      const scopedUrl = new URL(url.toString());
      scopedUrl.pathname = routePath;
      return handleTaggerPost(request, env, scopedUrl, scope, matchId);
    }
    // Tagger UI: /[scope]/tag/:matchId  (open; ?key=… mints a scorer cookie)
    const tagPageMatch = routePath.match(/^\/tag\/([^/]+)\/?$/);
    if (tagPageMatch) {
      const matchId = decodeURIComponent(tagPageMatch[1]);
      return renderTaggerWithMaybeScorerCookie(request, env, scope, matchId, url);
    }
    // Tagger UI shortcut: /[scope]/tag → active match
    if (routePath === '/tag' || routePath === '/tag/') {
      const active = (await getActiveMatchId(env, scope)) ?? 'test';
      return renderTaggerWithMaybeScorerCookie(request, env, scope, active, url);
    }

    // AI match report JSON: /[scope]/api/report/:matchId
    // Public read; ?force=1 requires admin auth (re-uses the admin key gate).
    const apiReportMatch = routePath.match(/^\/api\/report\/([^/]+)\/?$/);
    if (apiReportMatch) {
      const matchId = decodeURIComponent(apiReportMatch[1]);
      const wantsForce = url.searchParams.get('force') === '1';
      if (wantsForce) {
        const expected =
          scope === '3s' ? env.ADMIN_KEY_3S
          : scope === '4s' ? env.ADMIN_KEY_4S
          : env.ADMIN_KEY;
        if (!expected || url.searchParams.get('key') !== expected) {
          return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
          });
        }
      }
      const result = await getMatchReport(env, scope, matchId, wantsForce);
      return new Response(JSON.stringify(result), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...CORS_HEADERS,
        },
      });
    }

    // Smart highlight caption: /[scope]/api/caption/:matchId/:eventIdx
    // Public read, but ?force=1 (regenerate) requires admin auth.
    const captionMatch = routePath.match(/^\/api\/caption\/([^/]+)\/(\d+)\/?$/);
    if (captionMatch) {
      const matchId = decodeURIComponent(captionMatch[1]);
      const eventIdx = parseInt(captionMatch[2], 10);
      const force = url.searchParams.get('force') === '1';
      if (force) {
        const expected =
          scope === '3s' ? env.ADMIN_KEY_3S
          : scope === '4s' ? env.ADMIN_KEY_4S
          : env.ADMIN_KEY;
        if (!expected || url.searchParams.get('key') !== expected) {
          return new Response('Unauthorized', { status: 401 });
        }
      }
      const result = await getCaption(env, matchId, eventIdx, force);
      return new Response(JSON.stringify(result), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...CORS_HEADERS,
        },
      });
    }

    // AI match report HTML page: /[scope]/report[/:matchId]
    if (routePath === '/report' || routePath === '/report/') {
      const active = (await getActiveMatchId(env, scope)) ?? 'test';
      return htmlResponse(await renderReportPage(env, scope, active, url.origin));
    }
    const reportPageMatch = routePath.match(/^\/report\/([^/]+)\/?$/);
    if (reportPageMatch) {
      const matchId = decodeURIComponent(reportPageMatch[1]);
      return htmlResponse(await renderReportPage(env, scope, matchId, url.origin));
    }

    // Per-over auto-commentary: /[scope]/api/commentary/:matchId/:overKey
    const commentaryMatch = routePath.match(/^\/api\/commentary\/([^/]+)\/([^/]+)\/?$/);
    if (commentaryMatch) {
      const matchId = decodeURIComponent(commentaryMatch[1]);
      const overKey = decodeURIComponent(commentaryMatch[2]);
      const force = url.searchParams.get('force') === '1';
      const result = await getCommentaryForOver(env, scope, matchId, overKey, force);
      return new Response(JSON.stringify(result), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...CORS_HEADERS,
        },
      });
    }

    // Vibe (emoji reaction) POST: /[scope]/api/vibe/:matchId/:innings/:over/:ball
    const vibePostMatch = routePath.match(/^\/api\/vibe\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\/?$/);
    if (vibePostMatch && request.method === 'POST') {
      const matchId = decodeURIComponent(vibePostMatch[1]);
      const innings = parseInt(vibePostMatch[2], 10);
      const over = parseInt(vibePostMatch[3], 10);
      const ball = parseInt(vibePostMatch[4], 10);
      const ip = request.headers.get('cf-connecting-ip') || '';
      if (!(await checkRateLimit(env, ip))) {
        return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), {
          status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '5' },
        });
      }
      const voter = await resolveVoter(request, env, scope);
      let body: any;
      try { body = await request.json(); } catch { body = {}; }
      const emoji = String(body?.emoji || '');
      if (!(VIBES as readonly string[]).includes(emoji)) {
        return new Response(JSON.stringify({ ok: false, error: 'bad_emoji', allowed: VIBES }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      const total = await bumpVibe(env, matchId, innings, over, ball, emoji as Vibe);
      const res = new Response(JSON.stringify({ ok: true, emoji, total, voter: voter.voterId }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      for (const cookie of voter.setCookieHeaders) res.headers.append('Set-Cookie', cookie);
      return res;
    }

    // Vibes read: /[scope]/api/vibes/:matchId
    const vibesGetMatch = routePath.match(/^\/api\/vibes\/([^/]+)\/?$/);
    if (vibesGetMatch) {
      const matchId = decodeURIComponent(vibesGetMatch[1]);
      const map = await readAllVibes(env, matchId);
      return new Response(JSON.stringify({ vibes: map, allowed: VIBES }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS_HEADERS },
      });
    }

    // Reel: /[scope]/reel[/:matchId]
    if (routePath === '/reel' || routePath === '/reel/') {
      const active = (await getActiveMatchId(env, scope)) ?? 'test';
      return htmlResponse(await renderReel(env, active, scope));
    }
    const reelMatch = routePath.match(/^\/reel\/([^/]+)\/?$/);
    if (reelMatch) {
      const matchId = decodeURIComponent(reelMatch[1]);
      return htmlResponse(await renderReel(env, matchId, scope));
    }

    // Club registry admin page — global (not per-scope). Lives outside
    // handleAdmin because it isn't scoped: there's a single club registry
    // shared across every scope. Auth uses the default `ADMIN_KEY` via the
    // existing `?key=…` gate, mirroring `/admin/archive` and friends.
    if (url.pathname === '/admin/clubs' || url.pathname === '/admin/clubs/') {
      if (!isAdmin(env, url, '')) {
        return new Response('Unauthorized', { status: 401 });
      }
      await ensureSeeded(env);
      const clubs = await listClubs(env);
      const key = env.ADMIN_KEY ?? '';
      return htmlResponse(renderClubsAdmin(clubs, key));
    }

    if (routePath === '/admin' || routePath.startsWith('/admin/')) {
      // Reconstruct the URL with the scoped pathname so handleAdmin parses
      // POST action segments correctly relative to /admin/<action>.
      const scopedUrl = new URL(url.toString());
      scopedUrl.pathname = routePath;
      return handleAdmin(request, env, scopedUrl, scope);
    }

    const overlayMatch = routePath.match(/^\/overlay\/([^/]+)\/?$/);
    if (overlayMatch) {
      const matchId = decodeURIComponent(overlayMatch[1]);
      const branding = await readBranding(env, scope);
      return htmlResponse(renderOverlay(matchId, branding, scope));
    }

    if (url.pathname === '/' || url.pathname === '') {
      return new Response(await renderIndexPage(env), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// ---------- Club registry admin page --------------------------------------

function escapeHtmlClubs(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * Admin UI for the club registry. Mirrors the dark-theme visual language of
 * `/admin/archive` and the main admin page (same CSS variables, same panel
 * shape, same accent button). Deliberately not styled as a full-blown CRUD
 * surface — step 4 will redo this once we know which fields actually drive
 * the scrape pipeline.
 */
function renderClubsAdmin(clubs: Club[], key: string): string {
  const scraperOptions = Object.keys(SCRAPERS)
    .map((id) => `<option value="${escapeHtmlClubs(id)}">${escapeHtmlClubs(id)}</option>`)
    .join('');
  const discoveryOptions = Object.keys(DISCOVERIES)
    .map((id) => `<option value="${escapeHtmlClubs(id)}">${escapeHtmlClubs(id)}</option>`)
    .join('');

  const rows = clubs
    .map((c) => {
      const created = new Date(c.createdAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      const isDefault = c.slug === 'default';
      const deleteCell = isDefault
        ? `<span class="muted">—</span>`
        : `<form method="POST" action="/api/admin/clubs/${encodeURIComponent(c.slug)}/delete?key=${encodeURIComponent(key)}" onsubmit="return confirm('Delete club ${escapeHtmlClubs(c.slug)}? This is not reversible.')" style="margin:0">
             <button type="submit" class="danger">Delete</button>
           </form>`;
      return `<tr>
        <td><code>${escapeHtmlClubs(c.slug)}</code></td>
        <td>${escapeHtmlClubs(c.name)}</td>
        <td class="muted">${escapeHtmlClubs(c.scraperId)}</td>
        <td class="muted">${escapeHtmlClubs(c.discoveryId)}</td>
        <td class="muted">${escapeHtmlClubs(created)}</td>
        <td>${deleteCell}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Club registry · admin</title>
<style>
  :root { --bg:#0e1116; --panel:#161a22; --border:#232a35; --accent:#ffd23a; --text:#e8eaed; --muted:#8a93a4; --err:#ff5d5d; }
  body { margin:0; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 20px 32px; border-bottom: 1px solid var(--border); display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
  header h1 { margin:0; font-size: 16px; letter-spacing: 0.05em; text-transform: uppercase; }
  header .scope { color: var(--accent); font-weight: 800; letter-spacing: 0.18em; }
  header nav { margin-left:auto; display:flex; gap:8px; }
  header nav a { color: var(--muted); text-decoration:none; padding: 6px 12px; border:1px solid var(--border); border-radius:4px; font-size:12px; letter-spacing: 0.1em; text-transform: uppercase; }
  header nav a:hover { color: var(--accent); border-color: var(--accent); }
  main { max-width: 1100px; margin: 24px auto; padding: 0 32px; display: grid; grid-template-columns: 1fr; gap: 24px; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
  section h2 { margin: 0 0 12px; font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
  .meta { color: var(--muted); font-size: 12px; }
  .meta code { color: var(--text); background:#0a0d12; padding: 2px 6px; border-radius: 3px; }
  table { width:100%; border-collapse: collapse; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; font-variant-numeric: tabular-nums; }
  th { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  tr:hover td { background: rgba(255, 210, 58, 0.04); }
  td.muted { color: var(--muted); }
  td code { background: #0a0d12; padding: 2px 6px; border-radius: 3px; }
  label { display: block; font-size: 12px; color: var(--muted); margin-top: 12px; }
  input[type=text], select {
    width: 100%; box-sizing: border-box;
    padding: 9px 12px; margin-top: 6px;
    background: #0a0d12; color: var(--text);
    border: 1px solid var(--border); border-radius: 4px;
    font: 13px/1.4 ui-monospace, Menlo, Consolas, monospace;
  }
  button {
    margin-top: 14px;
    padding: 9px 18px;
    background: var(--accent); color: #0a0d12;
    border: none; border-radius: 4px;
    font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    cursor: pointer;
    font-size: 12px;
  }
  button:hover { background: #ffe066; }
  button.danger {
    background: transparent; color: var(--err);
    border: 1px solid var(--border);
    padding: 5px 10px;
    margin: 0;
    font-size: 11px;
  }
  button.danger:hover { border-color: var(--err); background: rgba(255,93,93,0.08); }
  .form-grid { display:grid; grid-template-columns: 1fr 1fr; gap: 14px 20px; }
  .form-grid .full { grid-column: 1 / -1; }
</style>
</head>
<body>
<header>
  <h1>Club registry · <span class="scope">ADMIN</span></h1>
  <span class="meta">${clubs.length} club${clubs.length === 1 ? '' : 's'} registered</span>
  <nav>
    <a href="/admin?key=${encodeURIComponent(key)}">← Back to admin</a>
  </nav>
</header>
<main>
  <section>
    <h2>Registered clubs</h2>
    <p class="meta">Tier-6 step 3: pure registry + admin UI. Step 4 will wire <code>scraperId</code> / <code>discoveryId</code> into the scrape pipeline. For now the registry is read-by-admin-only and has no effect on the live scrape.</p>
    <table style="margin-top:12px">
      <thead><tr>
        <th>Slug</th><th>Name</th><th>Scraper</th><th>Discovery</th><th>Created</th><th></th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted" style="text-align:center; padding:20px">No clubs registered. The default seed should appear automatically — refresh.</td></tr>'}</tbody>
    </table>
    <p class="meta" style="margin-top:14px"><code>default</code> is the permanent seed entry and cannot be deleted — edit it instead.</p>
  </section>

  <section>
    <h2>Add club</h2>
    <p class="meta">Slug must match <code>^[a-z0-9][a-z0-9-]{0,30}$</code> — lowercase letters/digits/hyphens, must start with a letter or digit. The slug becomes the URL path component in step 4, so keep it tight.</p>
    <form method="POST" action="/api/admin/clubs?key=${encodeURIComponent(key)}">
      <div class="form-grid">
        <div>
          <label>Slug</label>
          <input type="text" name="slug" placeholder="e.g. thoddleston" required pattern="[a-z0-9][a-z0-9-]{0,30}" />
        </div>
        <div>
          <label>Name</label>
          <input type="text" name="name" placeholder="e.g. Thoddleston Cricket Club" required />
        </div>
        <div>
          <label>Scraper</label>
          <select name="scraperId" required>
            <option value="">— pick one —</option>
            ${scraperOptions}
          </select>
        </div>
        <div>
          <label>Discovery</label>
          <select name="discoveryId" required>
            <option value="">— pick one —</option>
            ${discoveryOptions}
          </select>
        </div>
        <div class="full">
          <button type="submit">Add club</button>
        </div>
      </div>
    </form>
  </section>
</main>
</body>
</html>`;
}

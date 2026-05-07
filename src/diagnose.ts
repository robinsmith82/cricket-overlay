// Match-level diagnostic page.
//
// One-stop "is this match alive?" view for the admin. Shows the cached
// Score, the persisted last_good fallback, and the last N scrape_log
// rows from D1 — annotated so the common failure modes (stuck cache,
// upstream lag, RV fallback, totals-only scoring) are visible at a glance
// without curling JSON.

import type { Env, Score } from './types';

const SCOPE_LABELS: Record<string, string> = {
  '3s': '3rd XI',
  '4s': '4th XI',
};

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

function safeJson<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

function relMs(ms: number): string {
  const dt = Date.now() - ms;
  const s = Math.floor(dt / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export async function renderDiagnose(env: Env, matchId: string, scope: string): Promise<string> {
  const safeId = matchId.replace(/[^a-zA-Z0-9_-]/g, '');
  const scopeLabel = SCOPE_LABELS[scope] ?? 'Default';
  const adminPath = scope ? `/${scope}/admin` : '/admin';

  // Read: cached score, last-good fallback, RV mapping, scrape log rows.
  const [cachedRaw, lastGoodRaw, rvmapRaw, logRes] = await Promise.all([
    env.CRICKET_CACHE.get(`score:${matchId}`),
    env.CRICKET_CACHE.get(`score:${matchId}:last_good`),
    env.CRICKET_CACHE.get(`rvmap:${matchId}`),
    env.LOG_DB
      .prepare('SELECT ts, match_id, source, ok, status, runs, wickets, overs, batting_team, changed, error FROM scrape_log WHERE match_id = ?1 ORDER BY id DESC LIMIT 20')
      .bind(matchId)
      .all<LogRow>()
      .catch(() => ({ results: [] as LogRow[] })),
  ]);

  const cached = safeJson<Score>(cachedRaw);
  const lastGood = safeJson<Score>(lastGoodRaw);
  const rows: LogRow[] = logRes?.results ?? [];

  // ---- Diagnostic checks ------------------------------------------------
  const checks: Array<{ ok: boolean; warn?: boolean; label: string; detail: string }> = [];

  const score = cached ?? lastGood;
  if (score) {
    const ageMs = Date.now() - new Date(score.fetchedAt).getTime();
    checks.push({
      ok: ageMs < 60_000,
      warn: ageMs >= 60_000 && ageMs < 5 * 60_000,
      label: 'Score freshness',
      detail: `${relMs(new Date(score.fetchedAt).getTime())} (${Math.round(ageMs / 1000)}s)`,
    });
    checks.push({
      ok: !score.error,
      label: 'Latest scrape result',
      detail: score.error ? `error: ${score.error}` : `OK — ${score.runs}/${score.wickets} (${score.overs})`,
    });
    checks.push({
      ok: !score.stale,
      warn: !!score.stale,
      label: 'Serving from last_good?',
      detail: score.stale ? 'YES — live scrape failing, falling back to last successful' : 'No — live scrape succeeding',
    });
    checks.push({
      ok: score.source === 'play-cricket',
      warn: score.source === 'resultsvault',
      label: 'Data source',
      detail: score.source === 'play-cricket'
        ? 'Play-Cricket Site API (official, low-latency)'
        : score.source === 'resultsvault'
          ? 'ResultsVault (fallback — significant lag, fragile, no PLAY_CRICKET_API_TOKEN set)'
          : `unknown (${score.source ?? 'none'})`,
    });
    const hasRecentBalls = !!(score.recentBalls && score.recentBalls.length);
    checks.push({
      ok: hasRecentBalls,
      warn: !hasRecentBalls,
      label: 'Ball-by-ball data',
      detail: hasRecentBalls
        ? `${score.recentBalls!.length} recent balls — full overlay will populate`
        : 'No recentBalls — league/scorer is entering totals only, not ball-by-ball. Overlay will only show team scoreline.',
    });
    const hasBatters = !!(score.batters && score.batters.length);
    checks.push({
      ok: hasBatters,
      warn: !hasBatters,
      label: 'Current pair',
      detail: hasBatters
        ? score.batters!.map((b) => `${b.name} ${b.runs}(${b.balls})`).join(', ')
        : 'No batters returned — same root cause as ball-by-ball missing',
    });
  } else {
    checks.push({ ok: false, label: 'Score', detail: 'No cached score and no last_good — first scrape never succeeded' });
  }

  const recentRows = rows.slice(0, 5);
  const recentRate = recentRows.length >= 2
    ? Math.round((recentRows[0].ts - recentRows[recentRows.length - 1].ts) / (recentRows.length - 1) / 1000)
    : null;
  checks.push({
    ok: !!rows.length && (Date.now() - rows[0].ts) < 5 * 60_000,
    warn: !!rows.length && (Date.now() - rows[0].ts) >= 5 * 60_000,
    label: 'Scrape heartbeat',
    detail: rows.length
      ? `Last scrape ${relMs(rows[0].ts)}${recentRate ? ` · ~${recentRate}s between scrapes` : ''} · ${rows.length} rows on file`
      : 'No scrape rows in D1 for this match — has the overlay been polled at all?',
  });

  // ---- Verdict ---------------------------------------------------------
  let verdict: 'healthy' | 'degraded' | 'broken' = 'healthy';
  if (checks.some((c) => !c.ok && !c.warn)) verdict = 'broken';
  else if (checks.some((c) => c.warn)) verdict = 'degraded';
  const verdictColor = verdict === 'healthy' ? '#3ddc84' : verdict === 'degraded' ? '#ffd23a' : '#ff4d6d';
  const verdictText = verdict === 'healthy' ? 'HEALTHY' : verdict === 'degraded' ? 'DEGRADED' : 'BROKEN';

  // ---- Render ---------------------------------------------------------
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#0e1116" />
<meta http-equiv="refresh" content="15" />
<title>Diagnose · ${escapeHtml(safeId)}</title>
<style>
  :root { --bg:#0e1116; --panel:#161a22; --border:#232a35; --accent:#ffd23a; --text:#e8eaed; --muted:#8a93a4; --good:#3ddc84; --bad:#ff4d6d; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  header { padding: 18px 28px; border-bottom: 1px solid var(--border); display:flex; align-items:center; gap: 18px; flex-wrap: wrap; }
  header h1 { margin:0; font-size: 16px; letter-spacing: 0.06em; text-transform: uppercase; }
  header .scope { color: var(--accent); font-weight: 800; letter-spacing: 0.18em; font-size: 11px; }
  header .verdict { padding: 5px 12px; border-radius: 4px; font-weight: 800; letter-spacing: 0.16em; font-size: 11px; }
  header nav { margin-left: auto; display: flex; gap: 8px; }
  header nav a { color: var(--muted); text-decoration: none; padding: 6px 12px; border: 1px solid var(--border); border-radius: 4px; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }
  header nav a:hover { color: var(--accent); border-color: var(--accent); }
  main { max-width: 1100px; margin: 24px auto; padding: 0 28px 60px; display: grid; gap: 18px; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 18px 20px; }
  section h2 { margin: 0 0 14px; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); font-weight: 800; }
  .checks { display: grid; gap: 10px; }
  .check { display: grid; grid-template-columns: 24px 200px 1fr; gap: 12px; align-items: baseline; padding: 8px 0; border-bottom: 1px dashed var(--border); }
  .check:last-child { border-bottom: none; }
  .check .icon { font-size: 14px; }
  .check.ok .icon { color: var(--good); }
  .check.warn .icon { color: var(--accent); }
  .check.bad .icon { color: var(--bad); }
  .check .label { font-weight: 700; color: var(--text); }
  .check .detail { color: var(--muted); }
  .raw { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .raw pre { margin: 0; padding: 12px; background: #0a0d12; border: 1px solid var(--border); border-radius: 4px; overflow-x: auto; font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace; color: var(--text); }
  .raw h3 { margin: 0 0 8px; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font: 12px/1.4 ui-monospace, Menlo, Consolas, monospace; }
  th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; font-size: 10px; }
  tr.changed td { background: rgba(255, 210, 58, 0.04); }
  tr.errored td { background: rgba(255, 77, 109, 0.06); color: var(--bad); }
  td.ts { color: var(--muted); white-space: nowrap; }
  td.score { font-weight: 700; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 800; }
  .pill.pc { background: rgba(61,220,132,0.14); color: var(--good); }
  .pill.rv { background: rgba(255,210,58,0.14); color: var(--accent); }
  .pill.unknown { background: rgba(138,147,164,0.14); color: var(--muted); }
  @media (max-width: 720px) { .raw { grid-template-columns: 1fr; } .check { grid-template-columns: 24px 1fr; } .check .label { grid-column: 2; } .check .detail { grid-column: 2; } }
</style>
</head>
<body>
<header>
  <span class="scope">${escapeHtml(scopeLabel)}</span>
  <h1>Diagnose · <code>${escapeHtml(safeId)}</code></h1>
  <span class="verdict" style="background:${verdictColor}1a;color:${verdictColor}">● ${verdictText}</span>
  <nav>
    <a href="${adminPath}">← admin</a>
    <a href="${adminPath}/logs">all scrape logs</a>
  </nav>
</header>
<main>

  <section>
    <h2>Health checks</h2>
    <div class="checks">
      ${checks.map((c) => {
        const cls = c.warn ? 'warn' : (c.ok ? 'ok' : 'bad');
        const icon = c.warn ? '⚠' : (c.ok ? '✓' : '✗');
        return `<div class="check ${cls}"><span class="icon">${icon}</span><span class="label">${escapeHtml(c.label)}</span><span class="detail">${escapeHtml(c.detail)}</span></div>`;
      }).join('')}
    </div>
  </section>

  <section>
    <h2>Cached state</h2>
    <div class="raw">
      <div>
        <h3>score:${escapeHtml(safeId)}</h3>
        <pre>${cached ? escapeHtml(JSON.stringify(cached, null, 2)) : 'null'}</pre>
      </div>
      <div>
        <h3>score:${escapeHtml(safeId)}:last_good</h3>
        <pre>${lastGood ? escapeHtml(JSON.stringify(lastGood, null, 2)) : 'null'}</pre>
      </div>
    </div>
    ${rvmapRaw ? `<p style="margin-top:10px;color:var(--muted);font-size:12px">RV mapping: <code>${escapeHtml(rvmapRaw)}</code></p>` : ''}
  </section>

  <section>
    <h2>Last 20 scrape rows</h2>
    ${rows.length ? `
      <table>
        <thead><tr><th>When</th><th>Source</th><th>OK</th><th>Status</th><th>Score</th><th>Δ</th><th>Error</th></tr></thead>
        <tbody>
          ${rows.map((r) => {
            const cls = r.ok ? (r.changed ? 'changed' : '') : 'errored';
            const sourcePill = r.source === 'play-cricket' ? 'pc' : (r.source === 'resultsvault' ? 'rv' : 'unknown');
            return `<tr class="${cls}">
              <td class="ts">${escapeHtml(relMs(r.ts))}</td>
              <td><span class="pill ${sourcePill}">${escapeHtml(r.source || '?')}</span></td>
              <td>${r.ok ? '✓' : '✗'}</td>
              <td>${escapeHtml(r.status ?? '')}</td>
              <td class="score">${r.runs ?? '—'}/${r.wickets ?? '—'} (${escapeHtml(r.overs ?? '—')})</td>
              <td>${r.changed ? '●' : '·'}</td>
              <td>${escapeHtml(r.error ?? '')}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    ` : '<p style="color:var(--muted)">No rows in scrape_log for this match yet.</p>'}
  </section>

  <p style="color:var(--muted);text-align:center;font-size:11px;letter-spacing:0.1em">Auto-refreshes every 15s</p>

</main>
</body>
</html>`;
}

function escapeHtml(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

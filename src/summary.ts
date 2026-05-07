import type { Env, Score } from './types';
import { readEvents } from './events';
import { readAllBallTags, readYouTube, ZONE_LABELS, type BallTag } from './archive';
import { getMatchReport } from './report';

const SCOPE_LABELS: Record<string, string> = {
  '3s': '3rd XI',
  '4s': '4th XI',
};

export async function renderSummary(
  env: Env,
  matchId: string,
  scope: string,
  scoreFetcher: (id: string) => Promise<Score>,
  origin: string,
): Promise<string> {
  const safeId = matchId.replace(/[^a-zA-Z0-9_-]/g, '');
  const [score, events, tags, youtube, report] = await Promise.all([
    scoreFetcher(matchId),
    readEvents(env, matchId),
    readAllBallTags(env, matchId),
    readYouTube(env, scope),
    // AI match report — embedded inline. We never want a flaky model call
    // (or a missing AI binding in dev) to break /summary, so swallow any
    // error and fall through to "no report" rendering.
    getMatchReport(env, scope, matchId).catch(() => null),
  ]);
  const scopeLabel = SCOPE_LABELS[scope] ?? '';

  // Aggregate top performers from events.
  const fours: Record<string, number> = {};
  const sixes: Record<string, number> = {};
  const wicketsByBowler: Record<string, number> = {};
  let firstFifty: { batter: string; over: string } | null = null;
  let firstHundred: { batter: string; over: string } | null = null;
  for (const e of events) {
    if (e.type === '4' && e.batter) fours[e.batter] = (fours[e.batter] ?? 0) + 1;
    if (e.type === '6' && e.batter) sixes[e.batter] = (sixes[e.batter] ?? 0) + 1;
    if (e.type === 'wicket' && e.bowler) wicketsByBowler[e.bowler] = (wicketsByBowler[e.bowler] ?? 0) + 1;
    if (e.type === 'fifty' && !firstFifty && e.batter) firstFifty = { batter: e.batter, over: e.over };
    if (e.type === 'hundred' && !firstHundred && e.batter) firstHundred = { batter: e.batter, over: e.over };
  }
  const topFours = topN(fours, 3);
  const topSixes = topN(sixes, 3);
  const topWickets = topN(wicketsByBowler, 3);

  // Wagon wheel SVG from tag distribution.
  const zoneCounts = countZones(tags);
  const wheelSvg = renderWagonWheelSvg(zoneCounts, 240);

  const ogTitle = `${score.battingTeam || 'Match'} ${score.runs}/${score.wickets} (${score.overs})`;
  const ogDesc = score.target ? `Target ${score.target}` : (score.bowlingTeam || '');
  const shareUrl = `${origin}${scope ? '/' + scope : ''}/summary/${encodeURIComponent(safeId)}`;
  const highlightsUrl = `${scope ? '/' + scope : ''}/highlights/${encodeURIComponent(safeId)}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0e1116" />
<title>${escapeHtml(ogTitle)}</title>
<meta property="og:type" content="website" />
<meta property="og:title" content="${escapeHtml(ogTitle)}" />
<meta property="og:description" content="${escapeHtml(ogDesc)}" />
<meta property="og:url" content="${escapeHtml(shareUrl)}" />
<meta name="twitter:card" content="summary_large_image" />
<style>
  :root { --bg:#0e1116; --panel:#161a22; --border:#232a35; --accent:#ffd23a; --text:#e8eaed; --muted:#8a93a4; --good:#3ddc84; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background:var(--bg); color:var(--text); }
  body { font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
  main { max-width: 540px; margin: 0 auto; padding: 0 14px 24px; }
  .hero {
    background: linear-gradient(180deg, #1a1f2b 0%, #0e1116 100%);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 22px 22px 18px;
    margin: 16px 0;
    text-align: center;
  }
  .hero .scope { font-size:11px; letter-spacing:0.18em; text-transform:uppercase; color:var(--accent); font-weight:800; }
  .hero h1 { margin: 8px 0 4px; font-size: 18px; }
  .hero .subtitle { color: var(--muted); font-size: 13px; }
  .hero .score { margin-top: 14px; font-size: 44px; font-weight: 800; letter-spacing: -0.02em; line-height: 1; }
  .hero .score .wkts { color: var(--muted); font-weight: 700; font-size: 26px; }
  .hero .overs { color: var(--muted); margin-top: 4px; font-size: 13px; font-variant-numeric: tabular-nums; }
  .hero .target { margin-top: 10px; color: var(--accent); font-weight: 700; font-size: 13px; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 12px; }
  section h2 { margin: 0 0 10px; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
  .perf-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; padding: 6px 0; border-bottom: 1px dashed var(--border); }
  .perf-row:last-child { border-bottom: none; }
  .perf-row .name { font-weight: 700; }
  .perf-row .count { font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 800; }
  .player-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; padding: 8px 0; border-bottom: 1px dashed var(--border); align-items: baseline; }
  .player-row:last-child { border-bottom: none; }
  .player-row .name { font-weight: 700; }
  .player-row .name.striker::after { content: ' *'; color: var(--accent); }
  .player-row .figs { font-variant-numeric: tabular-nums; font-weight: 800; }
  .player-row .figs .balls { color: var(--muted); font-weight: 600; font-size: 13px; }
  .player-row.bowler { margin-top: 4px; padding-top: 12px; border-top: 1px solid var(--border); }
  .player-row.bowler .name { color: var(--muted); font-weight: 600; }
  .partnership { color: var(--muted); font-size: 12px; margin-top: 8px; letter-spacing: 0.04em; }
  .recent-row { display: flex; gap: 6px; align-items: center; margin-top: 12px; flex-wrap: wrap; }
  .recent-row .recent-label { color: var(--muted); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 700; margin-right: 4px; }
  .ball { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 13px; background: #2a3140; color: #e8eaed; font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ball.dot { background: #2a3140; color: #8a93a4; }
  .ball.four { background: #4189ff; color: #fff; }
  .ball.six { background: #ff4d9b; color: #fff; }
  .ball.wkt { background: #ff4d6d; color: #fff; }
  .ball.wide, .ball.nb { background: #444a55; color: #ffd23a; font-size: 10px; }
  .report-prose p { margin: 0 0 10px; line-height: 1.6; font-size: 14px; }
  .report-prose p:last-child { margin-bottom: 0; }
  .report-meta { margin-top: 10px; color: var(--muted); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }
  .report-meta a { color: var(--muted); text-decoration: none; border-bottom: 1px dotted var(--muted); }
  .report-meta a:hover { color: var(--accent); border-color: var(--accent); }
  .wheel-row { display: flex; align-items: center; gap: 14px; }
  .wheel-row svg { flex: 0 0 auto; width: 200px; height: 200px; }
  .wheel-row .legend { font-size: 12px; color: var(--muted); }
  .wheel-row .legend ol { margin: 0; padding-left: 18px; }
  .wheel-row .legend li { padding: 2px 0; }
  .actions { display: grid; gap: 10px; margin-top: 16px; }
  .btn {
    display: block; text-align: center;
    padding: 14px 16px; border-radius: 8px;
    background: var(--accent); color: #0a0d12;
    text-decoration: none; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;
  }
  .btn.secondary { background: var(--panel); color: var(--text); border: 1px solid var(--border); }
  .footer { text-align: center; color: var(--muted); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; margin-top: 18px; }
  @media (max-width: 480px) {
    .wheel-row { flex-direction: column; align-items: stretch; }
    .wheel-row svg { width: 100%; height: auto; max-width: 280px; margin: 0 auto; }
  }
</style>
</head>
<body>
<main>
  <div class="hero">
    <div class="scope">${escapeHtml(scopeLabel || 'Cricket')}</div>
    <h1>${escapeHtml(score.battingTeam || '')} v ${escapeHtml(score.bowlingTeam || '')}</h1>
    <div class="subtitle">${describeStatus(score)}</div>
    <div class="score">${score.runs}<span class="wkts">/${score.wickets}</span></div>
    <div class="overs">${escapeHtml(score.overs || '0.0')}${score.oversTotal ? ' / ' + score.oversTotal + ' overs' : ''}</div>
    ${score.target ? `<div class="target">Target ${score.target}</div>` : ''}
  </div>

  ${(score.batters && score.batters.length) || score.bowler || (score.recentBalls && score.recentBalls.length) ? `
  <section>
    <h2>${score.status === 'finished' ? 'Final state' : 'At the crease'}</h2>
    ${(score.batters ?? []).map((b) => `
      <div class="player-row">
        <span class="name${b.onStrike ? ' striker' : ''}">${escapeHtml(b.name || '')}</span>
        <span class="figs">${b.runs|0}<span class="balls"> (${b.balls|0})</span></span>
      </div>
    `).join('')}
    ${score.bowler ? `
      <div class="player-row bowler">
        <span class="name">${escapeHtml(score.bowler.name || '')}</span>
        <span class="figs">${score.bowler.wickets|0}/${score.bowler.runs|0}<span class="balls"> (${escapeHtml(score.bowler.overs || '0.0')})</span></span>
      </div>
    ` : ''}
    ${score.partnership ? `<div class="partnership">P'ship ${score.partnership.runs} (${score.partnership.balls})</div>` : ''}
    ${(score.recentBalls && score.recentBalls.length) ? `
      <div class="recent-row">
        <span class="recent-label">${score.status === 'finished' ? 'Last over' : 'This over'}</span>
        ${score.recentBalls.map((b) => {
          let cls = '';
          let label = String(b.runs|0);
          if (b.isWicket) { cls = 'wkt'; label = 'W'; }
          else if (b.isSix) { cls = 'six'; label = '6'; }
          else if (b.isFour) { cls = 'four'; label = '4'; }
          else if (b.isWide) { cls = 'wide'; label = 'wd'; }
          else if (b.isNoBall) { cls = 'nb'; label = 'nb'; }
          else if ((b.runs|0) === 0) { cls = 'dot'; }
          return `<span class="ball ${cls}">${escapeHtml(label)}</span>`;
        }).join('')}
      </div>
    ` : ''}
  </section>
  ` : ''}

  ${(topFours.length || topSixes.length || topWickets.length || firstFifty || firstHundred) ? `
  <section>
    <h2>Top performers</h2>
    ${firstHundred ? `<div class="perf-row"><span class="name">💯 ${escapeHtml(firstHundred.batter)}</span><span class="count">100 (${escapeHtml(firstHundred.over)})</span></div>` : ''}
    ${firstFifty ? `<div class="perf-row"><span class="name">⭐ ${escapeHtml(firstFifty.batter)}</span><span class="count">50 (${escapeHtml(firstFifty.over)})</span></div>` : ''}
    ${topSixes.map(([n, c]) => `<div class="perf-row"><span class="name">🚀 ${escapeHtml(n)}</span><span class="count">${c} six${c===1?'':'es'}</span></div>`).join('')}
    ${topFours.map(([n, c]) => `<div class="perf-row"><span class="name">🏏 ${escapeHtml(n)}</span><span class="count">${c} four${c===1?'':'s'}</span></div>`).join('')}
    ${topWickets.map(([n, c]) => `<div class="perf-row"><span class="name">🎯 ${escapeHtml(n)}</span><span class="count">${c} wicket${c===1?'':'s'}</span></div>`).join('')}
  </section>
  ` : ''}

  ${(report && !report.empty && report.text) ? `
  <section>
    <h2>Match report</h2>
    <div class="report-prose">
      ${report.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
    </div>
    <div class="report-meta">Generated by Llama 3.1 · <a href="${scope ? '/' + scope : ''}/report/${encodeURIComponent(safeId)}">Open standalone</a></div>
  </section>
  ` : ''}

  ${tags.length ? `
  <section>
    <h2>Wagon wheel · ${tags.length} tagged ball${tags.length === 1 ? '' : 's'}</h2>
    <div class="wheel-row">
      ${wheelSvg}
      <div class="legend">
        <ol>
          ${zoneCounts.slice(1).map((c, i) => c > 0 ? `<li><strong>${escapeHtml(ZONE_LABELS[i+1])}</strong> · ${c}</li>` : '').filter(Boolean).join('')}
          ${zoneCounts[0] > 0 ? `<li><strong>${escapeHtml(ZONE_LABELS[0])}</strong> · ${zoneCounts[0]}</li>` : ''}
        </ol>
      </div>
    </div>
  </section>
  ` : ''}

  <div class="actions">
    <a class="btn" href="${highlightsUrl}">View highlights (${events.length})</a>
    ${youtube ? `<a class="btn secondary" href="${escapeHtml(youtube.url)}" target="_blank" rel="noopener">Open full stream on YouTube</a>` : ''}
  </div>

  <div class="footer">cricket-overlay</div>
</main>
</body>
</html>`;
}

function describeStatus(score: Score): string {
  if (score.status === 'finished') return 'Match finished';
  if (score.status === 'live') return `Live · innings ${score.innings}`;
  if (score.status === 'break') return 'Innings break';
  return score.status || '';
}

function topN(map: Record<string, number>, n: number): Array<[string, number]> {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function countZones(tags: Array<{ tag: BallTag }>): number[] {
  const counts = new Array(9).fill(0);
  for (const t of tags) counts[t.tag.zone] = (counts[t.tag.zone] ?? 0) + 1;
  return counts;
}

/** Render an SVG wagon wheel with zone intensities scaled to counts. */
export function renderWagonWheelSvg(zoneCounts: number[], size = 240): string {
  const cx = size / 2, cy = size / 2, r = size / 2 - 6, inner = size / 8;
  const max = Math.max(1, ...zoneCounts.slice(1));
  const startDeg = -22.5;
  let paths = '';
  for (let i = 0; i < 8; i++) {
    const a0 = (startDeg + i * 45) * Math.PI / 180;
    const a1 = (startDeg + (i + 1) * 45) * Math.PI / 180;
    const x0 = cx + r * Math.sin(a0), y0 = cy - r * Math.cos(a0);
    const x1 = cx + r * Math.sin(a1), y1 = cy - r * Math.cos(a1);
    const count = zoneCounts[i + 1] ?? 0;
    const intensity = count / max;
    const opacity = 0.18 + intensity * 0.72;
    paths += `<path d="M${cx} ${cy} L${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z" fill="#ffd23a" fill-opacity="${opacity.toFixed(2)}" stroke="#0e1116" stroke-width="1.5"/>`;
  }
  // Center dot zone — opacity from dot count.
  const dotCount = zoneCounts[0] ?? 0;
  const dotMax = Math.max(1, ...zoneCounts);
  const dotOpacity = 0.18 + (dotCount / dotMax) * 0.72;
  paths += `<circle cx="${cx}" cy="${cy}" r="${inner}" fill="#8a93a4" fill-opacity="${dotOpacity.toFixed(2)}" stroke="#0e1116" stroke-width="1.5"/>`;
  paths += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="${(inner * 0.55).toFixed(0)}" fill="#fff" font-weight="800">${dotCount || ''}</text>`;
  paths += `<text x="${cx}" y="14" text-anchor="middle" font-size="10" fill="#ffd23a" font-weight="700" letter-spacing="2">↑ BOWLER</text>`;
  return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

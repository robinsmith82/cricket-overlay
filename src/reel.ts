// Auto-ranked highlight reel.
//
// Pulls the persisted MatchEvent list and ranks each entry by a simple
// weight: wickets and milestones first, then sixes, then fours, plus a
// crowd-reaction bonus from the vibe counters. Top 12 cards link to
// `/embed/clip/:matchId/:idx` so the user gets a YouTube player cued to
// the moment, not just a deep link.

import type { Env } from './types';
import { readEvents, type MatchEvent } from './events';
import { readAllVibes, totalVibesOnBall, type VibeMap } from './vibes';
import { readAllBallTags } from './archive';

const SCOPE_LABELS: Record<string, string> = {
  '3s': '3rd XI',
  '4s': '4th XI',
};

const TYPE_BASE_WEIGHT: Record<MatchEvent['type'], number> = {
  hundred: 10,
  wicket: 6,
  fifty: 5,
  '6': 4,
  '4': 2,
  moment: 3,
  'team-milestone': 1,
};

const TYPE_LABEL: Record<MatchEvent['type'], string> = {
  wicket: 'WICKET',
  '4': 'FOUR',
  '6': 'SIX',
  fifty: 'FIFTY',
  hundred: 'HUNDRED',
  'team-milestone': 'MILESTONE',
  moment: 'MOMENT',
};

const TYPE_COLOR: Record<MatchEvent['type'], string> = {
  wicket: '#ff4d6d',
  '4': '#4189ff',
  '6': '#ff4d9b',
  fifty: '#ffd23a',
  hundred: '#ffd23a',
  'team-milestone': '#3ddc84',
  moment: '#c9b46c',
};

type RankedEvent = {
  idx: number;
  evt: MatchEvent;
  weight: number;
  vibes: number;
  ballKey: string | null;
};

function parseOver(over: string): { o: number; b: number } | null {
  const m = String(over).match(/^(\d+)\.(\d+)$/);
  if (!m) return null;
  return { o: parseInt(m[1], 10), b: parseInt(m[2], 10) };
}

function rankEvents(events: MatchEvent[], vibes: VibeMap, tagCounts: Record<string, number>): RankedEvent[] {
  return events.map((e, idx) => {
    const base = TYPE_BASE_WEIGHT[e.type] ?? 0;
    const ob = parseOver(e.over);
    let ballKey: string | null = null;
    let vibesOnBall = 0;
    let tagsOnBall = 0;
    if (ob) {
      ballKey = `${e.innings}:${ob.o}.${ob.b}`;
      vibesOnBall = totalVibesOnBall(vibes, e.innings, ob.o, ob.b);
      tagsOnBall = tagCounts[ballKey] ?? 0;
    }
    const weight = base + vibesOnBall * 0.5 + tagsOnBall * 0.25;
    return { idx, evt: e, weight, vibes: vibesOnBall, ballKey };
  }).sort((a, b) => b.weight - a.weight);
}

export async function renderReel(env: Env, matchId: string, scope: string): Promise<string> {
  const safeId = matchId.replace(/[^a-zA-Z0-9_-]/g, '');
  const [events, vibes, tags] = await Promise.all([
    readEvents(env, matchId),
    readAllVibes(env, matchId),
    readAllBallTags(env, matchId),
  ]);
  const tagCounts: Record<string, number> = {};
  for (const t of tags) tagCounts[`${t.innings}:${t.over}.${t.ball}`] = (tagCounts[`${t.innings}:${t.over}.${t.ball}`] ?? 0) + 1;

  const ranked = rankEvents(events, vibes, tagCounts).slice(0, 12);
  const scopeLabel = SCOPE_LABELS[scope] ?? '';
  const scopePrefix = scope ? '/' + scope : '';

  const cards = ranked.map((r) => {
    const color = TYPE_COLOR[r.evt.type] ?? '#8a93a4';
    const label = TYPE_LABEL[r.evt.type] ?? r.evt.type.toUpperCase();
    const who = r.evt.batter || (r.evt.type === 'team-milestone' ? `Team passes ${r.evt.runs}` : 'Batter');
    const clipHref = `${scopePrefix}/embed/clip/${encodeURIComponent(safeId)}/${r.idx}`;
    const shareHref = `${scopePrefix}/share/${encodeURIComponent(safeId)}/${r.idx}.svg`;
    return `<a class="card" href="${clipHref}" target="_blank" rel="noopener" style="border-left-color:${color}">
  <div class="badge" style="background:${color}1a;color:${color}">${escapeHtml(label)}</div>
  <div class="who">${escapeHtml(who)}</div>
  <div class="meta">Over ${escapeHtml(r.evt.over)} · innings ${r.evt.innings}${r.vibes ? ' · ' + r.vibes + ' reactions' : ''}</div>
  <div class="footer"><span class="play">▶ Watch</span><a class="share" href="${shareHref}" target="_blank" rel="noopener" onclick="event.stopPropagation()">share card</a></div>
</a>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0e1116" />
<title>Reel · ${escapeHtml(scopeLabel || 'Cricket')}</title>
<style>
  :root { --bg:#0e1116; --panel:#161a22; --border:#232a35; --accent:#ffd23a; --text:#e8eaed; --muted:#8a93a4; }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; background: var(--bg); color: var(--text); }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
  header { padding: 18px 16px; border-bottom: 1px solid var(--border); }
  header h1 { margin:0; font-size: 16px; letter-spacing: 0.1em; text-transform: uppercase; }
  header p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
  main { max-width: 720px; margin: 0 auto; padding: 16px; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
  .card {
    display: block; text-decoration: none; color: inherit;
    background: var(--panel); border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    border-radius: 8px;
    padding: 14px 16px;
    transition: transform .12s ease, border-color .12s ease;
  }
  .card:hover { transform: translateY(-2px); border-color: var(--accent); }
  .card .badge { display: inline-block; padding: 4px 10px; border-radius: 4px; font-weight: 800; font-size: 10px; letter-spacing: 0.1em; }
  .card .who { margin-top: 8px; font-size: 16px; font-weight: 800; }
  .card .meta { margin-top: 4px; color: var(--muted); font-size: 11px; letter-spacing: 0.04em; }
  .card .footer { margin-top: 10px; display: flex; align-items: center; justify-content: space-between; }
  .card .play { color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; }
  .card .share { color: var(--muted); font-size: 11px; text-decoration: none; }
  .card .share:hover { color: var(--accent); }
  .empty { padding: 60px 20px; text-align: center; color: var(--muted); grid-column: 1 / -1; }
  .empty h2 { color: var(--text); font-size: 16px; margin: 0 0 8px; }
</style>
</head>
<body>
<header>
  <h1>Reel${scopeLabel ? ' · ' + escapeHtml(scopeLabel) : ''}</h1>
  <p>Match <code>${escapeHtml(safeId)}</code> · top ${ranked.length} moment${ranked.length === 1 ? '' : 's'} ranked by impact + crowd reactions</p>
</header>
<main>
${cards || '<div class="empty"><h2>No moments yet</h2><p>Wickets, boundaries and milestones will appear here as the match unfolds.</p></div>'}
</main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

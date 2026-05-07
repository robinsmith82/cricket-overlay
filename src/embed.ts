import type { Env } from './types';
import { readEvents } from './events';
import { readYouTube } from './archive';

const SCOPE_LABELS: Record<string, string> = {
  '3s': '3rd XI',
  '4s': '4th XI',
};

/**
 * Tiny score-bar iframe for embedding on club websites.
 * Polls the public score JSON; no auth, no admin chrome.
 *
 * STUB: minimal scorebar that polls /api/score. Style polish & branding TBD.
 */
export function renderEmbedScore(matchId: string, scope: string): string {
  const safeId = matchId.replace(/[^a-zA-Z0-9_-]/g, '');
  const scopeLabel = SCOPE_LABELS[scope] ?? '';
  const isMock = matchId === 'test' || matchId === 'mock';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Score · ${escapeHtml(scopeLabel || 'Cricket')}</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; color: #e8eaed; font: 14px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .bar { background: #161a22; border: 1px solid #232a35; border-radius: 8px; padding: 10px 14px; display: flex; align-items: center; gap: 12px; }
  .bar .scope { font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: #ffd23a; font-weight: 800; }
  .bar .teams { font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar .runs { font-size: 18px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .bar .overs { font-size: 12px; color: #8a93a4; font-variant-numeric: tabular-nums; }
  .bar.stale { opacity: 0.6; }
</style>
</head>
<body>
<div class="bar" id="bar">
  <span class="scope">${escapeHtml(scopeLabel || 'LIVE')}</span>
  <span class="teams" id="teams">—</span>
  <span class="runs" id="runs">—</span>
  <span class="overs" id="overs">—</span>
</div>
<script>
(function(){
  var MATCH_ID = ${JSON.stringify(safeId)};
  var IS_MOCK = ${JSON.stringify(isMock)};
  function tick() {
    var url = '/api/score/' + encodeURIComponent(MATCH_ID) + (IS_MOCK ? '?mock=1' : '');
    fetch(url, { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(s){
      var bar = document.getElementById('bar');
      bar.classList.toggle('stale', !!(s.stale || s.error));
      document.getElementById('teams').textContent = (s.battingTeam || '') + ' v ' + (s.bowlingTeam || '');
      document.getElementById('runs').textContent = (s.runs|0) + '/' + (s.wickets|0);
      document.getElementById('overs').textContent = (s.overs || '0.0') + (s.oversTotal ? ' / ' + s.oversTotal : '');
    }).catch(function(){});
  }
  tick();
  setInterval(tick, 12000);
})();
</script>
</body>
</html>`;
}

/**
 * YouTube clip iframe cued to a specific event ball.
 *
 * STUB: looks up event[idx] in the persisted events list, computes offset from
 * the manual stream-start timestamp, embeds YouTube. If the YouTube URL isn't
 * set or the event index is out of range, renders a friendly fallback.
 */
export async function renderEmbedClip(
  env: Env,
  matchId: string,
  scope: string,
  eventIdx: number,
  smartCaption?: string,
): Promise<string> {
  const [events, youtube] = await Promise.all([readEvents(env, matchId), readYouTube(env, scope)]);
  const evt = Number.isFinite(eventIdx) && eventIdx >= 0 && eventIdx < events.length ? events[eventIdx] : null;

  if (!evt) {
    return embedFallback('Clip not found', `Event ${eventIdx} doesn't exist for this match.`);
  }
  if (!youtube) {
    return embedFallback('No stream link set', 'Add a YouTube URL in admin to enable per-ball clips.');
  }

  const offset = Math.max(0, Math.floor((evt.ts - youtube.startedAt) / 1000));
  const startSec = Math.max(0, offset - 3); // jump in 3s before the moment
  // Bound the iframe so shared clips stop at a sensible point instead of
  // playing into the next over. Source of truth, in priority order:
  //   1. evt.endTs — set explicitly (e.g. by a manual scorer stamp).
  //   2. The next event in the chronological list — its ts becomes our end.
  //   3. A 20-second fallback if neither exists.
  // Then clamp to [start+8, start+60] so a stale 'next' never produces a
  // 20-minute "clip" and a same-second 'next' doesn't blink past the moment.
  const FALLBACK_DURATION_S = 20;
  const MAX_DURATION_S = 60;
  const MIN_DURATION_S = 8;
  let endSec: number | null = null;
  if (evt.endTs && evt.endTs > evt.ts) {
    endSec = Math.floor((evt.endTs - youtube.startedAt) / 1000);
  } else {
    const nextEvt = events[eventIdx + 1];
    if (nextEvt && nextEvt.ts > evt.ts) {
      endSec = Math.floor((nextEvt.ts - youtube.startedAt) / 1000);
    }
  }
  if (endSec === null) endSec = startSec + FALLBACK_DURATION_S;
  endSec = Math.min(endSec, startSec + MAX_DURATION_S);
  endSec = Math.max(endSec, startSec + MIN_DURATION_S);
  // Prefer the AI-written caption when supplied; otherwise fall back to the
  // mechanical describe() line.
  const caption = (smartCaption && smartCaption.trim()) ? smartCaption.trim() : describe(evt);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(caption)}</title>
<style>
  html, body { margin: 0; padding: 0; background: #0e1116; color: #e8eaed; font: 14px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; }
  .frame { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; }
  .frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  .caption { padding: 12px 14px; background: #161a22; border: 1px solid #232a35; border-top: 0; border-radius: 0 0 8px 8px; }
  .caption .over { color: #ffd23a; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 800; }
  .caption .desc { font-weight: 700; margin-top: 4px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="frame">
    <iframe src="https://www.youtube.com/embed/${encodeURIComponent(youtube.videoId)}?start=${startSec}&end=${endSec}&autoplay=0&rel=0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
  </div>
  <div class="caption">
    <div class="over">Over ${escapeHtml(evt.over)} · innings ${evt.innings}</div>
    <div class="desc">${escapeHtml(caption)}</div>
  </div>
</div>
</body>
</html>`;
}

function describe(e: { type: string; batter?: string; bowler?: string; runs?: number; context?: string; note?: string; manual?: boolean }): string {
  if (e.manual && e.note) return e.note;
  const who = e.batter ? e.batter : 'Batter';
  switch (e.type) {
    case 'wicket': return `${who} dismissed${e.context ? ' — ' + e.context : ''}${e.bowler ? ' (b ' + e.bowler + ')' : ''}`;
    case '4': return `${who} laces a four${e.bowler ? ' off ' + e.bowler : ''}`;
    case '6': return `${who} clears the rope${e.bowler ? ' off ' + e.bowler : ''}`;
    case 'fifty': return `${who} brings up fifty${e.runs ? ' (' + e.runs + '*)' : ''}`;
    case 'hundred': return `${who} brings up a HUNDRED${e.runs ? ' (' + e.runs + '*)' : ''}`;
    case 'team-milestone': return `Team passes ${e.runs}`;
    case 'moment': return e.note ? e.note : 'Stamped moment';
    default: return e.type;
  }
}

function embedFallback(title: string, desc: string): string {
  return `<!doctype html><html><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title>
<style>body{margin:0;background:#0e1116;color:#e8eaed;font:14px/1.4 -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px}h1{font-size:16px;margin:0 0 8px;color:#ffd23a;letter-spacing:0.1em;text-transform:uppercase}p{color:#8a93a4;margin:0}</style>
</head><body><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(desc)}</p></div></body></html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

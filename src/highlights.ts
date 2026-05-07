import type { Env } from './types';
import { readEvents, type MatchEvent } from './events';
import { readYouTube } from './archive';
import { isAdmin } from './admin';

const SCOPE_LABELS: Record<string, string> = {
  '3s': '3rd XI',
  '4s': '4th XI',
};

const TYPE_LABELS: Record<MatchEvent['type'], { label: string; emoji: string; color: string }> = {
  wicket: { label: 'WICKET', emoji: '🎯', color: '#ff4d6d' },
  '4': { label: 'FOUR', emoji: '🏏', color: '#4189ff' },
  '6': { label: 'SIX', emoji: '🚀', color: '#ff4d9b' },
  fifty: { label: 'FIFTY', emoji: '⭐', color: '#ffd23a' },
  hundred: { label: 'HUNDRED', emoji: '💯', color: '#ffd23a' },
  'team-milestone': { label: 'TEAM', emoji: '📈', color: '#3ddc84' },
  moment: { label: 'MOMENT', emoji: '⭐', color: '#c9b46c' },
};

export async function renderHighlights(env: Env, matchId: string, scope: string, url?: URL): Promise<string> {
  const [events, youtube] = await Promise.all([
    readEvents(env, matchId),
    readYouTube(env, scope),
  ]);
  const scopeLabel = SCOPE_LABELS[scope] ?? '';
  const safeId = matchId.replace(/[^a-zA-Z0-9_-]/g, '');
  const admin = !!url && isAdmin(env, url, scope);
  const adminKey = admin ? (url!.searchParams.get('key') ?? '') : '';
  const stampPath = `${scope ? '/' + scope : ''}/api/admin/stamp/${encodeURIComponent(safeId)}`;

  const cards = events.map((e) => {
    const meta = TYPE_LABELS[e.type] ?? { label: e.type.toUpperCase(), emoji: '·', color: '#8a93a4' };
    let href: string | null = null;
    if (youtube) {
      const offsetSec = Math.max(0, Math.floor((e.ts - youtube.startedAt) / 1000));
      href = `https://www.youtube.com/watch?v=${encodeURIComponent(youtube.videoId)}&t=${offsetSec}s`;
    }
    const desc = describe(e);
    const inner = `<div class="card-inner">
  <div class="badge" style="background:${meta.color}1a;color:${meta.color}">${meta.emoji} ${meta.label}</div>
  <div class="over">Over ${escapeHtml(e.over)} · Inn ${e.innings}</div>
  <div class="desc">${escapeHtml(desc)}</div>
  ${href ? '<div class="play">▶ Watch on YouTube</div>' : '<div class="play noplay">No stream URL set</div>'}
</div>`;
    return href
      ? `<a class="card" href="${href}" target="_blank" rel="noopener" style="border-left-color:${meta.color}">${inner}</a>`
      : `<div class="card" style="border-left-color:${meta.color}">${inner}</div>`;
  }).reverse().join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0e1116" />
<title>Highlights · ${escapeHtml(scopeLabel || 'Cricket')}</title>
<style>
  :root { --bg:#0e1116; --panel:#161a22; --border:#232a35; --accent:#ffd23a; --text:#e8eaed; --muted:#8a93a4; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
  header { padding: 18px 16px; border-bottom: 1px solid var(--border); }
  header h1 { margin: 0; font-size: 16px; letter-spacing: 0.1em; text-transform: uppercase; }
  header p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
  main { max-width: 720px; margin: 0 auto; padding: 16px; display: grid; gap: 10px; }
  .card {
    display: block; text-decoration: none; color: inherit;
    background: var(--panel); border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    border-radius: 8px;
    padding: 14px 16px;
    transition: transform .15s ease;
  }
  a.card:hover { transform: translateX(2px); border-color: var(--accent); }
  .card-inner { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; }
  .badge { padding: 4px 10px; border-radius: 4px; font-weight: 800; font-size: 11px; letter-spacing: 0.08em; }
  .over { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .desc { color: var(--text); font-weight: 600; font-size: 14px; min-width: 0; }
  .play { color: var(--accent); font-size: 12px; font-weight: 700; letter-spacing: 0.04em; }
  .play.noplay { color: var(--muted); }
  .empty { padding: 60px 20px; text-align: center; color: var(--muted); }
  .empty h2 { color: var(--text); font-size: 16px; margin: 0 0 8px; }
  .stamp { position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--border); padding: 10px 12px; }
  .stamp-row { display: flex; gap: 6px; align-items: center; max-width: 720px; margin: 0 auto; flex-wrap: wrap; }
  .stamp input[name=note] { flex: 1; min-width: 160px; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font: inherit; }
  .stamp button { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; font: inherit; font-weight: 700; cursor: pointer; }
  .stamp button.primary { background: var(--accent); color: #1a1a1a; border-color: var(--accent); }
  .stamp button:disabled { opacity: 0.5; cursor: progress; }
  .stamp .status { color: var(--muted); font-size: 12px; margin-left: 4px; }
  @media (max-width: 480px) {
    .card-inner { grid-template-columns: 1fr; gap: 6px; }
    .desc { order: 3; }
    .play { order: 4; text-align: left; }
  }
</style>
</head>
<body>
<header>
  <h1>Highlights${scopeLabel ? ' · ' + escapeHtml(scopeLabel) : ''}</h1>
  <p>Match <code>${escapeHtml(safeId)}</code> · ${events.length} clip${events.length === 1 ? '' : 's'}${youtube ? '' : ' · <strong>set a YouTube URL in admin to enable replay links</strong>'}</p>
</header>
${admin ? `<section class="stamp" aria-label="Manual stamp">
  <form id="stamp-form" class="stamp-row" autocomplete="off">
    <input name="note" placeholder="Optional note (e.g. ‘big appeal’)" maxlength="200" />
    <button type="submit" class="primary" data-type="moment">⭐ Stamp now</button>
    <button type="button" data-type="4">4</button>
    <button type="button" data-type="6">6</button>
    <button type="button" data-type="wicket">W</button>
    <span class="status" id="stamp-status"></span>
  </form>
</section>
<script>
(function(){
  var STAMP_URL = ${JSON.stringify(stampPath)} + '?key=' + encodeURIComponent(${JSON.stringify(adminKey)});
  var form = document.getElementById('stamp-form');
  var noteInput = form.querySelector('input[name=note]');
  var status = document.getElementById('stamp-status');
  var buttons = form.querySelectorAll('button');
  function setBusy(b){ buttons.forEach(function(btn){ btn.disabled = b; }); }
  function send(type){
    setBusy(true);
    status.textContent = 'Stamping…';
    fetch(STAMP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: type, note: noteInput.value || '' }),
    }).then(function(r){
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function(){
      noteInput.value = '';
      status.textContent = 'Stamped — reloading…';
      window.location.reload();
    }).catch(function(e){
      status.textContent = 'Failed: ' + e.message;
      setBusy(false);
    });
  }
  form.addEventListener('submit', function(e){ e.preventDefault(); send('moment'); });
  Array.prototype.forEach.call(form.querySelectorAll('button[type=button]'), function(btn){
    btn.addEventListener('click', function(){ send(btn.getAttribute('data-type') || 'moment'); });
  });
})();
</script>` : ''}
<main>
${cards || '<div class="empty"><h2>No highlights yet</h2><p>Wickets, 4s, 6s, and milestones will appear here as they happen.</p></div>'}
</main>
</body>
</html>`;
}

function describe(e: MatchEvent): string {
  const who = e.batter ? e.batter : '';
  if (e.manual && e.note) {
    // Manual stamps lead with the scorer's own caption regardless of type.
    return e.note;
  }
  switch (e.type) {
    case 'wicket': return `${who || 'Batter'} dismissed${e.context ? ' — ' + e.context : ''}${e.bowler ? ' (b ' + e.bowler + ')' : ''}`;
    case '4': return `${who || 'Batter'} laces a four${e.bowler ? ' off ' + e.bowler : ''}`;
    case '6': return `${who || 'Batter'} clears the rope${e.bowler ? ' off ' + e.bowler : ''}`;
    case 'fifty': return `${who || 'Batter'} brings up fifty${e.runs ? ' (' + e.runs + '*)' : ''}`;
    case 'hundred': return `${who || 'Batter'} brings up a HUNDRED${e.runs ? ' (' + e.runs + '*)' : ''}`;
    case 'team-milestone': return `Team passes ${e.runs}`;
    case 'moment': return e.note ? e.note : 'Stamped moment';
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// Game-day onboarding wizard.
//
// Six linear steps that walk a non-technical scorer through getting a match
// live: pick fixture, drop the score overlay into OBS, add the camera and
// crop to the wicket, start the YouTube broadcast, scan the highlights QR
// onto a phone, share the spectator URLs.
//
// Each step is rendered server-side from the URL's `?step=N` query param.
// Forms POST to existing admin handlers (set-active, youtube,
// youtube-refresh) with a `next` field so the redirect lands on the next
// wizard step. No new KV keys, no schema changes.

import type { Env } from './types';
import { getActiveMatchId } from './admin';
import { discoverMatches, type DiscoveredMatch } from './discovery';
import { readYouTube, type YouTubeConfig } from './archive';

const SCOPE_LABELS: Record<string, string> = {
  '': 'Default',
  '3s': '3rd XI',
  '4s': '4th XI',
};

const TOTAL_STEPS = 6;

export async function renderSetup(env: Env, scope: string, url: URL, origin: string): Promise<string> {
  const stepRaw = parseInt(url.searchParams.get('step') ?? '1', 10);
  const step = Number.isFinite(stepRaw) && stepRaw >= 1 && stepRaw <= TOTAL_STEPS ? stepRaw : 1;
  const key = url.searchParams.get('key') ?? '';
  const prefix = scope ? `/${scope}` : '';
  const adminPath = `${prefix}/admin`;
  const setupPath = `${adminPath}/setup`;
  const scopeLabel = SCOPE_LABELS[scope] ?? scope.toUpperCase();

  // Pull the data each step might need in one parallel fetch — cheaper than
  // re-fetching per branch and keeps the per-step renderers pure.
  const [activeMatchId, fixtures, youtube] = await Promise.all([
    getActiveMatchId(env, scope),
    step === 1 ? discoverMatches(env).catch(() => [] as DiscoveredMatch[]) : Promise.resolve([] as DiscoveredMatch[]),
    readYouTube(env, scope),
  ]);

  const ctx: StepCtx = { env, scope, scopeLabel, key, prefix, adminPath, setupPath, origin, activeMatchId, fixtures, youtube };
  let body: string;
  switch (step) {
    case 1: body = renderStep1(ctx); break;
    case 2: body = renderStep2(ctx); break;
    case 3: body = renderStep3(ctx); break;
    case 4: body = renderStep4(ctx); break;
    case 5: body = renderStep5(ctx); break;
    case 6: body = renderStep6(ctx); break;
    default: body = renderStep1(ctx);
  }

  return frame(scopeLabel, step, key, setupPath, body);
}

type StepCtx = {
  env: Env;
  scope: string;
  scopeLabel: string;
  key: string;
  prefix: string;
  adminPath: string;
  setupPath: string;
  origin: string;
  activeMatchId: string | null;
  fixtures: DiscoveredMatch[];
  youtube: YouTubeConfig | null;
};

// ---------- chrome ---------------------------------------------------------

function frame(scopeLabel: string, step: number, key: string, setupPath: string, body: string): string {
  const pct = Math.round((step / TOTAL_STEPS) * 100);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Setup · ${escapeHtml(scopeLabel)} · Step ${step}/${TOTAL_STEPS}</title>
<style>
  :root {
    --bg: #0e1116;
    --panel: #161a22;
    --border: #232a35;
    --accent: #ffd23a;
    --text: #e8eaed;
    --muted: #8a93a4;
    --green: #3ddc84;
    --red: #ff6b6b;
    --warn: #ffa94d;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
  header { padding: 22px 32px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  header h1 { margin: 0; font-size: 16px; letter-spacing: 0.06em; text-transform: uppercase; }
  header .scope { color: var(--accent); font-weight: 800; letter-spacing: 0.18em; }
  header nav { margin-left: auto; }
  header nav a { color: var(--muted); text-decoration: none; padding: 6px 12px; border: 1px solid var(--border); border-radius: 4px; font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; }
  header nav a:hover { color: var(--accent); border-color: var(--accent); }
  .progress { padding: 14px 32px; border-bottom: 1px solid var(--border); }
  .progress-row { max-width: 760px; margin: 0 auto; display: flex; align-items: center; gap: 12px; }
  .progress-label { color: var(--muted); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap; }
  .bar { flex: 1; height: 6px; background: #0a0d12; border: 1px solid var(--border); border-radius: 99px; overflow: hidden; }
  .bar-fill { height: 100%; background: var(--accent); width: ${pct}%; transition: width .25s ease; }
  main { max-width: 760px; margin: 24px auto 80px; padding: 0 24px; }
  section { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 24px; margin-bottom: 18px; }
  section h2 { margin: 0 0 4px; font-size: 22px; line-height: 1.2; }
  section .lede { color: var(--muted); margin: 0 0 18px; font-size: 14px; }
  section h3 { font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 22px 0 8px; }
  ol.steps { padding-left: 22px; margin: 0 0 14px; }
  ol.steps li { margin: 8px 0; }
  ol.steps li code { background: #0a0d12; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  .copy-row { display: flex; gap: 8px; align-items: stretch; margin: 8px 0 4px; }
  .copy-row input { flex: 1; padding: 10px 12px; background: #0a0d12; color: var(--text); border: 1px solid var(--border); border-radius: 6px; font: 13px ui-monospace, Menlo, Consolas, monospace; }
  .copy-row button { padding: 10px 14px; background: var(--accent); color: #0a0d12; border: none; border-radius: 6px; font-weight: 700; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; cursor: pointer; white-space: nowrap; }
  .copy-row button:hover { background: #ffe066; }
  .copy-row button.copied { background: var(--green); color: #0a0d12; }
  .nav-row { display: flex; justify-content: space-between; align-items: center; margin-top: 26px; }
  a.btn, button.btn { display: inline-block; padding: 10px 18px; border-radius: 6px; font-weight: 700; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; text-decoration: none; cursor: pointer; border: 1px solid var(--border); background: transparent; color: var(--text); }
  a.btn.primary, button.btn.primary { background: var(--accent); color: #0a0d12; border-color: var(--accent); }
  a.btn.primary:hover, button.btn.primary:hover { background: #ffe066; }
  a.btn.ghost { color: var(--muted); }
  a.btn.ghost:hover { color: var(--text); border-color: var(--text); }
  .empty { padding: 18px; background: #0a0d12; border: 1px dashed var(--border); border-radius: 6px; color: var(--muted); }
  .fixture-list { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 14px; }
  .fixture { display: flex; align-items: center; gap: 14px; padding: 12px 14px; background: #0a0d12; border: 1px solid var(--border); border-radius: 6px; }
  .fixture.active { border-color: var(--accent); }
  .fixture .meta { flex: 1; min-width: 0; }
  .fixture .teams { font-weight: 700; }
  .fixture .vs { color: var(--muted); font-weight: 500; margin: 0 6px; }
  .fixture .sub { color: var(--muted); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; margin-top: 4px; }
  .fixture button { margin: 0; padding: 8px 14px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 700; background: var(--accent); color: #0a0d12; border: none; border-radius: 4px; cursor: pointer; }
  .fixture.active button { background: #2a2e36; color: var(--muted); cursor: default; }
  .pill { display: inline-block; padding: 3px 8px; border-radius: 99px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; font-weight: 700; }
  .pill.ok { background: rgba(61,220,132,0.12); color: var(--green); }
  .pill.warn { background: rgba(255,169,77,0.12); color: var(--warn); }
  .qr-box { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 18px; background: #0a0d12; border: 1px solid var(--border); border-radius: 8px; }
  .qr-canvas { width: 256px; height: 256px; background: #fff; border-radius: 6px; }
  .qr-canvas:empty::before { content: 'Generating QR…'; color: #888; font-size: 11px; display: block; padding: 110px 0; text-align: center; }
  .warn-box { padding: 12px 14px; background: rgba(255,107,107,0.08); border: 1px solid rgba(255,107,107,0.35); border-left: 3px solid var(--red); border-radius: 6px; color: #ffd0d0; font-size: 13px; margin-top: 14px; }
  .info-box { padding: 12px 14px; background: rgba(255,210,58,0.06); border: 1px solid rgba(255,210,58,0.25); border-radius: 6px; color: var(--muted); font-size: 13px; margin-top: 12px; }
  .info-box.ok { background: rgba(61,220,132,0.06); border-color: rgba(61,220,132,0.3); color: #cfeacf; }
  .info-box.warn { background: rgba(255,169,77,0.06); border-color: rgba(255,169,77,0.3); color: #f0d6b5; }
  .crop-svg { display: block; margin: 14px auto; max-width: 360px; height: auto; }
</style>
</head>
<body>
<header>
  <h1><span class="scope">${escapeHtml(scopeLabel)}</span> · Game-day setup</h1>
  <nav><a href="${escapeHtml(setupPath.replace('/setup', ''))}?key=${encodeURIComponent(key)}">← Admin</a></nav>
</header>
<div class="progress">
  <div class="progress-row">
    <span class="progress-label">Step ${step} of ${TOTAL_STEPS}</span>
    <div class="bar"><div class="bar-fill"></div></div>
  </div>
</div>
<main>
${body}
</main>
<script>
// Tiny copy-button helper. Selectors get stamped via data-copy="<value>".
document.querySelectorAll('button[data-copy]').forEach(function(btn){
  btn.addEventListener('click', function(){
    var v = btn.getAttribute('data-copy') || '';
    var ok = false;
    try { navigator.clipboard.writeText(v); ok = true; } catch(e) {}
    if (!ok) {
      var ta = document.createElement('textarea');
      ta.value = v; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok = true; } catch(e) {}
      document.body.removeChild(ta);
    }
    var orig = btn.textContent;
    btn.textContent = 'Copied';
    btn.classList.add('copied');
    setTimeout(function(){ btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
  });
});
</script>
</body>
</html>`;
}

// ---------- step renderers ------------------------------------------------

function renderStep1(c: StepCtx): string {
  const fixtureCards = c.fixtures.map((f) => {
    const isActive = f.matchId === c.activeMatchId;
    return `<form method="POST" action="${c.adminPath}/set-active?key=${encodeURIComponent(c.key)}" class="fixture${isActive ? ' active' : ''}">
      <input type="hidden" name="matchId" value="${escapeHtml(f.matchId)}" />
      <input type="hidden" name="next" value="${escapeHtml(c.setupPath)}?step=2&key=${encodeURIComponent(c.key)}" />
      <div class="meta">
        <div class="teams">${escapeHtml(f.battingTeam)} <span class="vs">vs</span> ${escapeHtml(f.bowlingTeam)}</div>
        <div class="sub"><code>${escapeHtml(f.matchId)}</code> · ${escapeHtml(f.status)}${isActive ? ' · active' : ''}</div>
      </div>
      <button type="submit">${isActive ? 'Active' : 'Pick'}</button>
    </form>`;
  }).join('');

  return `<section>
  <h2>Welcome — let's get the ${escapeHtml(c.scopeLabel)} ready to stream.</h2>
  <p class="lede">Six steps, about five minutes. Each step has its own URL — bookmark this page if you need to come back.</p>

  <h3>Pick today's fixture</h3>
  ${c.activeMatchId ? `<div class="info-box ok">Currently active: <code>${escapeHtml(c.activeMatchId)}</code> — pick a different fixture below or <a class="btn primary" style="margin-left:8px" href="${c.setupPath}?step=2&amp;key=${encodeURIComponent(c.key)}">Keep this and continue →</a></div>` : ''}
  ${c.fixtures.length
    ? `<div class="fixture-list">${fixtureCards}</div>`
    : `<div class="empty">No fixtures discovered. Set <code>DISCOVERY_HOME_URL</code> in <code>wrangler.toml</code> to your club's Play-Cricket home page, or paste a Play-Cricket match ID below.</div>`}

  <h3>Or paste a match ID manually</h3>
  <form method="POST" action="${c.adminPath}/set-active?key=${encodeURIComponent(c.key)}" class="copy-row">
    <input type="hidden" name="next" value="${escapeHtml(c.setupPath)}?step=2&key=${encodeURIComponent(c.key)}" />
    <input type="text" name="matchId" placeholder="e.g. 7591652" />
    <button type="submit">Set + continue</button>
  </form>
  <p class="lede" style="margin-top:18px">The match ID is the number at the end of the Play-Cricket match URL. It's used as the unique key for this fixture across every page on this site.</p>

  <div class="nav-row">
    <span></span>
    ${c.activeMatchId ? `<a class="btn primary" href="${c.setupPath}?step=2&amp;key=${encodeURIComponent(c.key)}">Continue →</a>` : `<span class="lede">Pick a fixture to continue.</span>`}
  </div>
</section>`;
}

function renderStep2(c: StepCtx): string {
  const overlayUrl = `${c.origin}${c.prefix}/overlay/active`;
  return `<section>
  <h2>Drop the score overlay into OBS.</h2>
  <p class="lede">One Browser Source. Set it up once and it'll follow whichever match you pick going forward — no edit needed before the next game.</p>

  <ol class="steps">
    <li>Open OBS. In the <strong>Sources</strong> panel (bottom-left), click <strong>+</strong> → <strong>Browser</strong>. Name it <code>Score Overlay</code>. Click OK.</li>
    <li>Paste this URL into the <strong>URL</strong> field:
      <div class="copy-row">
        <input type="text" readonly value="${escapeHtml(overlayUrl)}" onclick="this.select()" />
        <button type="button" data-copy="${escapeHtml(overlayUrl)}">Copy</button>
      </div>
    </li>
    <li>Set <strong>Width</strong> <code>1920</code>, <strong>Height</strong> <code>1080</code>. Leave the rest as default. Click OK.</li>
    <li>The overlay box appears on your canvas. Drag any corner handle to resize it so it fills the full frame (hold Shift to keep aspect).</li>
  </ol>

  <div class="info-box">This URL tracks <em>active match</em> — set the active match in step 1 and the overlay shows that match's score. Change matches next week, the overlay follows. You won't need to edit OBS again unless you want to.</div>

  <div class="nav-row">
    <a class="btn ghost" href="${c.setupPath}?step=1&amp;key=${encodeURIComponent(c.key)}">← Back</a>
    <a class="btn primary" href="${c.setupPath}?step=3&amp;key=${encodeURIComponent(c.key)}">Done. Next →</a>
  </div>
</section>`;
}

function renderStep3(_c: StepCtx): string {
  const c = _c;
  return `<section>
  <h2>Add the camera. Then zoom to the wicket.</h2>
  <p class="lede">Cropping in OBS is non-destructive — you don't lose any pixels, you just choose which part of the frame to show. The wicket trick is the bit you'll redo every match.</p>

  <h3>Add the camera</h3>
  <ol class="steps">
    <li>Sources panel → <strong>+</strong> → <strong>Video Capture Device</strong>. Name it <code>Camera</code>. Click OK.</li>
    <li>In the properties dialog, pick your USB camera from the <strong>Device</strong> dropdown. Click OK.</li>
  </ol>

  <h3>Layer the score on top of the camera</h3>
  <ol class="steps">
    <li>In the Sources list, drag <code>Score Overlay</code> so it sits <strong>above</strong> <code>Camera</code>.</li>
    <li>Higher in the list = rendered on top. Order matters — if Camera is above Score Overlay, the overlay will be hidden.</li>
  </ol>

  <h3>Crop to the wicket</h3>
  <p class="lede" style="margin-bottom:6px">This is the bit you'll redo every game as the camera angle changes.</p>
  <svg class="crop-svg" viewBox="0 0 360 220" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="20" y="20" width="320" height="180" fill="#1f2530" stroke="#3ddc84" stroke-width="2" />
    <rect x="80" y="60" width="200" height="100" fill="none" stroke="#ffd23a" stroke-width="2" stroke-dasharray="6 4" />
    <circle cx="80" cy="60" r="6" fill="#3ddc84" />
    <circle cx="280" cy="60" r="6" fill="#3ddc84" />
    <circle cx="80" cy="160" r="6" fill="#3ddc84" />
    <circle cx="280" cy="160" r="6" fill="#3ddc84" />
    <text x="180" y="115" fill="#ffd23a" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="13" font-weight="700">⌥ + drag inward</text>
    <text x="180" y="135" fill="#8a93a4" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="11">visible region (the wicket)</text>
  </svg>
  <ol class="steps">
    <li>Click the camera on the canvas — you should see a red outline with green corner handles.</li>
    <li>Hold <strong>Option (⌥)</strong> and drag any green corner inward. That's a non-destructive crop. Drag from the corner closest to the wicket so the wicket stays roughly centred.</li>
    <li>Right-click the camera → <strong>Transform</strong> → <strong>Fit to screen</strong>. The cropped region now fills the frame at full resolution.</li>
    <li>Over-cropped? Hold ⌥ and drag the same corner back outward. Want to start over? Right-click → Transform → <strong>Reset transform</strong>.</li>
  </ol>

  <div class="info-box">Camera angle changes between matches and even between innings. Re-crop whenever the wicket drifts off-centre — it's a 5-second job once you've done it once.</div>

  <div class="nav-row">
    <a class="btn ghost" href="${c.setupPath}?step=2&amp;key=${encodeURIComponent(c.key)}">← Back</a>
    <a class="btn primary" href="${c.setupPath}?step=4&amp;key=${encodeURIComponent(c.key)}">Done. Next →</a>
  </div>
</section>`;
}

function renderStep4(c: StepCtx): string {
  const yt = c.youtube;
  const youtubePath = `${c.adminPath}/youtube`;
  const youtubeRefreshPath = `${c.adminPath}/youtube-refresh`;
  const nextStepUrl = `${c.setupPath}?step=5&key=${encodeURIComponent(c.key)}`;
  const banner = !yt
    ? `<div class="info-box">No stream URL saved yet. Start streaming in OBS, then paste the YouTube watch URL below.</div>`
    : yt.startSource === 'youtube'
      ? `<div class="info-box ok"><span class="pill ok">✓ Live</span> Active: <code>${escapeHtml(yt.videoId)}</code> · started ${formatRelative(yt.startedAt)} ago (from YouTube). Clip timestamps will be accurate.</div>`
      : `<div class="info-box warn"><span class="pill warn">⚠ Fallback</span> Active: <code>${escapeHtml(yt.videoId)}</code> · using paste-time as start (${formatRelative(yt.startedAt)} ago). Refresh once the broadcast is live so YouTube can give us the real start time.</div>`;

  return `<section>
  <h2>Click Start Streaming. Then paste the URL back.</h2>
  <p class="lede">Pasting the URL is what lets every clip and highlight link land on the right second of the YouTube replay.</p>

  <ol class="steps">
    <li>In OBS, top-right: <strong>Start Streaming</strong>. Your YouTube account is already linked — no stream key needed.</li>
    <li>Wait until OBS's bottom-right indicator is solid green and the dropped-frame counter is at zero.</li>
    <li>YouTube opens a "broadcasting" tab in your browser. Copy the URL from the address bar and paste below.</li>
  </ol>

  ${banner}

  <h3>${yt ? 'Update' : 'Save'} stream URL</h3>
  <form method="POST" action="${youtubePath}?key=${encodeURIComponent(c.key)}">
    <input type="hidden" name="next" value="${escapeHtml(nextStepUrl)}" />
    <div class="copy-row">
      <input type="text" name="url" placeholder="https://www.youtube.com/watch?v=…" value="${escapeHtml(yt?.url ?? '')}" />
      <button type="submit">Save URL</button>
    </div>
    <p class="lede" style="margin:8px 0 0">Accepts <code>youtube.com/watch?v=…</code>, <code>youtu.be/…</code>, <code>youtube.com/live/…</code>.</p>
  </form>

  ${yt && yt.startSource !== 'youtube' ? `<form method="POST" action="${youtubeRefreshPath}?key=${encodeURIComponent(c.key)}" style="margin-top:14px">
    <input type="hidden" name="next" value="${escapeHtml(c.setupPath)}?step=4&key=${encodeURIComponent(c.key)}" />
    <button class="btn" type="submit">Refresh start time from YouTube</button>
  </form>` : ''}

  <div class="nav-row">
    <a class="btn ghost" href="${c.setupPath}?step=3&amp;key=${encodeURIComponent(c.key)}">← Back</a>
    ${yt ? `<a class="btn primary" href="${nextStepUrl}">Skip ahead →</a>` : '<span class="lede">Save the URL to continue.</span>'}
  </div>
</section>`;
}

function renderStep5(c: StepCtx): string {
  const matchId = c.activeMatchId ?? '';
  const stampUrl = `${c.origin}${c.prefix}/highlights/${encodeURIComponent(matchId)}?key=${encodeURIComponent(c.key)}`;

  if (!matchId) {
    return `<section>
  <h2>Phone setup needs an active match.</h2>
  <p class="lede">Go back to step 1 and pick a fixture first.</p>
  <div class="nav-row">
    <a class="btn ghost" href="${c.setupPath}?step=4&amp;key=${encodeURIComponent(c.key)}">← Back</a>
    <a class="btn primary" href="${c.setupPath}?step=1&amp;key=${encodeURIComponent(c.key)}">Go to step 1</a>
  </div>
</section>`;
  }

  return `<section>
  <h2>Open this on your phone for in-game stamping.</h2>
  <p class="lede">During the match, tap <strong>Stamp now</strong> on this page when something happens that the scoring scrape might miss — a great catch, a dropped one, a wild appeal. Each stamp creates a clip link.</p>

  <div class="qr-box">
    <div id="qr" class="qr-canvas"></div>
    <div style="text-align:center">
      <strong>Scan with your phone camera</strong>
      <div class="lede">Then bookmark the page that opens.</div>
    </div>
  </div>

  <h3>Or copy the URL</h3>
  <div class="copy-row">
    <input type="text" readonly value="${escapeHtml(stampUrl)}" onclick="this.select()" />
    <button type="button" data-copy="${escapeHtml(stampUrl)}">Copy</button>
  </div>
  <p class="lede" style="margin-top:6px"><a class="btn ghost" href="${escapeHtml(stampUrl)}" target="_blank" rel="noopener">Open in this browser</a></p>

  <div class="warn-box"><strong>Heads-up:</strong> Anyone with this URL can stamp moments during this match. Don't post it on Slack, Twitter, or anywhere public. The QR is regenerated each time — it carries the admin key.</div>

  <div class="nav-row">
    <a class="btn ghost" href="${c.setupPath}?step=4&amp;key=${encodeURIComponent(c.key)}">← Back</a>
    <a class="btn primary" href="${c.setupPath}?step=6&amp;key=${encodeURIComponent(c.key)}">I've got it on my phone →</a>
  </div>
</section>
<script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
<script>
(function(){
  function render(){
    if (typeof QRCode === 'undefined') return false;
    QRCode.toCanvas(document.getElementById('qr'), ${JSON.stringify(stampUrl)}, { width: 256, margin: 2, color: { dark: '#0a0d12', light: '#ffffff' } }, function(err){
      if (err) {
        var n = document.getElementById('qr');
        n.textContent = 'Could not render QR — copy the URL below instead.';
      }
    });
    return true;
  }
  if (!render()) {
    var tries = 0;
    var t = setInterval(function(){ if (render() || ++tries > 20) clearInterval(t); }, 150);
  }
})();
</script>`;
}

function renderStep6(c: StepCtx): string {
  const matchId = c.activeMatchId ?? '';
  const liveUrl = `${c.origin}${c.prefix}/live/${encodeURIComponent(matchId)}`;
  const highlightsUrl = `${c.origin}${c.prefix}/highlights/${encodeURIComponent(matchId)}`;
  const summaryUrl = `${c.origin}${c.prefix}/summary/${encodeURIComponent(matchId)}`;

  return `<section>
  <h2>You're live. Share these as needed.</h2>
  <p class="lede">All three URLs work without any keys — they're public. Use the right one for the right audience.</p>

  <h3>Spectator (live page) — for parents</h3>
  <p class="lede" style="margin-bottom:4px">Score, commentary, live wagon wheel, clip strip. Updates every few seconds.</p>
  <div class="copy-row">
    <input type="text" readonly value="${escapeHtml(liveUrl)}" onclick="this.select()" />
    <button type="button" data-copy="${escapeHtml(liveUrl)}">Copy</button>
  </div>

  <h3>Highlights — for the WhatsApp group</h3>
  <p class="lede" style="margin-bottom:4px">Vertical list of every wicket / boundary / stamped moment. Click any card to jump straight to that second on the YouTube replay.</p>
  <div class="copy-row">
    <input type="text" readonly value="${escapeHtml(highlightsUrl)}" onclick="this.select()" />
    <button type="button" data-copy="${escapeHtml(highlightsUrl)}">Copy</button>
  </div>

  <h3>Summary — best after the last over</h3>
  <p class="lede" style="margin-bottom:4px">Final scoreline, top performers, full wagon wheel. Renders even mid-match but reads best at the end.</p>
  <div class="copy-row">
    <input type="text" readonly value="${escapeHtml(summaryUrl)}" onclick="this.select()" />
    <button type="button" data-copy="${escapeHtml(summaryUrl)}">Copy</button>
  </div>

  <div class="nav-row">
    <a class="btn ghost" href="${c.setupPath}?step=1&amp;key=${encodeURIComponent(c.key)}">↻ Run again next match</a>
    <a class="btn primary" href="${c.adminPath}?key=${encodeURIComponent(c.key)}">Back to admin</a>
  </div>
</section>`;
}

// ---------- helpers --------------------------------------------------------

function formatRelative(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 0) return 'just now';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'less than a minute';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return `${h}h ${rm}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

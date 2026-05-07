import { BRAND_LOGO_DATA_URI, BRAND_MASCOT_DATA_URI } from './assets';
import type { BrandingConfig } from './branding';

const SCOPE_LABELS: Record<string, string> = {
  '3s': '3rd XI',
  '4s': '4th XI',
};

export function renderOverlay(matchId: string, branding?: BrandingConfig, scope = ''): string {
  const safeId = matchId.replace(/[^a-zA-Z0-9_-]/g, '');
  const brandingJson = JSON.stringify(branding ?? { sponsors: [], teams: {} });
  const scopeLabel = SCOPE_LABELS[scope] ?? '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Cricket scorebar</title>
<style>
  :root {
    --accent: #ffd23a;
    --accent-warm: #ffb300;
    --gold: #c8a500;
    --bg: rgba(8, 10, 14, 0.94);
    --bg-elev: rgba(20, 24, 32, 0.92);
    --border: rgba(255,255,255,0.07);
    --batting-tint: rgba(255, 210, 58, 0.06);
    --bowling-tint: rgba(255, 255, 255, 0.02);
    --safe-bottom: 16px;
  }
  html, body { margin: 0; padding: 0; background: transparent; height: 100%; overflow: hidden; }

  /* Top-left branding header */
  #brand {
    position: fixed;
    top: 16px;
    left: 16px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    filter: drop-shadow(0 4px 12px rgba(0,0,0,0.55));
    z-index: 5;
  }
  #brand .logos { display: flex; align-items: center; gap: 12px; }
  #brand img { height: 84px; width: auto; display: block; }
  #brand img.brand-mascot { height: 96px; }
  #brand .scope-label {
    font-size: 14px;
    font-weight: 800;
    letter-spacing: 0.32em;
    text-transform: uppercase;
    color: #fff;
    background: rgba(0,0,0,0.55);
    padding: 4px 12px;
    border-radius: 3px;
    border-left: 3px solid var(--accent);
    margin-left: 4px;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #fff;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  #wrap {
    position: fixed;
    left: 0; right: 0; bottom: var(--safe-bottom);
    display: flex;
    flex-direction: column;
    opacity: 0;
    transition: opacity 0.4s ease;
    filter: drop-shadow(0 6px 18px rgba(0,0,0,0.45));
  }
  #wrap.ready { opacity: 1; }

  /* Top strip: current batters + bowler */
  #players {
    display: none;
    align-items: stretch;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
    height: 56px;
  }
  #players.show { display: flex; }
  .pcell {
    display: flex;
    align-items: center;
    flex: 1;
    padding: 0 28px;
    gap: 14px;
    min-width: 0;
    border-right: 1px solid var(--border);
    position: relative;
  }
  .pcell:last-child { border-right: 0; }
  .pcell.bowler { padding-left: 32px; padding-right: 32px; background: linear-gradient(90deg, transparent, rgba(200,165,0,0.06)); }
  .ptag {
    font-size: 11px;
    letter-spacing: 0.22em;
    color: #8a8a8a;
    text-transform: uppercase;
    flex-shrink: 0;
    font-weight: 700;
  }
  .pcell.bowler .ptag { color: var(--gold); }
  .pname {
    font-size: 17px;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pname.strike::after {
    content: " *";
    color: var(--accent);
    font-weight: 900;
  }
  .pfig {
    margin-left: auto;
    font-size: 18px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    color: #fff;
    flex-shrink: 0;
    transition: transform 0.18s ease, color 0.18s ease;
  }
  .pfig.bump {
    transform: scale(1.12);
    color: var(--accent);
  }
  .pfig .small {
    color: #8a8a8a;
    font-weight: 600;
    font-size: 13px;
    margin-left: 5px;
  }

  /* Sponsor strip (top of stack) */
  #sponsor {
    display: none;
    align-items: center;
    justify-content: center;
    gap: 14px;
    background: rgba(8, 10, 14, 0.85);
    border-bottom: 1px solid var(--border);
    padding: 4px 28px;
    height: 30px;
  }
  #sponsor.show { display: flex; }
  #sponsor .label {
    font-size: 9px;
    letter-spacing: 0.32em;
    color: #8a8a8a;
    text-transform: uppercase;
    font-weight: 700;
  }
  #sponsor .name {
    font-size: 14px;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #fff;
  }
  #sponsor img {
    max-height: 22px;
    width: auto;
  }
  #sponsor .item {
    display: flex;
    align-items: center;
    gap: 10px;
    opacity: 0;
    transition: opacity 0.4s ease;
  }
  #sponsor .item.active { opacity: 1; }

  /* Partnership row */
  #partnership {
    display: none;
    align-items: center;
    justify-content: flex-end;
    gap: 14px;
    background: rgba(15, 18, 24, 0.85);
    border-bottom: 1px solid var(--border);
    padding: 4px 28px;
    height: 22px;
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #aaa;
    font-weight: 700;
  }
  #partnership.show { display: flex; }
  #partnership b { color: #fff; font-weight: 800; font-variant-numeric: tabular-nums; margin-left: 6px; }
  #partnership .pp-tag {
    color: var(--accent);
    border: 1px solid rgba(255,210,58,0.45);
    border-radius: 3px;
    padding: 1px 6px;
    font-size: 10px;
    letter-spacing: 0.2em;
  }

  /* Last dismissal ribbon (transient) */
  #lastout {
    display: none;
    align-items: center;
    justify-content: center;
    gap: 12px;
    background: linear-gradient(90deg, rgba(255,68,68,0.18), rgba(255,68,68,0.04));
    border-top: 2px solid #ff4444;
    border-bottom: 1px solid rgba(255,68,68,0.3);
    padding: 6px 28px;
    height: 30px;
    font-size: 13px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #fff;
    font-weight: 800;
  }
  #lastout.show { display: flex; }
  #lastout .out-tag {
    color: #ff4444;
    font-weight: 900;
    letter-spacing: 0.22em;
  }

  /* Mid strip: last 6 balls */
  #balls {
    display: none;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    background: rgba(15, 18, 24, 0.92);
    border-bottom: 1px solid var(--border);
    padding: 6px 28px;
    height: 32px;
  }
  #balls.show { display: flex; }
  #balls .label {
    font-size: 10px;
    letter-spacing: 0.22em;
    color: #8a8a8a;
    text-transform: uppercase;
    font-weight: 700;
    margin-right: 6px;
  }
  .dot {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: #2a2e36;
    color: #d0d0d0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    border: 1px solid rgba(255,255,255,0.08);
    flex-shrink: 0;
  }
  .dot.zero { color: #5a5a5a; }
  .dot.one, .dot.two, .dot.three { background: #2a2e36; color: #fff; }
  .dot.four { background: linear-gradient(135deg, #2196f3, #1565c0); color: #fff; box-shadow: 0 0 8px rgba(33,150,243,0.5); }
  .dot.six { background: linear-gradient(135deg, #ec407a, #ad1457); color: #fff; box-shadow: 0 0 10px rgba(236,64,122,0.55); }
  .dot.wicket { background: linear-gradient(135deg, #ff5252, #c62828); color: #fff; box-shadow: 0 0 10px rgba(255,82,82,0.6); }
  .dot.extra::after {
    content: "";
    position: absolute;
  }
  .dot.extra {
    border: 1px dashed rgba(255,255,255,0.35);
  }

  /* Bottom strip: team scoreline */
  #bar {
    height: 84px;
    display: flex;
    align-items: stretch;
    background: var(--bg);
    box-shadow: 0 -2px 12px rgba(0,0,0,0.45);
    border-top: 1px solid rgba(255,255,255,0.05);
  }
  .team {
    display: flex;
    align-items: center;
    flex: 1;
    padding: 0 28px;
    gap: 20px;
    min-width: 0;
    position: relative;
  }
  .team.batting { background: var(--batting-tint); }
  .team.bowling { background: var(--bowling-tint); }
  .accent {
    width: 7px;
    align-self: stretch;
    background: linear-gradient(180deg, #555, #2a2a2a);
    border-radius: 3px;
    margin-right: 6px;
  }
  .team.batting .accent {
    background: linear-gradient(180deg, var(--accent), var(--accent-warm));
    box-shadow: 0 0 14px rgba(255, 210, 58, 0.4);
  }
  .team.bowling .accent {
    background: linear-gradient(180deg, #6c6c6c, #3a3a3a);
  }
  .crest {
    width: 44px;
    height: 44px;
    object-fit: contain;
    flex-shrink: 0;
    display: none;
    filter: drop-shadow(0 1px 3px rgba(0,0,0,0.6));
  }
  .crest.show { display: block; }
  .name {
    font-size: 24px;
    font-weight: 800;
    letter-spacing: 0.025em;
    text-transform: uppercase;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }
  .team.bowling .name { color: #b8b8b8; font-weight: 700; }
  .score {
    font-size: 32px;
    font-weight: 900;
    font-variant-numeric: tabular-nums;
    color: #fff;
    white-space: nowrap;
    letter-spacing: -0.01em;
    transition: transform 0.18s ease, color 0.18s ease, text-shadow 0.18s ease;
  }
  .score.bump {
    transform: scale(1.08);
    color: var(--accent);
    text-shadow: 0 0 18px rgba(255, 210, 58, 0.55);
  }
  .team.bowling .score { color: #999; font-weight: 700; font-size: 26px; }
  .meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    justify-content: center;
    padding: 0 28px;
    border-left: 1px solid var(--border);
    min-width: 130px;
    background: linear-gradient(90deg, transparent, rgba(0,0,0,0.25));
  }
  .overs {
    font-size: 28px;
    font-weight: 900;
    font-variant-numeric: tabular-nums;
    color: #fff;
    letter-spacing: -0.01em;
  }
  .overs-label {
    font-size: 10px;
    letter-spacing: 0.22em;
    color: #8a8a8a;
    text-transform: uppercase;
    margin-top: 2px;
    font-weight: 700;
  }
  .target {
    font-size: 11px;
    color: var(--accent);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin-top: 5px;
    font-weight: 800;
  }
  .statuschip {
    display: none;
    margin-top: 5px;
    font-size: 10px;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    font-weight: 800;
    padding: 2px 8px;
    border-radius: 3px;
    border: 1px solid currentColor;
  }
  .statuschip.show { display: inline-block; }
  .statuschip.live { color: #ff4444; }
  .statuschip.finished { color: #aaa; }
  .statuschip.abandoned, .statuschip.no_result { color: #ff8a3c; }
  .statuschip.drawn { color: #6cb9ff; }
  .statuschip.break { color: var(--accent); }
  .rates {
    display: flex;
    gap: 10px;
    margin-top: 4px;
    font-size: 10px;
    letter-spacing: 0.14em;
    color: #aaa;
    text-transform: uppercase;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .rates b { color: #fff; font-weight: 800; margin-left: 2px; }
  .rates .req b { color: var(--accent); }

  /* Full-screen flashes for wickets / milestones */
  #flash {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    opacity: 0;
    background: rgba(0,0,0,0);
    transition: background 0.25s ease, opacity 0.25s ease;
    z-index: 10;
  }
  #flash.show { opacity: 1; background: rgba(0,0,0,0.55); }
  #flash .flash-headline {
    font-size: 140px;
    font-weight: 900;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: #fff;
    text-shadow:
      0 0 36px rgba(255, 210, 58, 0.4),
      0 4px 24px rgba(0,0,0,0.8);
    transform: scale(0.6);
    transition: transform 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.3);
  }
  #flash.show .flash-headline { transform: scale(1); }
  #flash.wicket .flash-headline { color: #ff4444; text-shadow: 0 0 40px rgba(255,68,68,0.6), 0 4px 24px rgba(0,0,0,0.9); }
  #flash.milestone .flash-headline { color: var(--accent); }
  #flash .flash-sub {
    margin-top: 18px;
    font-size: 28px;
    font-weight: 800;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #f0f0f0;
    opacity: 0;
    transition: opacity 0.4s ease 0.15s;
    text-align: center;
    max-width: 80%;
  }
  #flash.show .flash-sub { opacity: 1; }

  /* Live indicator dot top-left */
  #live-dot {
    position: absolute;
    top: 8px;
    left: 8px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ff4444;
    box-shadow: 0 0 0 0 rgba(255, 68, 68, 0.6);
    animation: pulse 1.6s ease-out infinite;
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  #live-dot.live { opacity: 1; }
  @keyframes pulse {
    0%   { box-shadow: 0 0 0 0 rgba(255, 68, 68, 0.55); }
    70%  { box-shadow: 0 0 0 9px rgba(255, 68, 68, 0); }
    100% { box-shadow: 0 0 0 0 rgba(255, 68, 68, 0); }
  }
</style>
</head>
<body>
<div id="flash"><div class="flash-headline"></div><div class="flash-sub"></div></div>
<div id="brand">
  <div class="logos">
    <img class="brand-logo" alt="" />
    <img class="brand-mascot" alt="" />
  </div>
  ${scopeLabel ? `<div class="scope-label">${scopeLabel}</div>` : ''}
</div>
<div id="wrap">
  <div id="sponsor"></div>
  <div id="players">
    <div class="pcell" id="bat1">
      <div class="ptag">Bat</div>
      <div class="pname"></div>
      <div class="pfig"></div>
    </div>
    <div class="pcell" id="bat2">
      <div class="ptag">Bat</div>
      <div class="pname"></div>
      <div class="pfig"></div>
    </div>
    <div class="pcell bowler" id="bwl">
      <div class="ptag">Bowl</div>
      <div class="pname"></div>
      <div class="pfig"></div>
    </div>
  </div>
  <div id="lastout">
    <span class="out-tag">Out</span>
    <span class="out-detail"></span>
  </div>
  <div id="partnership"></div>
  <div id="balls">
    <span class="label">This over</span>
  </div>
  <div id="bar">
    <div id="live-dot"></div>
    <div class="team" id="teamA">
      <div class="accent"></div>
      <img class="crest" alt="" />
      <div class="name"></div>
      <div class="score"></div>
    </div>
    <div class="team" id="teamB">
      <div class="accent"></div>
      <img class="crest" alt="" />
      <div class="name"></div>
      <div class="score"></div>
    </div>
    <div class="meta">
      <div class="overs"></div>
      <div class="overs-label">Overs</div>
      <div class="rates" hidden>
        <span class="rr">RR<b id="rrVal">0.00</b></span>
        <span class="req" hidden>REQ<b id="reqVal">0.00</b></span>
      </div>
      <div class="target" hidden></div>
      <div class="statuschip" id="statuschip"></div>
    </div>
  </div>
</div>
<script>
  (function(){
    var MATCH_ID = ${JSON.stringify(safeId)};
    var qs = window.location.search || '';
    var BRAND_LOGO = ${JSON.stringify(BRAND_LOGO_DATA_URI)};
    var BRAND_MASCOT = ${JSON.stringify(BRAND_MASCOT_DATA_URI)};
    var brandLogoEl = document.querySelector('#brand .brand-logo');
    var brandMascotEl = document.querySelector('#brand .brand-mascot');
    if (BRAND_LOGO) brandLogoEl.src = BRAND_LOGO; else brandLogoEl.style.display = 'none';
    if (BRAND_MASCOT) brandMascotEl.src = BRAND_MASCOT; else brandMascotEl.style.display = 'none';
    var BRANDING = ${brandingJson};
    var wrap = document.getElementById('wrap');
    var players = document.getElementById('players');
    var bat1 = document.getElementById('bat1');
    var bat2 = document.getElementById('bat2');
    var bwl = document.getElementById('bwl');
    var teamA = document.getElementById('teamA');
    var teamB = document.getElementById('teamB');
    var nameA = teamA.querySelector('.name');
    var scoreA = teamA.querySelector('.score');
    var nameB = teamB.querySelector('.name');
    var scoreB = teamB.querySelector('.score');
    var oversEl = document.querySelector('.overs');
    var targetEl = document.querySelector('.target');
    var liveDot = document.getElementById('live-dot');
    var crestA = teamA.querySelector('.crest');
    var crestB = teamB.querySelector('.crest');
    var ballsEl = document.getElementById('balls');
    var partnershipEl = document.getElementById('partnership');
    var lastoutEl = document.getElementById('lastout');
    var lastoutDetail = lastoutEl.querySelector('.out-detail');
    var lastoutTimer = null;
    var statusChip = document.getElementById('statuschip');
    var ratesEl = document.querySelector('.rates');
    var rrVal = document.getElementById('rrVal');
    var reqWrap = document.querySelector('.rates .req');
    var reqVal = document.getElementById('reqVal');

    function teamBrandFor(name) {
      if (!name || !BRANDING || !BRANDING.teams) return null;
      var n = String(name).toLowerCase();
      var keys = Object.keys(BRANDING.teams);
      for (var i = 0; i < keys.length; i++) {
        if (n.indexOf(keys[i].toLowerCase()) !== -1) return BRANDING.teams[keys[i]];
      }
      return null;
    }
    function setCrest(el, name) {
      var brand = teamBrandFor(name);
      if (brand && brand.crestUrl) {
        el.src = brand.crestUrl;
        el.classList.add('show');
      } else {
        el.removeAttribute('src');
        el.classList.remove('show');
      }
    }
    function applyTeamColour(teamEl, name, isBatting) {
      var accentEl = teamEl.querySelector('.accent');
      var brand = teamBrandFor(name);
      var primary = brand && brand.primary;
      if (isBatting && primary) {
        accentEl.style.background = 'linear-gradient(180deg, ' + primary + ', ' + primary + ')';
        accentEl.style.boxShadow = '0 0 14px ' + primary + '66';
      } else {
        accentEl.style.background = '';
        accentEl.style.boxShadow = '';
      }
    }

    function oversToDecimal(s) {
      if (!s) return 0;
      var parts = String(s).split('.');
      var ov = parseInt(parts[0], 10) || 0;
      var bl = parseInt(parts[1] || '0', 10) || 0;
      return ov + (bl / 6);
    }

    function renderBalls(arr) {
      // Wipe existing dot children, keep the label
      var children = ballsEl.querySelectorAll('.dot');
      for (var i = 0; i < children.length; i++) ballsEl.removeChild(children[i]);
      if (!arr || !arr.length) { ballsEl.classList.remove('show'); return; }
      ballsEl.classList.add('show');
      arr.forEach(function(b) {
        var d = document.createElement('span');
        d.className = 'dot';
        if (b.isWicket) { d.classList.add('wicket'); d.textContent = 'W'; }
        else if (b.isSix) { d.classList.add('six'); d.textContent = '6'; }
        else if (b.isFour) { d.classList.add('four'); d.textContent = '4'; }
        else if ((b.runs|0) === 0 && !b.isWide && !b.isNoBall) { d.classList.add('zero'); d.textContent = '•'; }
        else { d.classList.add('one'); d.textContent = String(b.runs|0); }
        if (b.isWide) { d.classList.add('extra'); d.textContent = (b.runs|0) + 'wd'; }
        else if (b.isNoBall) { d.classList.add('extra'); d.textContent = (b.runs|0) + 'nb'; }
        ballsEl.appendChild(d);
      });
    }

    var prev = {
      runs: null, wickets: null,
      b1Runs: null, b2Runs: null,
      b1Milestone: 0, b2Milestone: 0,
      bwlWkts: null,
      seenFirst: false,
    };
    var flashEl = document.getElementById('flash');
    var flashHeadline = flashEl.querySelector('.flash-headline');
    var flashSub = flashEl.querySelector('.flash-sub');
    var flashTimer = null;
    var flashQueue = [];
    var flashing = false;

    function runFlash(kind, headline, sub, durationMs) {
      flashEl.classList.remove('wicket', 'milestone');
      if (kind) flashEl.classList.add(kind);
      flashHeadline.textContent = headline;
      flashSub.textContent = sub || '';
      void flashEl.offsetWidth;
      flashEl.classList.add('show');
      flashing = true;
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(function(){
        flashEl.classList.remove('show');
        setTimeout(function(){
          flashing = false;
          if (flashQueue.length) {
            var n = flashQueue.shift();
            runFlash(n.kind, n.headline, n.sub, n.duration);
          }
        }, 280);
      }, durationMs);
    }
    function flash(kind, headline, sub, durationMs) {
      if (flashing) { flashQueue.push({ kind: kind, headline: headline, sub: sub, duration: durationMs }); return; }
      runFlash(kind, headline, sub, durationMs);
    }

    function milestoneFor(runs) {
      if (runs >= 100) return 100;
      if (runs >= 50) return 50;
      return 0;
    }

    function bump(el) {
      if (!el) return;
      el.classList.remove('bump');
      void el.offsetWidth; // restart animation
      el.classList.add('bump');
      setTimeout(function(){ el.classList.remove('bump'); }, 220);
    }

    function fmtScore(runs, wickets) { return runs + '/' + wickets; }

    function setBatter(cell, b, prevRunsKey) {
      var nameEl = cell.querySelector('.pname');
      var figEl = cell.querySelector('.pfig');
      if (!b) {
        nameEl.textContent = '';
        figEl.textContent = '';
        nameEl.classList.remove('strike');
        return;
      }
      var changed = prev[prevRunsKey] != null && b.runs > prev[prevRunsKey];
      nameEl.textContent = b.name || '';
      nameEl.classList.toggle('strike', !!b.onStrike);
      figEl.innerHTML = (b.runs|0) + '<span class="small">(' + (b.balls|0) + ')</span>';
      if (changed) bump(figEl);
      prev[prevRunsKey] = b.runs;
    }

    function setBowler(cell, b) {
      var nameEl = cell.querySelector('.pname');
      var figEl = cell.querySelector('.pfig');
      if (!b) {
        nameEl.textContent = '';
        figEl.textContent = '';
        return;
      }
      var changed = prev.bwlWkts != null && b.wickets > prev.bwlWkts;
      nameEl.textContent = b.name || '';
      figEl.innerHTML = (b.wickets|0) + '/' + (b.runs|0) + '<span class="small">(' + (b.overs || '0.0') + ')</span>';
      if (changed) bump(figEl);
      prev.bwlWkts = b.wickets;
    }

    function render(d) {
      if (!d || !d.battingTeam) return;

      // Detect events vs previous frame BEFORE we mutate prev.* below.
      var wicketFell = prev.seenFirst && prev.wickets != null && d.wickets > prev.wickets;
      if (wicketFell) {
        flash('wicket', 'WICKET!', d.bowlingTeam || '', 5000);
      }

      nameA.textContent = d.battingTeam || '';
      setCrest(crestA, d.battingTeam);
      applyTeamColour(teamA, d.battingTeam, true);
      var runsChanged = prev.runs != null && d.runs > prev.runs;
      scoreA.textContent = fmtScore(d.runs|0, d.wickets|0);
      if (runsChanged) bump(scoreA);
      prev.runs = d.runs;
      prev.wickets = d.wickets;

      nameB.textContent = d.bowlingTeam || '';
      setCrest(crestB, d.bowlingTeam);
      applyTeamColour(teamB, d.bowlingTeam, false);
      scoreB.textContent = '';
      teamA.classList.add('batting'); teamA.classList.remove('bowling');
      teamB.classList.add('bowling'); teamB.classList.remove('batting');
      oversEl.textContent = d.overs || '0.0';
      if (d.innings === 2 && typeof d.target === 'number') {
        targetEl.hidden = false;
        targetEl.textContent = 'Target ' + d.target;
      } else {
        targetEl.hidden = true;
        targetEl.textContent = '';
      }

      // Run rate / required rate
      var oversDecimal = oversToDecimal(d.overs);
      var rr = oversDecimal > 0 ? (d.runs / oversDecimal) : 0;
      var showRates = oversDecimal > 0;
      if (showRates) {
        ratesEl.hidden = false;
        rrVal.textContent = ' ' + rr.toFixed(2);
        if (d.innings === 2 && typeof d.target === 'number' && typeof d.oversTotal === 'number') {
          var oversLeft = Math.max(0, d.oversTotal - oversDecimal);
          var runsNeeded = Math.max(0, d.target - d.runs);
          var req = oversLeft > 0 ? (runsNeeded / oversLeft) : 0;
          reqWrap.hidden = false;
          reqVal.textContent = ' ' + req.toFixed(2);
        } else {
          reqWrap.hidden = true;
        }
      } else {
        ratesEl.hidden = true;
      }

      var hasPlayers = (d.batters && d.batters.length) || d.bowler;
      if (hasPlayers) {
        setBatter(bat1, (d.batters && d.batters[0]) || null, 'b1Runs');
        setBatter(bat2, (d.batters && d.batters[1]) || null, 'b2Runs');
        setBowler(bwl, d.bowler || null);
        players.classList.add('show');

        // Milestone detection for batters (50 / 100). Uses the position-stable
        // batter[i] slot to track milestones — good enough for v1 since the
        // current pair stays in those slots until a wicket falls.
        if (prev.seenFirst && d.batters) {
          var b1 = d.batters[0];
          var b2 = d.batters[1];
          if (b1 && b1.runs != null) {
            var m1 = milestoneFor(b1.runs);
            if (m1 > prev.b1Milestone) {
              flash('milestone', m1.toString(), b1.name + ' — ' + b1.runs + ' off ' + (b1.balls|0), 4000);
              prev.b1Milestone = m1;
            }
          }
          if (b2 && b2.runs != null) {
            var m2 = milestoneFor(b2.runs);
            if (m2 > prev.b2Milestone) {
              flash('milestone', m2.toString(), b2.name + ' — ' + b2.runs + ' off ' + (b2.balls|0), 4000);
              prev.b2Milestone = m2;
            }
          }
        } else if (d.batters) {
          // Initial seed — don't flash on first poll.
          if (d.batters[0]) prev.b1Milestone = milestoneFor(d.batters[0].runs || 0);
          if (d.batters[1]) prev.b2Milestone = milestoneFor(d.batters[1].runs || 0);
        }
      } else {
        players.classList.remove('show');
      }

      renderBalls(d.recentBalls);

      // Partnership + powerplay row
      if (d.partnership || d.powerplay) {
        partnershipEl.classList.add('show');
        var bits = [];
        if (d.partnership) bits.push('P\\'ship<b>' + (d.partnership.runs|0) + ' (' + (d.partnership.balls|0) + ')</b>');
        if (d.powerplay) bits.push('<span class="pp-tag">' + d.powerplay + '</span>');
        partnershipEl.innerHTML = bits.join('<span style="color:#444">·</span>');
      } else {
        partnershipEl.classList.remove('show');
      }

      // Last dismissal ribbon — show for 30s after a wicket
      if (wicketFell && d.lastDismissal) {
        var ld = d.lastDismissal;
        lastoutDetail.textContent = ld.batter + ' ' + (ld.runs|0) + ' (' + (ld.balls|0) + ') ' + (ld.dismissalText || '');
        lastoutEl.classList.add('show');
        if (lastoutTimer) clearTimeout(lastoutTimer);
        lastoutTimer = setTimeout(function(){ lastoutEl.classList.remove('show'); }, 30000);
      }

      liveDot.classList.toggle('live', d.status === 'live');

      // Status chip — hidden for unknown / live (covered by the dot).
      var labels = {
        finished: 'Stumps',
        abandoned: 'Abandoned',
        no_result: 'No Result',
        drawn: 'Drawn',
        break: 'Break',
      };
      var chipKey = d.status && labels[d.status] ? d.status : null;
      statusChip.className = 'statuschip';
      if (chipKey) {
        statusChip.classList.add('show');
        statusChip.classList.add(chipKey);
        statusChip.textContent = labels[chipKey];
      }

      wrap.classList.add('ready');
      prev.seenFirst = true;
    }

    // Sponsor rotation
    (function initSponsors(){
      var el = document.getElementById('sponsor');
      var sponsors = (BRANDING && BRANDING.sponsors) || [];
      if (!sponsors.length) return;
      el.classList.add('show');
      var idx = 0;
      function show() {
        var s = sponsors[idx % sponsors.length];
        var html = '<div class="item active"><span class="label">In association with</span>';
        if (s.imageUrl) html += '<img src="' + s.imageUrl + '" alt="" />';
        html += '<span class="name">' + (s.name || '') + '</span>';
        if (s.text) html += '<span class="label" style="letter-spacing:0.18em;color:#aaa">' + s.text + '</span>';
        html += '</div>';
        el.innerHTML = html;
        idx++;
        setTimeout(show, s.durationMs || 12000);
      }
      show();
    })();

    async function poll() {
      try {
        var res = await fetch('/api/score/' + encodeURIComponent(MATCH_ID) + qs, { cache: 'no-store' });
        var data = await res.json();
        render(data);
      } catch (e) { /* keep last render */ }
      setTimeout(poll, 10000);
    }
    poll();
  })();
</script>
</body>
</html>`;
}

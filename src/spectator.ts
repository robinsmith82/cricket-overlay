const SCOPE_LABELS: Record<string, string> = {
  '3s': '3rd XI',
  '4s': '4th XI',
};

export function renderSpectator(matchId: string, scope = ''): string {
  const safeId = matchId.replace(/[^a-zA-Z0-9_-]/g, '');
  const scopeLabel = SCOPE_LABELS[scope] ?? '';
  const isMock = matchId === 'test' || matchId === 'mock';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#0e1116" />
<title>Live · Cricket</title>
<style>
  :root {
    --bg: #0e1116;
    --panel: #161a22;
    --panel-2: #1c2230;
    --border: #232a35;
    --accent: #ffd23a;
    --accent-warm: #ffb300;
    --text: #e8eaed;
    --muted: #8a93a4;
    --good: #3ddc84;
    --bad: #ff4d6d;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
  body {
    font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    padding-bottom: env(safe-area-inset-bottom);
  }

  header {
    padding: 14px 16px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  header .scope {
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--accent);
    font-weight: 800;
  }
  header .live-pill {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--muted);
  }
  header .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--good); box-shadow: 0 0 8px var(--good); }
  header .dot.stale { background: var(--bad); box-shadow: 0 0 8px var(--bad); }

  main { max-width: 640px; margin: 0 auto; padding: 0 16px 24px; }

  .scoreboard {
    background: linear-gradient(180deg, var(--panel) 0%, var(--panel-2) 100%);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px 18px 14px;
    margin: 16px 0;
  }
  .teams { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .teams .batting { font-weight: 800; font-size: 15px; }
  .teams .vs { color: var(--muted); font-size: 13px; }
  .teams .bowling { color: var(--muted); font-size: 14px; }

  .score-line {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-top: 10px;
    flex-wrap: wrap;
  }
  .runs { font-size: 38px; font-weight: 800; line-height: 1; letter-spacing: -0.02em; }
  .wkts { font-size: 22px; color: var(--muted); }
  .overs {
    margin-left: auto;
    color: var(--muted);
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }

  .meta-line { margin-top: 10px; color: var(--muted); font-size: 13px; display: flex; gap: 14px; flex-wrap: wrap; }
  .meta-line .chip {
    background: rgba(255, 210, 58, 0.08);
    color: var(--accent);
    padding: 3px 9px;
    border-radius: 3px;
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .pair {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 12px;
  }
  .pair h3 { margin: 0 0 10px; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
  .player {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 12px;
    padding: 6px 0;
    align-items: baseline;
  }
  .player .name { font-weight: 700; }
  .player .name.striker::after { content: ' *'; color: var(--accent); }
  .player .runs-cell { font-weight: 700; font-variant-numeric: tabular-nums; }
  .player .balls { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }

  .recent {
    display: flex;
    gap: 6px;
    margin-top: 12px;
    flex-wrap: wrap;
  }
  .ball {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px; height: 28px;
    border-radius: 14px;
    background: #2a3140;
    color: #e8eaed;
    font-size: 12px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .ball.dot { background: #2a3140; color: #8a93a4; }
  .ball.four { background: #4189ff; color: #fff; }
  .ball.six { background: #ff4d9b; color: #fff; }
  .ball.wkt { background: #ff4d6d; color: #fff; }
  .ball.wide, .ball.nb { background: #444a55; color: #ffd23a; font-size: 11px; }

  .commentary {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
  }
  .commentary h3 { margin: 0 0 10px; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
  .feed { display: flex; flex-direction: column-reverse; gap: 10px; }
  .feed .entry {
    border-left: 3px solid var(--border);
    padding: 4px 0 4px 12px;
    color: var(--text);
    font-size: 14px;
  }
  .feed .entry .over {
    color: var(--muted);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-right: 8px;
    font-variant-numeric: tabular-nums;
  }
  .feed .entry.four { border-left-color: #4189ff; }
  .feed .entry.four .text { color: #4189ff; font-weight: 700; }
  .feed .entry.six { border-left-color: #ff4d9b; }
  .feed .entry.six .text { color: #ff4d9b; font-weight: 700; }
  .feed .entry.wkt { border-left-color: #ff4d6d; }
  .feed .entry.wkt .text { color: #ff4d6d; font-weight: 700; }

  .footer {
    text-align: center;
    margin-top: 20px;
    color: var(--muted);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .empty {
    padding: 40px 20px;
    text-align: center;
    color: var(--muted);
  }
  .empty h2 { margin: 0 0 8px; font-size: 16px; color: var(--text); }

  .clips {
    display: flex; gap: 8px; overflow-x: auto;
    padding: 4px 0 8px; margin-top: 12px;
    -webkit-overflow-scrolling: touch;
  }
  .clip {
    flex: 0 0 auto;
    text-decoration: none; color: inherit;
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 8px; padding: 8px 12px;
    font-size: 12px; font-weight: 700;
    display: inline-flex; align-items: center; gap: 6px;
    transition: transform .12s ease, border-color .12s ease;
  }
  .clip:hover { transform: translateY(-1px); border-color: var(--accent); }
  .clip .kind { padding: 2px 6px; border-radius: 3px; font-size: 10px; letter-spacing: 0.08em; }
  .clip.wkt .kind { background: rgba(255,77,109,0.14); color: var(--bad); }
  .clip.four .kind { background: rgba(65,137,255,0.14); color: #4189ff; }
  .clip.six .kind { background: rgba(255,77,155,0.14); color: #ff4d9b; }
  .clip.fifty .kind, .clip.hundred .kind { background: rgba(255,210,58,0.14); color: var(--accent); }
  .clip .meta { color: var(--muted); font-weight: 500; font-size: 11px; }
  .clip .play { color: var(--accent); }

  .clip-wrap {
    flex: 0 0 auto;
    display: flex; flex-direction: column; gap: 6px;
  }
  .clip-wrap .clip { width: 100%; }
  .vibes {
    display: flex; gap: 4px; flex-wrap: nowrap;
  }
  .vibe-btn {
    flex: 0 0 auto;
    background: var(--panel-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 6px;
    padding: 4px 7px;
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    display: inline-flex; align-items: center; gap: 4px;
    font-variant-numeric: tabular-nums;
    transition: transform .1s ease, border-color .12s ease, background .12s ease;
  }
  .vibe-btn:hover { border-color: var(--accent); }
  .vibe-btn:active { transform: scale(0.94); }
  .vibe-btn[disabled] { opacity: 0.55; cursor: default; }
  .vibe-btn .vc { color: var(--muted); font-weight: 700; font-size: 11px; }
  .vibe-btn.has .vc { color: var(--accent); }

  .wheel-card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; padding: 14px 16px; margin-top: 12px;
    display: flex; align-items: center; gap: 14px;
  }
  .wheel-card h3 { margin: 0 0 6px; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
  .wheel-card svg { width: 160px; height: 160px; flex: 0 0 auto; }
  .wheel-card .summary { font-size: 13px; color: var(--text); }
  .wheel-card .summary .total { font-size: 22px; font-weight: 800; color: var(--accent); display: block; }
  .wheel-card .summary .breakdown { color: var(--muted); margin-top: 4px; }
  @media (max-width: 480px) {
    .wheel-card { flex-direction: column; align-items: stretch; }
    .wheel-card svg { width: 200px; height: 200px; margin: 0 auto; }
    .wheel-card .summary { text-align: center; }
  }
</style>
</head>
<body>
<header>
  <span class="scope">Cricket${scopeLabel ? ' · ' + escapeHtml(scopeLabel) : ''}</span>
  <span class="live-pill"><span class="dot" id="livedot"></span><span id="livetxt">live</span></span>
</header>
<main>
  <div id="root"><div class="empty"><h2>Loading…</h2><p>Fetching the score.</p></div></div>
  <p class="footer">Auto-refreshes every 10s · Pull to refresh</p>
</main>
<script>
(function(){
  var MATCH_ID = ${JSON.stringify(safeId)};
  var IS_MOCK = ${JSON.stringify(isMock)};
  var SCOPE = ${JSON.stringify(scope)};
  var POLL_MS = 10000;
  var feed = [];      // {key, over, type, text}
  var seenBalls = []; // last seen recentBalls signature, to detect new entries
  var maxFeed = 30;
  var lastWheelTotal = -1;
  var lastWheelLastTaggedAt = -1;
  var ZONE_LABELS = ['Dot','Straight','Cover','Point','Third','Fine','Fine leg','Sq leg','Midwicket'];
  var VIBE_EMOJIS = ['🔥','😮','🎯','👏','😂'];
  var vibeMap = {};       // "i:o.b" → emoji → count (server snapshot + optimistic bumps)
  var vibeDisabled = {};  // ballKey + '|' + emoji → timeout id (disabled until cleared)
  var lastEventsPayload = null; // re-render clips when vibes update

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c){
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
  }

  function ballClass(b) {
    if (b.isWicket) return 'wkt';
    if (b.isSix) return 'six';
    if (b.isFour) return 'four';
    if (b.isWide) return 'wide';
    if (b.isNoBall) return 'nb';
    if (b.runs === 0) return 'dot';
    return '';
  }
  function ballLabel(b) {
    if (b.isWicket) return 'W';
    if (b.isWide) return 'wd';
    if (b.isNoBall) return 'nb';
    return String(b.runs || 0);
  }

  // Templated commentary — variety via deterministic hash on the over+ball+runs.
  var DOT_VERBS = ['blocked back', 'left alone', 'defended', 'beaten outside off', 'pushed back', 'no run, played to the off'];
  var ONE_VERBS = ['worked off the hip', 'pushed into the gap', 'tucked round the corner', 'dabbed to third', 'driven for a single', 'nudged to mid-on'];
  var TWO_VERBS = ['well run, two', 'placed into the gap, comes back for two', 'worked into the leg side, two', 'driven to deep cover, two'];
  var THREE_VERBS = ['into the gap, three!', 'three runs, well placed', 'driven down the ground, three'];
  function pick(arr, seed) { return arr[Math.abs(seed) % arr.length]; }
  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h<<5)+h) + s.charCodeAt(i);
    return h;
  }

  function commentaryFor(b, over, batter, bowler) {
    var seed = hashStr((over||'') + '_' + (b.runs||0) + '_' + (batter||'') + '_' + (bowler||''));
    var who = (bowler && batter) ? (bowler + ' to ' + batter + ', ') : '';
    if (b.isWicket) return { type:'wkt', text: 'WICKET! ' + (batter || 'Batter') + ' is out — ' + (bowler ? bowler + ' strikes.' : '') };
    if (b.isSix)  return { type:'six',  text: 'SIX! ' + who + 'launched over the rope.' };
    if (b.isFour) return { type:'four', text: 'FOUR! ' + who + 'cracked through the field.' };
    if (b.isWide) return { type:'wd',   text: 'Wide. ' + (bowler || '') + ' down the leg side.' };
    if (b.isNoBall) return { type:'nb', text: 'No-ball. ' + (bowler || '') + ' overstepped.' };
    if (b.runs === 0) return { type:'',  text: who + pick(DOT_VERBS, seed) + '.' };
    if (b.runs === 1) return { type:'',  text: who + pick(ONE_VERBS, seed) + '.' };
    if (b.runs === 2) return { type:'',  text: who + pick(TWO_VERBS, seed) + '.' };
    if (b.runs === 3) return { type:'',  text: who + pick(THREE_VERBS, seed) + '.' };
    return { type:'', text: who + b.runs + ' runs.' };
  }

  function ballSig(b) {
    return [b.runs||0, b.isWicket?1:0, b.isFour?1:0, b.isSix?1:0, b.isWide?1:0, b.isNoBall?1:0].join(',');
  }
  function diffBalls(prev, next) {
    if (!prev || !prev.length) return next.slice();
    var ps = prev.map(ballSig).join('|');
    var ns = next.map(ballSig).join('|');
    if (ps === ns) return [];
    // Heuristic: assume next has at most one new ball (recentBalls is a 6-window sliding tail).
    // Take the last ball of next if it differs from the last ball of prev — good enough for live.
    var lastP = prev[prev.length-1];
    var lastN = next[next.length-1];
    if (!lastP || ballSig(lastP) !== ballSig(lastN)) return [lastN];
    return [];
  }

  function appendFeed(entry) {
    feed.unshift(entry);
    if (feed.length > maxFeed) feed.length = maxFeed;
  }

  function render(score) {
    var dot = document.getElementById('livedot');
    var txt = document.getElementById('livetxt');
    if (score.stale || score.error) { dot.classList.add('stale'); txt.textContent = score.error ? 'error' : 'stale'; }
    else { dot.classList.remove('stale'); txt.textContent = 'live'; }

    var root = document.getElementById('root');
    var batters = score.batters || [];
    var bowler = score.bowler;
    var recent = score.recentBalls || [];
    var newBalls = diffBalls(seenBalls, recent);
    seenBalls = recent;

    // Initial seed: if feed empty, render the recent window in chronological order.
    if (feed.length === 0 && recent.length) {
      var striker = batters[0] && batters[0].name;
      for (var i = 0; i < recent.length; i++) {
        var c = commentaryFor(recent[i], score.overs, striker, bowler && bowler.name);
        appendFeed({ over: score.overs, type: c.type, text: c.text });
      }
    } else {
      for (var j = 0; j < newBalls.length; j++) {
        var st = batters[0] && batters[0].name;
        var bl = bowler && bowler.name;
        var cc = commentaryFor(newBalls[j], score.overs, st, bl);
        appendFeed({ over: score.overs, type: cc.type, text: cc.text });
      }
    }

    var html = '';
    html += '<section class="scoreboard">';
    html += '<div class="teams"><span class="batting">' + escapeHtml(score.battingTeam || 'Batting') + '</span>';
    html += '<span class="vs">v</span><span class="bowling">' + escapeHtml(score.bowlingTeam || '') + '</span></div>';
    html += '<div class="score-line">';
    html += '<span class="runs">' + (score.runs|0) + '</span><span class="wkts">/' + (score.wickets|0) + '</span>';
    html += '<span class="overs">' + escapeHtml(score.overs || '0.0');
    if (score.oversTotal) html += ' / ' + score.oversTotal;
    html += '</span></div>';
    html += '<div class="meta-line">';
    if (score.target) {
      var need = score.target - (score.runs|0);
      html += '<span>Target ' + score.target + ' · need ' + Math.max(0, need) + '</span>';
    }
    if (score.partnership) html += '<span>Partnership ' + score.partnership.runs + ' (' + score.partnership.balls + ')</span>';
    if (score.powerplay) html += '<span class="chip">' + score.powerplay + '</span>';
    if (score.status && score.status !== 'live') html += '<span class="chip">' + score.status + '</span>';
    html += '</div>';
    if (recent.length) {
      html += '<div class="recent">';
      for (var k = 0; k < recent.length; k++) {
        var b = recent[k];
        html += '<span class="ball ' + ballClass(b) + '">' + ballLabel(b) + '</span>';
      }
      html += '</div>';
    }
    html += '<div class="clips" id="clips"></div>';
    html += '</section>';

    html += '<div id="wheel-host"></div>';

    if (batters.length) {
      html += '<section class="pair"><h3>At the crease</h3>';
      for (var p = 0; p < batters.length; p++) {
        var bt = batters[p];
        html += '<div class="player"><span class="name' + (bt.onStrike ? ' striker' : '') + '">' + escapeHtml(bt.name || '') + '</span>';
        html += '<span class="runs-cell">' + (bt.runs|0) + '</span><span class="balls">(' + (bt.balls|0) + ')</span></div>';
      }
      if (bowler) {
        html += '<div class="player" style="margin-top:8px;border-top:1px solid var(--border);padding-top:10px">';
        html += '<span class="name" style="color:var(--muted);font-weight:600">' + escapeHtml(bowler.name || '') + '</span>';
        html += '<span class="runs-cell">' + (bowler.wickets|0) + '/' + (bowler.runs|0) + '</span>';
        html += '<span class="balls">(' + escapeHtml(bowler.overs || '0.0') + ')</span></div>';
      }
      html += '</section>';
    }

    html += '<section class="commentary"><h3>Ball by ball</h3><div class="feed">';
    if (feed.length === 0) {
      html += '<div class="entry"><span class="text">Waiting for the next delivery…</span></div>';
    } else {
      for (var f = 0; f < feed.length; f++) {
        var e = feed[f];
        html += '<div class="entry ' + (e.type || '') + '"><span class="over">' + escapeHtml(e.over || '') + '</span><span class="text">' + escapeHtml(e.text) + '</span></div>';
      }
    }
    html += '</div></section>';

    root.innerHTML = html;
  }

  // ------- per-ball deep-link strip ------------------------------------
  function eventTitle(e) {
    if (e.type === 'wicket') return 'WICKET';
    if (e.type === '4') return 'FOUR';
    if (e.type === '6') return 'SIX';
    if (e.type === 'fifty') return 'FIFTY';
    if (e.type === 'hundred') return '100';
    if (e.type === 'team-milestone') return 'TEAM ' + (e.runs || '');
    return e.type.toUpperCase();
  }
  function eventClass(e) {
    if (e.type === 'wicket') return 'wkt';
    if (e.type === '4') return 'four';
    if (e.type === '6') return 'six';
    if (e.type === 'fifty') return 'fifty';
    if (e.type === 'hundred') return 'hundred';
    return '';
  }
  function ballKeyForEvent(e) {
    // event.over is a string like "14.3"; key is "innings:over.ball"
    var inn = (e.innings != null) ? e.innings : 1;
    return inn + ':' + (e.over || '');
  }
  function parseOverBall(overStr) {
    var s = String(overStr || '');
    var dot = s.indexOf('.');
    if (dot < 0) return null;
    var o = parseInt(s.slice(0, dot), 10);
    var b = parseInt(s.slice(dot + 1), 10);
    if (isNaN(o) || isNaN(b)) return null;
    return { over: o, ball: b };
  }
  function vibesRowHtml(e) {
    var key = ballKeyForEvent(e);
    var counts = vibeMap[key] || {};
    var html = '<div class="vibes" data-vibe-key="' + escapeHtml(key) + '">';
    for (var i = 0; i < VIBE_EMOJIS.length; i++) {
      var em = VIBE_EMOJIS[i];
      var c = counts[em] || 0;
      var disabledKey = key + '|' + em;
      var dis = vibeDisabled[disabledKey] ? ' disabled' : '';
      html += '<button type="button" class="vibe-btn' + (c ? ' has' : '') + '"' + dis +
        ' data-emoji="' + escapeHtml(em) + '"' +
        ' data-ball-key="' + escapeHtml(key) + '">' +
        '<span class="ve">' + em + '</span><span class="vc">' + c + '</span></button>';
    }
    html += '</div>';
    return html;
  }
  function renderClips(payload) {
    var host = $('clips');
    if (!host) return;
    if (payload) lastEventsPayload = payload;
    var src = lastEventsPayload || { events: [] };
    var events = src.events || [];
    var youtube = src.youtube;
    if (!events.length) { host.style.display = 'none'; return; }
    host.style.display = '';
    var last = events.slice(-6).reverse();
    var html = '';
    for (var i = 0; i < last.length; i++) {
      var e = last[i];
      var idx = events.length - 1 - i; // original index for clip route
      var who = e.batter || (e.type === 'team-milestone' ? '' : 'Batter');
      var clipHtml = '';
      if (youtube) {
        var off = Math.max(0, Math.floor((e.ts - youtube.startedAt) / 1000));
        var href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(youtube.videoId) + '&t=' + off + 's';
        clipHtml += '<a class="clip ' + eventClass(e) + '" href="' + href + '" target="_blank" rel="noopener">';
        clipHtml += '<span class="kind">' + eventTitle(e) + '</span>';
        clipHtml += '<span>' + escapeHtml(who) + '</span>';
        clipHtml += '<span class="meta">· ' + escapeHtml(e.over) + '</span>';
        clipHtml += '<span class="play">▶</span>';
        clipHtml += '</a>';
      } else {
        var clipPath = (SCOPE ? '/' + SCOPE : '') + '/embed/clip/' + encodeURIComponent(MATCH_ID) + '/' + idx;
        clipHtml += '<a class="clip ' + eventClass(e) + '" href="' + clipPath + '" target="_blank" rel="noopener">';
        clipHtml += '<span class="kind">' + eventTitle(e) + '</span>';
        clipHtml += '<span>' + escapeHtml(who) + '</span>';
        clipHtml += '<span class="meta">· ' + escapeHtml(e.over) + '</span>';
        clipHtml += '</a>';
      }
      html += '<div class="clip-wrap">' + clipHtml + vibesRowHtml(e) + '</div>';
    }
    host.innerHTML = html;
  }
  function fetchEvents() {
    if (IS_MOCK) return;
    var url = (SCOPE ? '/' + SCOPE : '') + '/api/events/' + encodeURIComponent(MATCH_ID);
    fetch(url, { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(p){ renderClips(p); }).catch(function(){});
  }

  // ------- vibe reactions ----------------------------------------------
  function fetchVibes() {
    if (IS_MOCK) { renderClips(null); return; }
    var url = (SCOPE ? '/' + SCOPE : '') + '/api/vibes/' + encodeURIComponent(MATCH_ID);
    fetch(url, { cache: 'no-store', credentials: 'same-origin' })
      .then(function(r){ return r.json(); })
      .then(function(p){
        vibeMap = (p && p.vibes) || {};
        renderClips(null);
      })
      .catch(function(){});
  }
  function handleVibeClick(ev) {
    var btn = ev.target;
    while (btn && btn !== document.body && (!btn.classList || !btn.classList.contains('vibe-btn'))) {
      btn = btn.parentNode;
    }
    if (!btn || !btn.classList || !btn.classList.contains('vibe-btn')) return;
    if (btn.disabled) return;
    var key = btn.getAttribute('data-ball-key');
    var emoji = btn.getAttribute('data-emoji');
    if (!key || !emoji) return;

    // Optimistic local increment
    vibeMap[key] = vibeMap[key] || {};
    vibeMap[key][emoji] = (vibeMap[key][emoji] || 0) + 1;
    var vc = btn.querySelector('.vc');
    if (vc) vc.textContent = vibeMap[key][emoji];
    btn.classList.add('has');

    // Disable for 600ms
    var disKey = key + '|' + emoji;
    btn.disabled = true;
    vibeDisabled[disKey] = setTimeout(function(){
      delete vibeDisabled[disKey];
      btn.disabled = false;
    }, 600);

    if (IS_MOCK) return; // mock: no-op POST

    var colon = key.indexOf(':');
    if (colon < 0) return;
    var innings = parseInt(key.slice(0, colon), 10);
    var ob = parseOverBall(key.slice(colon + 1));
    if (!ob || isNaN(innings)) return;
    var url = (SCOPE ? '/' + SCOPE : '') + '/api/vibe/' + encodeURIComponent(MATCH_ID) +
      '/' + innings + '/' + ob.over + '/' + ob.ball;
    fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: emoji }),
    }).catch(function(){});
  }
  document.addEventListener('click', handleVibeClick);

  // ------- live wagon wheel --------------------------------------------
  function buildWheelSvg(counts) {
    var size = 200, cx = size/2, cy = size/2, r = size/2 - 6, inner = size/8;
    var max = 1;
    for (var i = 1; i < 9; i++) if (counts[i] > max) max = counts[i];
    var startDeg = -22.5;
    var paths = '<text x="' + cx + '" y="14" text-anchor="middle" font-size="10" fill="#ffd23a" font-weight="700" letter-spacing="2">↑ BOWLER</text>';
    for (var w = 0; w < 8; w++) {
      var a0 = (startDeg + w * 45) * Math.PI / 180;
      var a1 = (startDeg + (w + 1) * 45) * Math.PI / 180;
      var x0 = cx + r * Math.sin(a0), y0 = cy - r * Math.cos(a0);
      var x1 = cx + r * Math.sin(a1), y1 = cy - r * Math.cos(a1);
      var c = counts[w + 1] || 0;
      var op = (0.18 + (c / max) * 0.72).toFixed(2);
      paths += '<path d="M' + cx + ' ' + cy + ' L' + x0.toFixed(2) + ' ' + y0.toFixed(2) +
        ' A' + r + ' ' + r + ' 0 0 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2) + ' Z"' +
        ' fill="#ffd23a" fill-opacity="' + op + '" stroke="#0e1116" stroke-width="1.5"/>';
    }
    var dotMax = Math.max(1, counts[0] || 0, max);
    var dotOp = (0.18 + ((counts[0] || 0) / dotMax) * 0.72).toFixed(2);
    paths += '<circle cx="' + cx + '" cy="' + cy + '" r="' + inner + '" fill="#8a93a4" fill-opacity="' + dotOp + '" stroke="#0e1116" stroke-width="1.5"/>';
    paths += '<text x="' + cx + '" y="' + (cy + 4) + '" text-anchor="middle" font-size="' + Math.round(inner * 0.55) + '" fill="#fff" font-weight="800">' + (counts[0] || '') + '</text>';
    return '<svg viewBox="0 0 ' + size + ' ' + size + '" xmlns="http://www.w3.org/2000/svg">' + paths + '</svg>';
  }
  function renderWheel(payload) {
    var host = $('wheel-host');
    if (!host) return;
    var counts = payload.counts || [];
    var total = payload.total || 0;
    if (!total) { host.innerHTML = ''; return; }
    if (total === lastWheelTotal && payload.lastTaggedAt === lastWheelLastTaggedAt) return;
    lastWheelTotal = total; lastWheelLastTaggedAt = payload.lastTaggedAt;
    var topZones = [];
    for (var i = 1; i < 9; i++) if (counts[i]) topZones.push([ZONE_LABELS[i], counts[i]]);
    topZones.sort(function(a,b){ return b[1]-a[1]; });
    var topShots = [];
    if (payload.shots) {
      var keys = Object.keys(payload.shots);
      for (var k = 0; k < keys.length; k++) topShots.push([keys[k], payload.shots[keys[k]]]);
      topShots.sort(function(a,b){ return b[1]-a[1]; });
    }
    var topZ = topZones.slice(0, 3).map(function(z){ return z[0] + ' ' + z[1]; }).join(' · ');
    var topS = topShots.slice(0, 3).map(function(s){ return s[0] + ' ' + s[1]; }).join(' · ');
    var html = '<div class="wheel-card">';
    html += buildWheelSvg(counts);
    html += '<div class="summary">';
    html += '<h3>Wagon wheel · live</h3>';
    html += '<span class="total">' + total + '<span style="font-size:13px;color:var(--muted);font-weight:600"> tagged</span></span>';
    if (topZ) html += '<div class="breakdown">' + escapeHtml(topZ) + '</div>';
    if (topS) html += '<div class="breakdown">' + escapeHtml(topS) + '</div>';
    html += '</div></div>';
    host.innerHTML = html;
  }
  function fetchTags() {
    if (IS_MOCK) return;
    var url = (SCOPE ? '/' + SCOPE : '') + '/api/tags/' + encodeURIComponent(MATCH_ID);
    fetch(url, { cache: 'no-store' }).then(function(r){ return r.json(); }).then(renderWheel).catch(function(){});
  }

  function fetchScore() {
    var url = '/api/score/' + encodeURIComponent(MATCH_ID) + (IS_MOCK ? '?mock=1' : '');
    fetch(url, { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(render)
      .catch(function(){
        var dot = document.getElementById('livedot');
        var txt = document.getElementById('livetxt');
        if (dot && txt) { dot.classList.add('stale'); txt.textContent = 'offline'; }
      });
  }

  fetchScore();
  fetchEvents();
  fetchTags();
  fetchVibes();
  setInterval(fetchScore, POLL_MS);
  setInterval(fetchEvents, POLL_MS);
  setInterval(fetchTags, POLL_MS);
  setInterval(fetchVibes, POLL_MS);
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

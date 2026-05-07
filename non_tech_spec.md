# Cricket Live-Stream Overlay — Plain English Spec

For a mate helping out who's comfortable with computers but doesn't write code.

## What we're trying to do

Stream your-club & MyClub 4th XI matches to YouTube, with a **proper TV-style scorebar** along the bottom showing the live score, like the BBC do for Test cricket. No hand-typing scores, no manual updates — the bar updates itself.

```
   ┌──────────────────────────────────────────────────────────┐
   │                                                          │
   │                                                          │
   │              [ live cricket video here ]                 │
   │                                                          │
   │                                                          │
   │ ──────────────────────────────────────────────────────── │
   │  YOUR CLUB CC            127/4  │  AWAY CC        —      │
   │                                  │                  14.2 │
   └──────────────────────────────────────────────────────────┘
                                                       Overs ↑
```

That bottom strip is what we're building. The video itself is just OBS pointing at a webcam (or eventually a fixed PTZ camera).

## How the bits fit together

```
                ┌────────────────────────┐
                │  Play-Cricket website  │
                │  (someone scoring on   │
                │   the iPad app)        │
                └───────────┬────────────┘
                            │
                            │  score data
                            │  (every few seconds)
                            ▼
                ┌────────────────────────┐
                │  Our little server     │
                │  on Cloudflare         │
                │  (free)                │
                └───────────┬────────────┘
                            │
                            │  serves a transparent
                            │  webpage with the
                            │  scorebar on it
                            ▼
                ┌────────────────────────┐
                │  OBS Studio on Mac     │
                │  (the streaming app)   │
                │                        │
                │  • Camera feed         │
                │  • Scorebar webpage    │
                │  ↓ stitched together   │
                └───────────┬────────────┘
                            │
                            │  RTMP video stream
                            ▼
                ┌────────────────────────┐
                │  YouTube Live          │
                │  (unlisted for now)    │
                └────────────────────────┘
```

Three moving parts:

1. **Play-Cricket** — already exists. Someone on the boundary scores the match in the official iPad app, which updates Play-Cricket's website live. We don't write any of that — we just read it.
2. **Our server** — a tiny program on Cloudflare's free tier. Job: fetch the score from Play-Cricket every ~10 seconds, and serve a **see-through webpage** with the scorebar drawn on it.
3. **OBS Studio** — the streaming app on the Mac. We tell it to layer the scorebar webpage **on top of** the camera feed. OBS sends the combined picture to YouTube.

The clever bit is step 2 + 3: because the scorebar is just a webpage with a transparent background, OBS treats it like a "browser source" and overlays it on the video. The webpage updates itself, OBS doesn't have to do anything special.

## What the user (you, on a phone, watching) sees

Open the YouTube link → see the match → see the scorebar across the bottom updating itself as runs go in. That's it.

## Build status as of today

```
   ✅ Cloudflare server built and deployed
        URL: https://<your-worker>.workers.dev
              (and https://<your-worker>.workers.dev as fallback)

   ✅ Scorebar webpage works against real Play-Cricket data
        Three concurrent overlays — default, 3rd XI, 4th XI — each with
        their own active match, sponsors, and team colours.

   ✅ Bells & whistles shipped
        Phone-friendly live page, wagon-wheel ball tagger, per-ball YouTube
        clip links, embeddable scorebar + clip iframes, share-cards per ball.
        See "what got built next" below.

   ✅ Crowdsourced tagging shipped
        The tagger is now open — anyone with the link can tag balls.
        Scorer keeps a 5× vote weight via a signed cookie. Per-IP rate
        limits stop spam. Auto-ranked highlight reel at /reel uses
        events + crowd reactions to surface top moments.

   ✅ Match-health dashboard shipped
        /admin/diagnose answers "is THIS match healthy right now?" —
        score freshness, fallback mode, data source, scrape errors —
        all colour-coded on one page that auto-refreshes.

   ✅ Mock-seed for demos
        One button in the admin page seeds a fake match (~30 events,
        ~80 tags, ~50 reactions) so highlights / summary / reel / share
        cards / clip embeds all light up without a live game. Useful
        for showing the project off, and for pre-match dry runs.

   🟡 OBS + YouTube end-to-end at a real match — DEPENDENT ON FIXTURE
        Software side proven. Camera + on-the-day workflow needs a live test.

   ✅ Audit trail / "is the API working?" check
        Every time the server fetches a score from Play-Cricket, one row
        gets appended to a little database. The admin page has a live-
        updating viewer. During a match you can glance at it and confirm
        the numbers are flowing — if they stop, you know it's broken
        before the YouTube viewers do. See "Knowing it's working" below.

   ✅ This spec lives on the live site
        https://<your-worker>.workers.dev/docs
        (so you can pull it up on a phone, no GitHub login needed)
```

## The snag

We assumed Play-Cricket's website would just give us the score in plain HTML. It doesn't — the score numbers arrive via a separate hidden API call that the website itself makes in the background, locked behind a sort of digital handshake.

Three ways round it:

```
   ┌──────────────────────────────────────────────────────────┐
   │ A. Get an official "API token" from Play-Cricket          │
   │    ───────────────────────────────────────                │
   │    Easiest, supported, robust.                            │
   │    Play-Cricket gives clubs a key on request.             │
   │    Status: waiting on our club admin to share theirs.     │
   │                                                           │
   │ B. Apply for a personal "commercial/non-profit" token     │
   │    ───────────────────────────────────────────            │
   │    Same idea, but issued by ECB centrally instead of      │
   │    by the club. Takes days/weeks to be reviewed.          │
   │                                                           │
   │ C. Mimic the website's own handshake                      │
   │    ───────────────────────────────────────                │
   │    Copy the digital handshake the Play-Cricket website    │
   │    does itself. Works without any token. Risk: they       │
   │    could change the handshake at any time and we'd have   │
   │    to re-do it. We're building this NOW as a fallback     │
   │    so we have something working while we wait on (A).     │
   └──────────────────────────────────────────────────────────┘
```

Plan: build (C) now so the pipeline works this weekend. When (A) lands, swap to it — same end result, more reliable.

## Hardware setup for streaming day

```
                              ┌──────────────┐
                              │ Person       │
                              │ scoring on   │
                              │ Play-Cricket │
                              │ iPad         │  (already exists,
                              └──────┬───────┘   nothing to do)
                                     │
                                     │ over Wi-Fi / 4G
                                     │
                                     ▼
                              [ Play-Cricket cloud ]
                                     │
                                     │ our server checks every 10s
                                     ▼
   ┌────────┐    ┌────────────────┐    ┌──────────────┐
   │ Mac    │◄───│ FaceTime cam   │    │ Phone        │
   │ OBS    │    │ (built-in for  │    │ watching     │
   │ Studio │    │ first test —   │    │ YouTube      │
   │        │    │ proper PTZ     │    │ Live         │
   │        │────►camera later)   │    └──────▲───────┘
   │        │    └────────────────┘           │
   └───┬────┘                                 │
       │                                      │
       │  upload over home Wi-Fi / 4G         │
       └──────────────────────────────────────┘
                  via YouTube Live
```

For the **first test** (this weekend):
- Mac in the kitchen / living room
- FaceTime camera (the one in the Mac lid) pointing at someone waving
- OBS sends to YouTube Unlisted
- Watch on a phone on the same Wi-Fi → confirm the bar appears with fake ticking numbers

For the **first real match** (next weekend, hopefully):
- Same Mac, same OBS, same software
- Swap FaceTime camera for an SV3C 36X PoE PTZ camera (already on order) plugged in via Ethernet
- Swap fake-numbers mode for real Play-Cricket match ID
- Stream goes out to YouTube as before

Importantly: the **software side doesn't change** between those two scenarios. Only the camera input and the URL of the scorebar.

## What success looks like

By Sunday evening, on a phone, watching the unlisted YouTube link:

```
   ✓ See the camera picture (face / kitchen / whatever)
   ✓ See the scorebar pinned along the bottom
   ✓ Numbers in the scorebar visibly tick up (in fake mode)
   ✓ Visit the same page with a real Play-Cricket match ID and
     see that match's final score correctly displayed
```

If those four boxes tick, the architecture is proven and we can spend money on the proper camera. If any one fails, the failure is obvious and points at exactly which bit is broken.

## What got built next ("NV Play but free")

Once the boring scorebar was reliable, the project grew into a proper club-cricket viewing toolkit. Roughly the goal: be like nvplay.com (the cricket video-analytics product) but on Cloudflare's free tier.

```
                ┌─────────────── What it now does ───────────────┐
                │                                                │
                │  Phone watching live    Scorer on the          │
                │  the match              boundary               │
                │       │                       │                │
                │       │ /live                 │ /tag           │
                │       ▼                       ▼                │
                │  ┌─────────────┐        ┌─────────────┐        │
                │  │ Live page   │        │ Wagon-wheel │        │
                │  │ scoreboard  │        │ ball tagger │        │
                │  │ + comm'tary │◄──────►│ + shot type │        │
                │  │ + WAGON     │ tags   │             │        │
                │  │   WHEEL     │        └─────────────┘        │
                │  │ + clip link │                               │
                │  │   strip     │                               │
                │  └──────┬──────┘                               │
                │         │ tap a wicket / boundary              │
                │         ▼                                      │
                │  ┌─────────────┐                               │
                │  │  YouTube,   │   one click jumps             │
                │  │  pre-cued   │   straight to that            │
                │  │  to that    │   exact second                │
                │  │  ball       │                               │
                │  └─────────────┘                               │
                │                                                │
                │  Plus: highlights page, summary page,          │
                │        embeddable scorebar, share cards.       │
                └────────────────────────────────────────────────┘
```

### The new pages, plain English

```
   /live           Phone-friendly live scoreboard. Auto-refreshes.
                   Shows: score, batters at the crease, bowler,
                   last 6 balls, simulated commentary feed, a
                   live wagon wheel, and the latest 6 highlight
                   moments as tappable links to the YouTube video.

   /highlights     Vertical list of every wicket/4/6/50/100 in
                   the match, each one tappable to jump to that
                   exact moment on YouTube.

   /summary        End-of-match recap. Big scoreline, "final state"
                   panel (the not-out pair, bowler, partnership, last
                   over with each ball colour-coded), top performers,
                   full wagon wheel, share-friendly meta tags so the
                   page previews nicely on WhatsApp. Add ?mock=1 to
                   preview the layout against fake numbers.

   /tag            (Scorer-only, key-protected.) Tap-to-tag
                   wagon-wheel UI. Pick the zone the ball went to,
                   then optionally tap a shot type chip
                   (drive, cut, pull, sweep, glance, defence,
                   edge, slog).

   /embed/score    A tiny scorebar iframe — for dropping into
                   the club website during match days.

   /embed/clip     The YouTube video embedded and pre-cued to
                   one specific ball. Shareable in WhatsApp.

   /share/…/N.svg  A share-card image per wicket/boundary —
                   "BOUNDARY · R. Smith · over 14.3" — for
                   posting in club groups or social.

   /admin/diagnose (Admin only.) One-page health check for a single
                   match: how fresh the cached score is, whether the
                   official Play-Cricket token or the fallback is being
                   used, whether ball-by-ball data is flowing, and
                   recent scrape rows. Auto-refreshes every 15 seconds.

   /admin/mock-seed (Admin only — a button on the admin page.) Writes
                   a fake match's worth of events, tags and reactions
                   so the live / highlights / summary / reel pages all
                   populate immediately. For demos and dry runs.
```

### Wagon wheel + shot type, in pictures

```
                    ↑ Bowler
              ┌───────────────┐
              │  Straight     │   The scorer (or anyone with the
              │       │       │   tagger link) taps which zone the
              │ Cover ┼ Mid'  │   ball went to: 8 wedges around
              │   ────●────   │   the crease, plus a "dot" centre.
              │ Point │ Sq leg│
              │       │       │   Optional second tap picks the
              │   Fine leg    │   shot type. Both stored against
              └───────────────┘   the ball.
                                  
               After tagging:
               ┌─────────────────────────────────────┐
               │  drive  cut  pull  sweep  glance    │
               │  defence  edge  slog                │
               └─────────────────────────────────────┘
```

Across a match the wedges accumulate. By the end, the wagon wheel on the summary page tells the story: did Smith really score everywhere, or was she leg-side only? The live page shows the wheel filling in real time as the scorer taps.

### Per-ball YouTube links — how

The admin pastes the YouTube live URL once, at the start. From that moment the system knows the wall-clock time the stream started. Every wicket / 4 / 6 the scrape detects gets stamped with the wall-clock time it happened. To deep-link a specific ball:

```
    YouTube jump time = (when the ball happened)
                      − (when the stream started)

    e.g. ball at 14:37:08, stream from 14:00:00
         → YouTube ?t=2228s  (37 mins 8 secs in)
```

Real life adds 10–60 seconds of lag (scorer types it, Play-Cricket publishes, we scrape, we detect). For the embedded clip page we cheat and rewind 3 seconds before the moment, so the viewer arrives just in time.

### Crowdsourced tagging — anyone can join in

The wagon-wheel tagger used to be scorer-only (a secret URL with a key). It's now **open**: anyone with the link can tag, no key required. Multiple people on the boundary can tag the same match in parallel and the system reconciles disagreements automatically.

```
                Multiple taggers, one match

      Scorer (J. Patel)            Spectator (K. Williams)
          on iPad                       on her phone
              │                              │
              │  taps "Cover"                │  taps "Mid-wicket"
              │  for ball 14.3               │  for ball 14.3
              ▼                              ▼
                ┌────────────────────────────┐
                │  Server records both votes │
                │                            │
                │   J: zone=Cover  weight=5  │
                │   K: zone=Mid-w  weight=1  │
                │                            │
                │   Consensus → Cover (5>1)  │
                └────────────────────────────┘
                              │
                              ▼
                  Wagon wheel shows "Cover"
```

**Scorer mode vs crowd mode:**
- The scorer URL still works — but now what it does is **issue a signed cookie** (5× vote weight) and redirect to the public URL. The badge in the header switches from `CROWD` to `SCORER ×5`. Their votes outweigh the crowd 5-to-1, but the crowd still influences ties and gets the score the moment the scorer hasn't tagged yet.
- Anyone else just opens `https://<your-worker>.workers.dev/3s/tag` cold. Their vote counts as 1.

**Anti-spam:**
- Per-IP rate limit: 2 taps/sec, 60/minute. Beyond that the API answers `429 Too Many Requests` and the tagger UI shows "rate-limited".
- Each device gets a long-lived voter cookie so re-voting on the same ball **replaces** their previous vote — repeatedly tapping the same wedge doesn't stack.

### Vibe reactions (the WhatsApp button moment)

A small fixed set of emoji counters per ball: 🔥 😮 🎯 👏 😂. There's an API for tapping reactions today; the spectator-page UI is a small follow-up. These also feed the **auto-ranked highlight reel** below — viral wickets bubble up on their own.

### Auto-ranked highlight reel

`https://<your-worker>.workers.dev/3s/reel` — top 12 moments of the match, ranked automatically.

```
   Score formula (per event):

   weight = base × type
                  + 0.5 × crowd reactions
                  + 0.25 × ball-tags

   where base × type:
     hundred       10
     wicket         6
     fifty          5
     six            4
     four           2
     team-milestone 1
```

So a wicket with 8 reactions and a few crowd-tags will rank above a routine four. A six everyone reacted to with 🔥🔥🔥🔥 will rank above a quiet wicket. The reel page is a grid of cards — each opens the YouTube clip embed cued to the right second; each has a "share card" link to the ball-specific image.

### How a club WhatsApp group might use it

```
   Sat 14:32 · J Patel:    [share-card image: Smith · SIX!]
   Sat 14:32 · J Patel:    https://<your-worker>.workers.dev/3s/embed/clip/123/4
   Sat 14:33 · K Williams: 🤯
   Sat 14:33 · A Mehta:    massive
   Sat 16:48 · J Patel:    [share-card image: 121/9 · Win by 14 runs]
   Sat 16:48 · J Patel:    https://<your-worker>.workers.dev/3s/summary/123
```

Every wicket and boundary becomes a one-tap-and-share moment, **without anyone editing video**. The video is just the YouTube live stream; the magic is "what second do we jump to" being computed automatically.

### Knowing it's working ("is the API alive?")

Every time the server reaches out to Play-Cricket for a fresh score, it writes a one-line entry to a small database. That gives a live audit trail you can eyeball at a glance during a match.

```
   /admin/logs?key=…    (also /3s/admin/logs, /4s/admin/logs)

    When     Match     Source         OK   Status   Score        Δ
   ─────────────────────────────────────────────────────────────────
    2s ago   7591652   play-cricket   ✓    live     127/4 (14.2) ●
    27s ago  7591652   play-cricket   ✓    live     127/4 (14.1) ·
    52s ago  7591652   play-cricket   ✓    live     127/4 (14.0) ·
    1m ago   7591652   play-cricket   ✓    live     126/4 (13.5) ●
    1m ago   7591652   play-cricket   ✓    live     126/4 (13.4) ·
   ─────────────────────────────────────────────────────────────────
                                                              ↑
                                              ● = score actually changed
                                              · = same as previous fetch
```

What to look for during a match:
- **Rows arriving every ~25 seconds.** If they stop, the server isn't being polled (or has lost connectivity). Visible long before YouTube viewers complain.
- **Source column says `play-cricket` (good) or `resultsvault` (the fallback).** If you've expected the official API token but it's stuck on `resultsvault`, the token has rotated or expired.
- **OK column with green ✓.** Red ✗ rows show the error message — wrong match ID, mapping missing, upstream returned 500, etc.
- **Δ column** — a yellow dot means the score changed since last fetch. Useful as a heartbeat: if you see lots of `·` and zero `●`, either the match is genuinely paused (drinks break) or scoring has stalled on Play-Cricket's side.

There's a "Auto-refresh (5s)" tickbox so you can leave it open on a second screen during a match.

**The match-health page** (`/admin/diagnose`) is the companion view. The logs page tells you "is the API alive at all?". The diagnose page tells you "is *this specific match* healthy right now?" — at a glance you see the freshness of the cached score, whether we're reading from the official Play-Cricket API or the fallback, whether ball-by-ball data is actually arriving (some matches are scored totals-only and won't have a recent-balls strip), and the last few scrape rows for context. Each check is green / amber / red so a glance tells you everything. It auto-refreshes every 15 seconds.

### Cost (still)

```
   Cloudflare server:    £0  (free tier, well under limits)
   Domain:               £0  (<your-worker>.workers.dev — already on Brand)
   YouTube streaming:    £0
   ───────────────────────────
   Software running:     £0/month
```

KV, D1 and Workers AI all have free quotas plenty big enough for a club-cricket workload. No paid tier in sight even with 4 matches a weekend.

## What we're NOT building (for now)

Held back until we have appetite/evidence:

```
   ✗ Multi-camera switching / replays
   ✗ Login / per-user accounts
   ✗ Multi-source rollout (the scope system is ready, but only Play-Cricket plumbed in)
   ✗ Player career stats across seasons (planned in Tier 3 of BACKLOG.md)
   ✗ AI auto-commentary / match reports (planned in Tier 5)
   ✗ Share cards as PNG (currently SVG — works inline, not in WhatsApp previews)
   ✗ Vibe-reaction buttons on the live page (the API is live; UI is the
      next polish pass)
```

The boring version works. The bells are being added one tier at a time — see `BACKLOG.md` in the repo for the full shopping list.

## Cost

```
   Cloudflare server:    £0  (free tier)
   Domain:                £0  (using a built-in *.workers.dev URL)
   YouTube streaming:     £0
   Camera (later):        £££ (already separately budgeted)
   ───────────────────────────
   Software running cost: £0/month
```

## How you can help

If you're keen:

1. **Test the demo URL** on different phones / browsers to see if the bar renders right:
   `https://<your-worker>.workers.dev/overlay/test?mock=1`
2. **Watch the YouTube test stream** when we do the first end-to-end run, and tell us if the bar looks right against a real video.
3. **Eyeball the design** — colours, font size, position, whether the away team should be dimmer, whether the wicket count should be bigger. We're going for "BBC Test Match" not "fantasy cricket app".
4. **At a real match** — sit somewhere with phone signal and watch the YouTube stream while the match is going on. Tell us if the scorebar lags too much, freezes, or shows wrong numbers.
5. **Babysit the log** during a real match — open `/admin/logs?key=…`, tick auto-refresh, and shout if rows stop arriving or red ✗ rows start showing up. See "Knowing it's working" above.

No coding required for any of that.

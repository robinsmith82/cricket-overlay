# Cricket overlay

> Streaming kit for club cricket — TV-style score bar in OBS, per-ball clips,
> auto-ranked highlights, on-phone moment stamping. One Cloudflare Worker
> (free tier).

MIT licensed. No hardcoded club branding — logos, crests, sponsors and accent
colours are all configured at runtime via an admin UI.

Transparent TV-style scorebar for streaming club cricket to YouTube via OBS,
plus a full set of v2 surfaces — live spectator page, open wagon-wheel
tagger, per-ball YouTube deep links, embeddable scorebar/clip iframes,
share-card SVGs, auto-ranked highlight reel, vibe reactions, AI match report
+ per-over commentary + share-card captions, D1-backed match archive with
career pages and head-to-head. All on a single Cloudflare Worker.

The [plain-English spec](non_tech_spec.md) is the non-technical tour; the
rest of this README is for engineers running it.

## Three concurrent scopes

| Scope     | Overlay URL                | Admin URL                     |
| --------- | -------------------------- | ----------------------------- |
| Default   | `/overlay/active`          | `/admin?key=<ADMIN_KEY>`      |
| 3rd XI    | `/3s/overlay/active`       | `/3s/admin?key=<ADMIN_KEY_3S>`|
| 4th XI    | `/4s/overlay/active`       | `/4s/admin?key=<ADMIN_KEY_4S>`|

Each scope has its own active match, sponsors, team branding, and admin key.
Admin keys are Cloudflare Workers secrets — see **Deploy** below.

## Quick endpoints

Public:
- `GET /` — landing page with all scope links.
- `GET /docs` — plain-English spec (renders `non_tech_spec.md`).
- `GET /api/score/:matchId` — JSON `Score`. Add `?mock=1` for a fake ticking innings, `?mock=2` for a 2nd-innings chase.
- `GET /api/discover` — auto-discovered fixtures from `DISCOVERY_HOME_URL`. Cached 5 min.
- `GET [/scope]/api/tags/:matchId` — wagon-wheel zone counts + shot-type tally.
- `GET [/scope]/api/events/:matchId` — match events + YouTube config (drives the clip strip).
- `GET [/scope]/api/vibes/:matchId` — emoji reaction map for the match.
- `POST [/scope]/api/vibe/:matchId/:innings/:over/:ball` — `{ emoji }` ∈ 🔥 😮 🎯 👏 😂. Open, rate-limited.

Overlay (for OBS):
- `GET [/scope]/overlay/:matchId` — self-contained HTML overlay. Forwards `?mock=1`.
- `GET [/scope]/overlay/active` — reads the scope's active match from KV.

Spectator-facing:
- `GET [/scope]/live[/:matchId]` — phone-friendly live page (score + commentary + live wagon wheel + clip strip).
- `GET [/scope]/highlights[/:matchId]` — vertical event list, each linking to YouTube at the right second.
- `GET [/scope]/summary[/:matchId]` — final-scoreline hero, top performers, full wagon wheel, OG meta. `?mock=1|2` previews against synthetic numbers.
- `GET [/scope]/reel[/:matchId]` — auto-ranked top-12 highlight grid.
- `GET [/scope]/report[/:matchId]` — AI-generated long-form match report (Workers AI).
- `GET [/scope]/tag[/:matchId]` — open wagon-wheel tagger. `?key=<admin>` mints a scorer cookie (5× weight) and redirects.
- `GET [/scope]/embed/score/:matchId` — minimal iframe scorebar.
- `GET [/scope]/embed/clip/:matchId/:eventIdx` — YouTube cued ~3s before that ball + caption.
- `GET [/scope]/share/:matchId/:eventIdx.svg` — 1200×630 share-card SVG per event (also `.png`).

Archive (when D1 is bound):
- `GET /archive` — searchable browser of every archived match.
- `GET /player/:slug` — career page aggregating across archived matches.
- `GET [/scope]/setup` — first-run setup wizard.

Admin (`?key=…`):
- `GET [/scope]/admin` — admin UI: discovered fixtures, sponsors, team branding, YouTube URL, mock-seed button.
- `GET [/scope]/admin/clubs` — club registry (multi-club future).
- `GET [/scope]/admin/logs` — scrape-log viewer.
- `GET [/scope]/admin/diagnose[/:matchId]` — match-health dashboard (cache freshness, fallback mode, source, scrape errors). Auto-refresh 15s.
- `POST [/scope]/admin/mock-seed` — seed a synthetic match so every v2 surface lights up without a live game.

## Quick start

```
npm install
npx wrangler kv namespace create CRICKET_CACHE
npx wrangler d1 create cricket-logs
npx wrangler d1 execute cricket-logs --file=migrations/0001_scrape_log.sql
npx wrangler d1 execute cricket-logs --file=migrations/0002_match_archive.sql
```

Paste the returned KV namespace id and D1 database id into `wrangler.toml`,
then:

```
npx wrangler dev
```

Open `http://localhost:8787/overlay/anything?mock=1` — runs and overs should
tick up every 10 seconds.

## Deploy

```
npx wrangler secret put ADMIN_KEY                # required to use the admin UI
npx wrangler secret put ADMIN_KEY_3S             # optional, for /3s admin
npx wrangler secret put ADMIN_KEY_4S             # optional, for /4s admin
npx wrangler secret put PLAY_CRICKET_API_TOKEN   # optional, see "Data sources" below
npx wrangler secret put YOUTUBE_API_KEY          # optional, see "YouTube" below
npx wrangler deploy
```

Then visit `https://<your-worker>.workers.dev/admin?key=<ADMIN_KEY>` to set
the active match and configure branding. Or visit `/setup` for a guided
first-run wizard.

## OBS

For each scope:

- **Video Capture Device** — your camera or PTZ feed.
- **Browser Source** — URL `https://<your-worker>.workers.dev/3s/overlay/active` (swap `3s`/`4s`/none), 1920×1080, "Refresh browser when scene becomes active".

You only set this URL once per scene. Switching matches happens in the
admin page, not in OBS.

## What the overlay shows

Top to bottom of the screen:

- Top-left: configurable header logo + scope chip (only when a scope is set).
- Mid-screen flashes: WICKET (5s) and 50/100 batter milestones (4s).
- Bottom stack: sponsor strip (when configured) → last-out ribbon (30s after a wicket) → partnership + powerplay → "this over" 6-ball dots → batters + bowler → team scoreline with batting team highlighted, run rate, required rate (innings 2), 2nd-innings target, status chip, pulsing live dot.

All of these light up automatically from the score data. None require manual
intervention during the match.

To customise the brand block, paste a base64 data URI into the relevant
constant in [src/assets.ts](src/assets.ts) — defaults are empty, in which
case the slot renders nothing.

## Configuration via admin

Each scope's admin page lets you:

1. **Set active match** — pick from the auto-discovered fixture list (when `DISCOVERY_HOME_URL` is set), or paste any Play-Cricket numeric match ID.
2. **Sponsors** — JSON array of `{ name, imageUrl?, text?, durationMs? }`. Rotates client-side every `durationMs` (default 12s).
3. **Team branding** — JSON keyed by case-insensitive team-name substring: `{ "myclub": { primary: "#ffd23a", crestUrl: "https://..." } }`. Replaces the default yellow accent and crest when that team is on screen.
4. **YouTube URL** — drives per-event deep links. With `YOUTUBE_API_KEY` set, the worker pulls `actualStartTime` from YouTube; without it, falls back to "moment admin pasted URL".

## Data sources (in order of preference)

1. **Play-Cricket Site API v2** when `PLAY_CRICKET_API_TOKEN` is set as a wrangler secret (preferred — supported, stable). Get one from your club's Play-Cricket site admin, or via the commercial/non-profit application route at <https://play-cricket.ecb.co.uk/hc/en-us/articles/24640412683037>.
2. **ResultsVault** via DES-signed `X-IAS-API-REQUEST` header (fallback). Verbatim port of the match-centre bundle's signing logic in [src/signer.ts](src/signer.ts). Fragile to upstream changes.

When the token arrives: `npx wrangler secret put PLAY_CRICKET_API_TOKEN`. No
code changes — the path switches automatically.

### Fixture auto-discovery

Set `DISCOVERY_HOME_URL` (a Worker var) to your club's Play-Cricket home page
(e.g. `https://yourclub.play-cricket.com/home`). The admin UI will list live
and upcoming match IDs you can promote with one click. Cached 5 min in KV.
When unset, `/api/discover` returns `[]` — you can still paste a match ID
manually.

### YouTube Data API key (optional, recommended)

When `YOUTUBE_API_KEY` is set as a wrangler secret, saving a YouTube URL in
admin asks `videos.list?part=liveStreamingDetails` for `actualStartTime` and
uses *that* as the offset baseline for every per-event deep-link. Without
the key, `startedAt` falls back to "the moment admin pasted the URL" —
paste 10 minutes late and every clip is 10 minutes off. Set with
`npx wrangler secret put YOUTUBE_API_KEY` (Google Cloud → Credentials →
Create API key, restricted to "YouTube Data API v3"). Free tier 10k
units/day; each save / refresh costs 1.

The admin page shows whether the active stream's `startedAt` is
`(from YouTube)` or `(fallback — pasted-at time)`. If it says fallback,
hit **Refresh start time from YouTube** once the broadcast goes live and
the offset is corrected in place.

### Workers AI

`/report`, `/api/commentary` and `/api/captions/...` use the bound `[ai]`
binding (Workers AI). Free during the open beta; comment the binding out
in `wrangler.toml` if you don't want to enable it (the routes will then
return stub responses).

## Files

Core:
- [src/index.ts](src/index.ts) — fetch handler, route table, scope routing, KV cache, `getScore()` (also fires `detectAndAppendEvents` on every cache miss).
- [src/scraper.ts](src/scraper.ts) — facade over the multi-source scraper registry.
- [src/scrapers/](src/scrapers/) — pluggable scraper implementations (`playcricket`, `mock`).
- [src/discovery.ts](src/discovery.ts) — facade over the multi-source discovery registry.
- [src/discoveries/](src/discoveries/) — pluggable fixture-discovery implementations (`playcricket`).
- [src/clubs.ts](src/clubs.ts) — club registry (KV-backed; pluggable scraper/discovery per club).
- [src/overlay.ts](src/overlay.ts) — self-contained HTML overlay with all the strips/animations.
- [src/admin.ts](src/admin.ts) — admin UI HTML + form handlers (per-scope).
- [src/setup.ts](src/setup.ts) — first-run setup wizard.
- [src/branding.ts](src/branding.ts) — KV-backed branding config helpers.
- [src/signer.ts](src/signer.ts) — DES signer for ResultsVault calls.
- [src/types.ts](src/types.ts) — `Score` shape + Worker `Env`.
- [src/assets.ts](src/assets.ts) — base64-inlined logo placeholders (paste in your own).
- [src/log.ts](src/log.ts) — D1 scrape-log writer.

V2 surfaces:
- [src/spectator.ts](src/spectator.ts) — `/live` page (score + commentary + live wagon wheel + clip strip).
- [src/tagger.ts](src/tagger.ts) — wagon-wheel + shot-type tagger UI; POST handler delegates to `voting`.
- [src/voting.ts](src/voting.ts) — voter cookie, HMAC-signed scorer cookie, rate limits, weighted-consensus ball-tag writer.
- [src/vibes.ts](src/vibes.ts) — emoji reaction counters.
- [src/highlights.ts](src/highlights.ts) — vertical event list with YouTube deep links.
- [src/summary.ts](src/summary.ts) — end-of-match recap. Exports `renderWagonWheelSvg()` reused server-side.
- [src/reel.ts](src/reel.ts) — auto-ranked top-12 highlight grid.
- [src/embed.ts](src/embed.ts) — `/embed/score` and `/embed/clip` iframe surfaces.
- [src/share.ts](src/share.ts) — `/share/:idx.svg` 1200×630 share cards.
- [src/png.ts](src/png.ts) — `/share/:idx.png` (resvg-wasm rendered).
- [src/events.ts](src/events.ts) — `detectAndAppendEvents()` diffs the scrape against the previous snapshot.
- [src/archive.ts](src/archive.ts) — KV helpers for YouTube config, ball tags, tag-meta.
- [src/match-archive.ts](src/match-archive.ts) — D1 archive of finished matches.
- [src/archive-browser.ts](src/archive-browser.ts) — `/archive` searchable browser.
- [src/player.ts](src/player.ts) — `/player/:slug` career pages.
- [src/head-to-head.ts](src/head-to-head.ts) — head-to-head card on discovered fixtures.
- [src/commentary.ts](src/commentary.ts) — per-over auto-commentary via Workers AI.
- [src/report.ts](src/report.ts) — AI match report.
- [src/captions.ts](src/captions.ts) — AI smart captions for share cards and embeds.
- [src/diagnose.ts](src/diagnose.ts) — `/admin/diagnose` match-health dashboard.
- [src/mock-seed.ts](src/mock-seed.ts) — `/admin/mock-seed` synthetic-match seeder.
- [src/docs.ts](src/docs.ts) — `/docs` (renders `non_tech_spec.md`, bundled at build via `wrangler.toml [[rules]] type = "Text"`).

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture: pipeline diagram,
KV layout, score shape, layout breakdown, and backlog.

For an end-to-end tour by surface, see [USER_GUIDE.md](USER_GUIDE.md).

## When things break

First stop for any single-match issue: **`/admin/diagnose?key=…`** —
colour-coded checks for cache freshness, scrape errors, fallback mode, data
source, ball-by-ball availability, and current pair. Auto-refreshes every
15s.

Then:
- **Bar shows old data**: Play-Cricket scrape failed, serving from `score:{matchId}:last_good`. Check `/admin/diagnose` (will show stale freshness + error) and Workers Tail (`npm run tail`).
- **Bar shows zeros + team names**: `parse_failed`. Selector or shape changed upstream — see scraper parse functions in [src/scrapers/playcricket.ts](src/scrapers/playcricket.ts).
- **Bar empty / no players**: match isn't being ball-by-ball-scored on the iPad. Score still updates from the summary fields. `/admin/diagnose` will flag "ball-by-ball: not available".
- **DES path stops working**: re-fetch `match-centre/1.3.0/main.js` from `embed.interactsport.com`, find `apiSharedSecret`, update [src/signer.ts](src/signer.ts). Diagnose will show source = `resultsvault` with errors.
- **Highlights / clip strip / reel are empty**: `events:{matchId}` isn't being populated. Confirm `getScore()` is being hit (cache miss) and `detectAndAppendEvents` is firing — events accumulate only on cache misses where the score actually changed.
- **Want to demo without a live match**: `/admin/mock-seed` writes synthetic events / tags / vibes against `mock-demo[-3s|-4s]` so every v2 surface lights up.

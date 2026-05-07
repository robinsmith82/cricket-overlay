# Architecture

## Pipeline

```
Play-Cricket data source ──► Cloudflare Worker ──► /api/score/:id (JSON)
                                    │                      ▲
                                    │                      │ poll 10s
                                    ▼                      │
                              KV cache (25s)         /[scope]/overlay/* (HTML)
                                                           │
                                                           ▼
                                                   OBS Browser Source
                                                           │
                                                           ▼
                                                   YouTube Live (RTMP)
```

One Worker. KV holds:

- **Score cache** per match: `score:{matchId}` (25s freshness in code, not via TTL) and `score:{matchId}:last_good` (only written on successful scrape, used as stale fallback).
- **RV mapping cache**: `rvmap:{externalId}` → `rvMatchId` (Play-Cricket → ResultsVault), written once and reused indefinitely.
- **Per-scope active match**: `active_match_id` / `active_match_id:3s` / `active_match_id:4s`. Reading `/overlay/active` (or `/3s/overlay/active`, etc.) renders the overlay against the scope's currently-active match. Switching matches is a one-button operation in the admin UI — no redeploy, no OBS edit.
- **Per-scope branding**: `branding:sponsors[:scope]` and `branding:teams[:scope]`. Drives the rotating sponsor strip and per-team accent colours / crests.
- **Per-scope YouTube config**: `youtube[:scope]` — `{ url, videoId, startedAt }`. Set in admin. `startedAt` is the manual stream-start wall-clock and is the anchor for per-ball deep links: every event with `ts >= startedAt` becomes a YouTube `&t=<seconds>s` jump.
- **Match events**: `events:{matchId}` — append-only list of `MatchEvent` (wicket / 4 / 6 / fifty / hundred / team-milestone), each stamped with the wall-clock `ts` at detection. `events:{matchId}:last` holds the previous score snapshot used for diffing.
- **Ball tags (consensus)**: `tag:{matchId}:{innings}:{over}.{ball}` — `{ zone: 0..8, taggedAt, shot? }`. Wagon-wheel zone (0=dot, 1=Straight clockwise to 8=Midwicket) plus optional shot type (`drive | cut | pull | sweep | glance | defence | edge | slog`). **Now derived from per-voter votes**: every POST to the open tagger writes a `vote:` entry, then re-derives this canonical key as the weighted-majority winner. Existing readers (wagon wheel, summary, archive) didn't have to change. `tag-meta:{matchId}` tracks the most recently tagged ball for resume-on-reload.
- **Ball votes (per-voter)**: `vote:{matchId}:{innings}:{over}.{ball}:{voterId}` — `{ voterId, weight, zone, shot?, ts }`. One row per voter per ball, replaceable. Weight is `5` for scorers (signed cookie verified), `1` otherwise. Listed by prefix to recompute consensus on each new vote.
- **Vibe reactions**: `vibe:{matchId}:{innings}:{over}.{ball}:{emoji}` — string-encoded counter (`"3"`). One key per (ball, emoji) so the write-fanout is bounded by the small fixed emoji set: 🔥 😮 🎯 👏 😂.
- **Rate-limit buckets**: `rl-s:{ip}:{second}` (TTL 5s) and `rl-m:{ip}:{minute}` (TTL 90s). Voter and vibe POSTs increment both; over-limit returns 429.

Cache freshness is 25s in code, not via KV TTL — keeps `last_good` usable when scrapes fail.

D1 (`LOG_DB`, database `cricket-logs`) holds the scrape audit trail — see [Scrape log](#scrape-log-d1).

## Scopes

The worker serves three concurrent overlay pipelines:

| Scope     | Overlay URL                | Admin URL                    |
| --------- | -------------------------- | ---------------------------- |
| Default   | `/overlay/active`          | `/admin?key=…`               |
| 3rd XI    | `/3s/overlay/active`       | `/3s/admin?key=…`            |
| 4th XI    | `/4s/overlay/active`       | `/4s/admin?key=…`            |

Each scope reads its own KV state (active match + branding) and is gated by its own admin secret. Adding a 5th scope is a one-line change: append to the `SCOPES` array in `src/index.ts` and add the corresponding `ADMIN_KEY_<X>` env var.

Path-prefix routing: requests starting with `/3s/` or `/4s/` are stripped and the rest is dispatched against that scope. Anything that doesn't match a known scope falls through to default-scope routing.

## Routes

Public:
- `GET /` — landing page with links to each scope's overlay/mock/admin and the plain-English spec.
- `GET /docs` (alias `/docs/non-tech-spec`) — renders `non_tech_spec.md` from the repo root, bundled at build time via wrangler's `[[rules]] type = "Text"` text-import. Single source of truth: edit the markdown, redeploy, page updates.
- `GET /api/score/:matchId` — JSON `Score`. `?mock=1` returns a fake ticking score, bypassing scraper + KV.
- `GET /api/discover` — JSON list of fixtures from `DISCOVERY_HOME_URL` (a Play-Cricket club home page). Cached 5 min in KV (`fixtures:playcricket`). Returns `[]` when unset.
- `GET [/scope]/api/tags/:matchId` — JSON `{ counts: number[9], shots: Record<ShotType,number>, total, lastTaggedAt }`. Drives the live wagon wheel on the spectator page.
- `GET [/scope]/api/events/:matchId` — JSON `{ events: MatchEvent[], youtube: YouTubeConfig | null }`. Drives the per-ball clip strip on the spectator page.
- `POST [/scope]/api/vibe/:matchId/:innings/:over/:ball` — `{ emoji }` ∈ `🔥 😮 🎯 👏 😂` → bumps the matching counter. Open (no auth), rate-limited.
- `GET [/scope]/api/vibes/:matchId` — JSON `{ vibes: { "1:14.3": { "🔥": 3, "😮": 1 } }, allowed: [...] }`. Match-wide reaction map; consumed by `/reel` ranking and (future) the spectator clip strip.

Overlay:
- `GET [/scope]/overlay/:matchId` — self-contained HTML overlay. Forwards `?mock=1` to its API call.
- `GET [/scope]/overlay/active` — reads the scope's active match from KV.

Spectator-facing:
- `GET [/scope]/live[/:matchId]` — phone-friendly live scoreboard with auto-generated commentary, live wagon-wheel card, and a clickable per-ball clip strip linking back to the YouTube stream.
- `GET [/scope]/highlights[/:matchId]` — vertical list of event cards (4s, 6s, wickets, 50s, 100s, team milestones) each linking to the matching second on YouTube.
- `GET [/scope]/summary[/:matchId]` — final-scoreline hero, "at the crease" / "final state" panel (current pair, bowler, partnership, last-over strip), top performers, full wagon-wheel SVG, OG meta for social sharing. Honours `?mock=1|2` to short-circuit the score fetch to the synthetic generator (events/tags stay empty — pair with `/admin/mock-seed` for fully populated demos).
- `GET [/scope]/reel[/:matchId]` — auto-ranked top-12 highlight grid. Weight = base event weight (wicket 6, hundred 10, fifty 5, six 4, four 2, milestone 1) + 0.5 per crowd reaction + 0.25 per ball-tag vote. Each card opens the YouTube clip embed; each card has a deep link to its share-card SVG.

Embed (intended as iframes / images on club websites):
- `GET [/scope]/embed/score/:matchId` — minimal scorebar iframe. Polls `/api/score`, no chrome.
- `GET [/scope]/embed/clip/:matchId/:eventIdx` — embedded YouTube player cued 3s before event #idx, with caption.
- `GET [/scope]/share/:matchId/:eventIdx.svg` — 1200×630 SVG share card per event. Served `Content-Type: image/svg+xml`. PNG conversion (for OG previews) is backlog.

Tagger (open — no `?key=` required):
- `GET [/scope]/tag[/:matchId]` — wagon-wheel + shot-type tagger UI. Polls `/api/score` for current ball context. Defaults to scope active match. Anyone with the link can tag; rendered with a `CROWD` badge in the header.
- `GET [/scope]/tag[/:matchId]?key=<admin>` — same page, but if the key matches the scope's admin secret the response also includes a `Set-Cookie: cricket-scorer=…` header (HMAC-signed with the admin key, 30-day TTL) and 303-redirects to the keyless URL so the secret doesn't sit in browser history. Scorer cookie weights subsequent votes 5× and renders a `SCORER ×5` badge.
- `POST [/scope]/tag/:matchId/zone` — `{ innings, over, ball, zone, shot? }` → writes `vote:…:{voterId}` then re-derives `tag:…` consensus. Voter cookie issued automatically on first POST. Rate-limited per IP (2/sec, 60/min).

Admin (auth via `?key=…`):
- `GET [/scope]/admin` — admin UI for that scope (active match selector, sponsor JSON, team branding JSON, YouTube URL, quick links). Top-right nav links to other scopes and to `/admin/logs`.
- `GET [/scope]/admin/logs` — scrape-log viewer. Sticky-header scrolling table of the last 500 rows, defaulting to the scope's active match. Query params: `matchId=<id>` (filter; blank = all), `changes=1` (only rows where data changed), `refresh=1` (5s `<meta http-equiv="refresh">`).
- `GET [/scope]/admin/diagnose[/:matchId]` — match-health dashboard. Reads cached score, last-good fallback, RV mapping, and the last 20 scrape-log rows; runs colour-coded checks (score freshness, scrape error, fallback mode, data source, ball-by-ball availability, current-pair availability) and surfaces the failure mode at a glance. Defaults to the scope's active match. Auto-refreshes every 15s.
- `POST [/scope]/admin/set-active` — write `active_match_id[:scope]` from a form field.
- `POST [/scope]/admin/sponsors` — write `branding:sponsors[:scope]` from JSON.
- `POST [/scope]/admin/teams` — write `branding:teams[:scope]` from JSON.
- `POST [/scope]/admin/youtube` — write `youtube[:scope]` (parses videoId from any YouTube URL form, stamps `startedAt = Date.now()`).
- `POST [/scope]/admin/mock-seed` — seed a synthetic match (default id `mock-demo[-3s|-4s]`). Writes ~30 fake events, ~80 wagon-wheel tags, ~50 vibe reactions and a final-state `last_good` score so every v2 surface (highlights / summary / reel / share / embed/clip) lights up without a live game. Deterministic per matchId; re-running clears and reseeds.

## Data sources

Play-Cricket's public match centre page is a React app. The HTML shell only contains team names — score numbers are loaded client-side from `https://api.resultsvault.co.uk/rv/`. The worker has two paths to that data:

### Path A: Play-Cricket Site API v2 (preferred, when token available)

```
GET https://www.play-cricket.com/api/v2/match_detail.json?match_id=<id>&api_token=<token>
```

Auth: `api_token` query parameter, issued per club to site admins (or via the commercial/non-profit application route). Returns JSON. Stable, supported.

Worker reads the token from the `PLAY_CRICKET_API_TOKEN` secret. When set, this path is used.

### Path B: ResultsVault direct (fallback, no token)

Three calls per scrape, all bearing a DES-signed `X-IAS-API-REQUEST` header (signature cached for 30 minutes):

1. **Mapping**: `mappings/4/12/<externalId>/?sportid=1&apiid=1003` → resolves Play-Cricket match ID to RV `object_id1`. Cached forever in KV.
2. **Match detail**: `<entity>/matches/<rvMatchId>/?strmflg=3&apiid=1003` → returns `MatchTeams[]`, `Innings[]`, `PlayerPerfs[]`, `MatchConfig.max_overs`, `match_format_id`, status fields.
3. **Recent balls** (only when the batting team has a `result_id`): `<entity>/matches/<rvMatchId>/?action=getballs&resultid=<r>&inningsnumber=<n>` → ball-by-ball events for the dot strip. Returns `[]` for non-ball-by-ball-scored matches; we cope.

Master entity is `130000` (the `masterEntityID` baked into the match-centre bundle's ECB theme config).

Used when `PLAY_CRICKET_API_TOKEN` is absent. Fragile: breaks if InteractSport rotate the DES key or rev the bundle. The signing logic (`ce()` from `match-centre/1.3.0/main.js`) is ported verbatim into `src/signer.ts`.

## Mock mode

`?mock=1` short-circuits both data paths, returning a synthetic `Score` derived from wall-clock minutes/seconds (one ball every 5s). Bypasses KV. Drives all the v1 features — batters, bowler, recent balls, partnership, powerplay, last-dismissal — so the design can be iterated against without a live match.

## Score shape

`src/types.ts` is the single source of truth:

```ts
type Score = {
  matchId: string;
  fetchedAt: string;             // server-side ISO timestamp
  status: 'live' | 'break' | 'finished' | 'unknown';
  innings: number;               // 1 | 2

  battingTeam: string;
  bowlingTeam: string;
  runs: number;
  wickets: number;
  overs: string;                 // "14.2" cricket notation
  oversTotal?: number;           // from MatchConfig.max_overs
  target?: number;               // 2nd innings only

  batters?: Batter[];            // current pair (top-2 not-out)
  bowler?: Bowler;               // current bowler (heuristic)
  recentBalls?: BallEvent[];     // last ~6 balls of current innings
  lastDismissal?: LastDismissal; // most recent fall of wicket
  partnership?: Partnership;     // current pair's contribution since last wicket
  powerplay?: 'PP1' | 'PP2' | null;

  error?: string;                // populated only on failure
  stale?: boolean;               // true when we served from last_good
  source?: 'play-cricket' | 'resultsvault' | 'mock'; // tagged by scraper, used by the D1 log
};
```

All fields beyond the first block are best-effort and absent if upstream doesn't provide them — overlay renders gracefully without.

## Overlay

Single self-contained HTML doc per request, no external assets, transparent background. Polls `/api/score/:matchId` every 10s with `setTimeout` recursion (not `setInterval` — stops requests stacking on a slow response). On error, last render stays on screen — no loading/error chrome.

### Layout (top → bottom of screen)

- **Top-left brand block** — configurable header logo + secondary mark + scope chip (`3rd XI` / `4th XI` only when scope is set; default scope shows no chip). Logo slots are empty by default — paste your own base64 data URIs into `src/assets.ts`.
- **Mid-screen flash overlay** — full-viewport "WICKET!" / "50" / "100" graphics. 5s for wickets, 4s for milestones. Triggered client-side by deltas across polls.
- **Bottom stack** (transparent, anchored 16px above the bottom edge for YouTube safe area):
  - **Sponsor strip** (only when sponsors configured) — rotating per-sponsor card.
  - **Last-out ribbon** (only for 30s after a wicket) — `OUT  R. SMITH 23 (18)  c PATEL b KHAN`.
  - **Partnership row** — `P'SHIP 47 (32) · PP1`.
  - **This-over strip** — coloured dots for the last 6 balls (4=blue, 6=pink, W=red, dot/1/2/3 grey, wide/no-ball with dashed border).
  - **Player strip** — 2 batters (with `*` on striker, runs/balls in muted grey) + bowler cell with gold tag.
  - **Team scoreline** — batting team highlighted (yellow gradient accent + tint), bowling team dimmed. Right-side meta column shows current overs, run rate, required rate (innings 2), 2nd-innings target, and a pulsing live dot when status is `live`.

### Animations

- **Bump**: score, batter score, bowler figures briefly scale + flash gold when their numeric value increases between polls.
- **Flash**: full-viewport overlay with a gold/red colour and large headline. Triggered on wicket and 50/100 batter milestones. Suppressed on the first poll so initial-load deltas don't fire.

### Inlined image assets

Workers don't serve static files, so all overlay imagery is base64-embedded in `src/assets.ts` and string-interpolated into the HTML at render time:

- `BRAND_LOGO_DATA_URI` — header logo for the top-left brand block. Empty default → slot is hidden.
- `BRAND_MASCOT_DATA_URI` — secondary mark sitting next to the header logo. Empty default → slot is hidden.

Drop in your own by base64-encoding a PNG (`printf 'data:image/png;base64,'; base64 -i logo.png` on macOS) and pasting into the relevant constant. Keep them small (~50KiB encoded) — the whole HTML doc ships on every overlay request.

### Branding (KV-driven, per scope)

`/<scope>/admin` writes JSON into KV which is read at overlay render time and inlined into the HTML:

- `branding:sponsors[:scope]` — `[{ name, imageUrl?, text?, durationMs? }]`. Rotated client-side every `durationMs` (default 12s).
- `branding:teams[:scope]` — `{ "<case-insensitive substring>": { primary?, secondary?, crestUrl? } }`. Substring match: `"shire"` matches "Shire CC, 1st XI". Overrides the default yellow accent and (optionally) the crest URL when the team is on screen.

## Scrape log (D1)

Every cache-miss scrape — i.e. every actual call to `scrapeMatch()` from `getScore()` in `src/index.ts` — appends one row to D1 table `scrape_log`. Cache hits do not write rows (they would be noise). Mock requests (`?mock=1`) bypass `getScore` entirely and don't log.

Schema (`migrations/0001_scrape_log.sql`):

| col            | meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `id`           | autoincrement                                                           |
| `ts`           | epoch ms                                                                |
| `match_id`     | scraped match ID                                                        |
| `source`       | `play-cricket` or `resultsvault` — which upstream answered              |
| `ok`           | 1 = no `error` field on the returned `Score`, 0 = error                 |
| `status`       | `live` / `break` / `finished` / `unknown`                               |
| `runs`, `wickets`, `overs`, `batting_team` | snapshot at moment of fetch                 |
| `changed`      | 1 if `(runs, wickets, overs, status)` differ from the previous row for the same `match_id` |
| `error`        | error string when `ok = 0`                                              |

Indexes on `(ts DESC)` and `(match_id, ts DESC)`.

Purpose: **"is the API actually working?"** — every row is a heartbeat. If rows stop arriving, the worker isn't being hit (or KV has gone wrong). The `source` column flags which upstream is currently live; the `changed` column lets the viewer collapse to interesting rows during slow phases.

Implementation lives in `src/log.ts`, ~50 lines. One exported function: `logScrape(env, score)`.

### Concurrency

Two near-simultaneous cache-miss scrapes for the same match could otherwise both compare against the same stale "previous" row. To prevent that, change-detection runs **inside the INSERT itself** via a correlated subquery against `MAX(id) WHERE match_id = ?`:

```sql
INSERT INTO scrape_log (...)
SELECT ?, ?, ..., 
  CASE WHEN (SELECT runs||'|'||wickets||'|'||overs||'|'||status
             FROM scrape_log
             WHERE match_id = ? ORDER BY id DESC LIMIT 1) IS ?
       THEN 0 ELSE 1 END,
  ?
```

SQLite serializes writes within the D1 instance, so whichever insert wins ordering is the one the next insert compares against. `id` is `AUTOINCREMENT` — no PK clashes. The whole call is wrapped in `try { } catch { }`: a D1 outage will never break a scrape or the overlay.

### Viewer

`/<scope>/admin/logs?key=…` renders a dark-themed sticky-header table with up to 500 rows. Filter form lets you change `matchId`, toggle "only changes", and toggle "auto-refresh 5s" (implemented via `<meta http-equiv="refresh">`, no JS). Error rows tinted red, change rows tinted yellow. Defaults to filtering by the scope's active match.

### Operational notes

- D1 has no TTL. Table grows unbounded. At ~1 scrape per 25s during active matches, a 4-hour innings adds ~600 rows. Acceptable for now; future cleanup is a single `DELETE FROM scrape_log WHERE id < (SELECT MAX(id) - N FROM scrape_log)` run from the admin UI or a cron.
- Schema changes go in `migrations/000N_*.sql` and are applied with `wrangler d1 execute cricket-logs --remote --file=…`.

## Modules (v2 surfaces)

Beyond the overlay/scrape core, the worker now hosts a set of NV Play-flavoured surfaces aimed at club-cricket viewing and sharing. Each is a single TypeScript file rendering a self-contained HTML page (no client framework, no bundler, no external assets).

| Module | Surface | Lives in | Notes |
| --- | --- | --- | --- |
| **Tagger** | `[/scope]/tag[/:matchId]` | `src/tagger.ts` | Wagon-wheel zone picker with optional shot-type chips. POSTs `{innings, over, ball, zone, shot?}` to `/tag/:matchId/zone`. Polls score for current ball context. Open — anyone can vote. `?key=<admin>` mints a scorer cookie (5× weight); rendered with `SCORER ×5` or `CROWD` badge. |
| **Voting** | (no route — feeds tagger) | `src/voting.ts` | Per-voter cookie (`cricket-voter`, random id), HMAC-signed scorer cookie (`cricket-scorer`, scope-bound, 30-day). Per-IP rate-limit buckets (2/sec, 60/min). `castBallVote` writes `vote:…:{voterId}` and recomputes the weighted-consensus `tag:…` key — so all existing readers get crowd consensus for free. |
| **Vibes** | `[/scope]/api/vibe/...`, `[/scope]/api/vibes/:matchId` | `src/vibes.ts` | Per-ball emoji counters (🔥 😮 🎯 👏 😂). One KV key per (ball, emoji). `bumpVibe` is a single-write increment. `readAllVibes` lists by prefix; consumed by `/reel`. |
| **Reel** | `[/scope]/reel[/:matchId]` | `src/reel.ts` | Auto-ranked top-12 highlight grid. Weight = base event weight + 0.5×reactions + 0.25×tagCount. Each card opens `/embed/clip/...`; each has a deep link to the share-card SVG. |
| **Spectator** | `[/scope]/live[/:matchId]` | `src/spectator.ts` | Phone-friendly live page. Polls 3 endpoints every 10s: `/api/score` (board + auto-commentary), `/api/tags` (live wagon wheel), `/api/events` (clip strip). Wagon wheel re-renders client-side from zone counts. Clip strip links each event to YouTube `&t=Ns` or to `/embed/clip/...`. |
| **Highlights** | `[/scope]/highlights[/:matchId]` | `src/highlights.ts` | Vertical event list (4s, 6s, wickets, milestones), each card a YouTube deep link. Reads `events:{matchId}` + `youtube[:scope]`. |
| **Summary** | `[/scope]/summary[/:matchId]` | `src/summary.ts` | Final-scoreline hero, top performers, full wagon-wheel SVG, OG meta tags for social sharing. Exports `renderWagonWheelSvg()` reused server-side. |
| **Embed** | `[/scope]/embed/score/:matchId`, `[/scope]/embed/clip/:matchId/:idx` | `src/embed.ts` | Iframe-friendly artifacts. Score embed is a polling scorebar; clip embed is a YouTube iframe `?start=` cued ~3s before the event ball, with a caption strip. |
| **Share card** | `[/scope]/share/:matchId/:idx.svg` | `src/share.ts` | 1200×630 SVG card per event (OG aspect). Type-coloured accent rail, big icon, headline + subline. PNG conversion is backlog. |
| **Events store** | (no route — feeds the above) | `src/events.ts` | `detectAndAppendEvents(env, score)` diffs the latest scrape against the persisted previous snapshot to detect wickets / 4 / 6 / 50 / 100 / team milestones. Stamps each event with `Date.now()` so per-ball deep links can offset against `youtube.startedAt`. Called from `getScore()` on every cache miss; idempotent on identical scores. |
| **Diagnose** | `[/scope]/admin/diagnose[/:matchId]` | `src/diagnose.ts` | Match-health dashboard. Reads cached score + `last_good` + `rvmap` + last 20 D1 scrape-log rows; renders colour-coded checks (freshness, scrape error, fallback mode, data source, ball-by-ball, current pair). Auto-refreshes every 15s. Complements `/admin/logs` — logs answer "is the API alive?", diagnose answers "is *this match* healthy right now?". |
| **Mock seeder** | `[/scope]/admin/mock-seed` (POST) | `src/mock-seed.ts` | Form action that writes ~30 events, ~80 tags, ~50 vibes and a final-state `last_good` score against a chosen matchId (default `mock-demo[-3s|-4s]`) so every v2 surface populates without a live match. Deterministic per matchId. Pairs with `summary?mock=1|2` for previewing the live-state hero against synthetic data. |
| **Archive (KV)** | (no route — feeds the above) | `src/archive.ts` | KV helpers for `youtube[:scope]`, `tag:*`, `tag-meta:*`. Defines `BallTag`, `ShotType`, `ZONE_LABELS`. `writeBallTag` merges with existing so a follow-up shot-type tap doesn't overwrite the zone. |
| **Docs** | `/docs` | `src/docs.ts` | Renders `non_tech_spec.md` (bundled as a raw-text import via `wrangler.toml [[rules]]`) inside a `<pre>` block so the ASCII diagrams line up. |

### Per-ball YouTube deep linking

The single anchor for the entire video story is `youtube[:scope].startedAt` — a wall-clock millisecond stamped when the admin saves the YouTube URL. Every event in `events:{matchId}` carries its own detection `ts`. Offset is computed at render time:

```ts
const offsetSec = Math.max(0, Math.floor((evt.ts - youtube.startedAt) / 1000));
const href = `https://www.youtube.com/watch?v=${videoId}&t=${offsetSec}s`;
```

Caveat: latency from "ball is bowled" → "scorer types in app" → "Play-Cricket publishes" → "we scrape & detect" can be 10–60s. The clip embed (`/embed/clip/...`) jumps in 3s before `offsetSec` to compensate; per-event surfaces (`/highlights`, spectator strip) jump exactly on `offsetSec`. Tunable.

### Open vs scorer-only

The tagger is now open — anyone with the URL can vote. Scorer status is conferred by an HMAC-signed cookie minted by visiting `/tag?key=<admin>`; the response 303s back to the keyless URL with a `Set-Cookie` so the secret never sits in browser history. The cookie is scope-bound: a `3s` scorer cookie does not weight votes on `4s`. Rate limiting is per `cf-connecting-ip` (2 votes/sec, 60/min). All admin-only surfaces (`/admin/*`) remain key-gated.

## Worker bindings

- `CRICKET_CACHE` — KV namespace. Holds score cache, mapping cache, active-match pointers, branding config. Create with `npx wrangler kv namespace create CRICKET_CACHE` and paste the id into `wrangler.toml`.
- `LOG_DB` — D1 database `cricket-logs`. Holds the `scrape_log` audit trail and the per-match archive. Create with `npx wrangler d1 create cricket-logs`, run both migrations in `migrations/`, and paste the id into `wrangler.toml`.
- `PLAY_CRICKET_API_TOKEN` — secret, optional. If unset, ResultsVault path is used.
- `ADMIN_KEY` — secret, required for the default-scope admin URL.
- `ADMIN_KEY_3S` — secret, required for the `/3s/admin` URL.
- `ADMIN_KEY_4S` — secret, required for the `/4s/admin` URL.

Set secrets with `npx wrangler secret put <NAME>`.

## Deployment

`*.workers.dev` host: `<your-worker>.workers.dev`. No custom domain.

## Backlog

See [`BACKLOG.md`](./BACKLOG.md) for the v2 product backlog (open tagger, archive, AI commentary, OG-PNG share cards, multi-club). Engineering-flavoured items below.

- **Get a Play-Cricket Site API token.** Removes the DES fragility. Either from a club admin or via the commercial/non-profit application at `play-cricket.ecb.co.uk/hc/en-us/articles/24640412683037`.
- **Status detection.** `live | break | finished | unknown` — best effort from upstream fields. Currently anything `status_id >= 60` lumps to `finished`. Need to learn the specific codes for `abandoned` / `no_result` / `drawn` from a real rained-off match and add an explicit "ABANDONED" / "NO RESULT" / "STUMPS" badge to the overlay's right side.
- **Verify v1 features against a real ball-by-ball-scored match.** Recent balls, batter/bowler perfs, last dismissal, partnership are all wired but only validated against mock. The first real digitally-scored match may need parser tweaks.
- **Powerplay rules per format.** Currently a simple `match_format_id === 2 → 6 overs` heuristic. Real format codes (T10, T20, 50-over, declaration) need looking up.
- **Switch to PTZ camera.** Spec mentions an SV3C 36X PoE PTZ over RTSP. v0/v1 use FaceTime HD; the swap is OBS-only, no worker changes.
- **Wrangler v3 → v4 bump.** Deploy currently warns; non-blocking but should land soon.
- **Per-ball latency tuning.** Per-event YouTube offset assumes near-zero scrape→publish lag. Clip embed compensates with a 3s pre-roll; consider learning per-match average lag from the gap between event detection and the matching `recentBalls` change.

## Out of scope (still)

Multi-camera switching, replay/clipping editor, league table widget, SSE instead of polling, on-camera commentary card.

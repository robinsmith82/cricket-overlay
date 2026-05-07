# User Guide — what you actually shipped

Plain-English tour of everything live at **<your-worker>.workers.dev**. Grouped by who uses it.

---

## Concepts you need to know

**Scopes.** Three concurrent matches, addressed by URL prefix:
- `/` (default) — usually the 1st XI
- `/3s/` — 3rd XI
- `/4s/` — 4th XI

Each scope has its own active match, sponsors, branding, and admin key. Most URLs below work bare (active match for default scope) or with a scope prefix (`/3s/highlights`).

**Active match.** Each scope has one "currently active" match id, set via the admin dashboard. Most public URLs that omit `:matchId` (like `/live`, `/highlights`, `/summary`, `/report`, `/reel`, `/tag`) auto-resolve to the active match for that scope.

**Mock mode.** `?mock=1` on overlay routes returns synthetic data so you can test OBS without a live match. `/admin/mock-seed` writes a full synthetic match to KV (events + tags + vibes + per-innings finals) so every page lights up.

**Admin auth.** Admin routes require `?key=<ADMIN_KEY>` (or `<ADMIN_KEY_3S>` / `<ADMIN_KEY_4S>` for scoped admin routes). Cookies are issued on success. Keys are Cloudflare Workers env vars set via `wrangler secret put`.

---

## For you (streaming the match in OBS)

| URL | What it is |
|---|---|
| `/` | Transparent overlay for default scope. Add as Browser Source in OBS. |
| `/3s/` `/4s/` | Same, scoped. |
| `/overlay/:matchId` | Overlay pinned to a specific match (ignores active-match config). |
| `/overlay/active` | Explicit "active match" alias — same as `/`. |

The overlay updates itself by polling the scrape pipeline. No typing.

---

## For spectators (share these links in WhatsApp)

| URL | What it is |
|---|---|
| `/live` or `/live/:matchId` | Live page — score, latest events, wagon wheel, YouTube deep-links to recent balls, **vibe-reaction buttons** (🔥 😮 🎯 👏 😂). Anyone can tap reactions. |
| `/highlights` or `/highlights/:matchId` | Card grid of every event (wickets, 4s, 6s, 50s, 100s, milestones). Each card links to that exact moment on YouTube. |
| `/summary` or `/summary/:matchId` | Post-match: final scoreline, top performers, full wagon wheel, **AI-written match report**, OG meta for social previews. |
| `/report` or `/report/:matchId` | AI match report standalone (~200 words, club-newsletter tone). |
| `/reel` or `/reel/:matchId` | Top 12 auto-ranked highlights, ordered by `event-importance × reactions × tag-votes`. |

---

## For your scorers / volunteers (crowdsourced ball tagging)

| URL | What it is |
|---|---|
| `/tag` or `/tag/:matchId` | Open tagger. Anyone with the link can tag where each ball went (8-zone wagon wheel + shot type: drive/cut/pull/sweep/glance/defence/edge/slog). Per-IP rate-limited (2/sec, 60/min), per-voter cookie de-dupes. Weighted-majority decides; HMAC-signed scorer cookie counts 5×. |

The wagon wheel on `/live` and `/summary` is built from these tags.

---

## Archive (everything that ever happened)

Completed matches get auto-promoted to D1 on terminal status (drawn/finished/abandoned/no_result). They also have a manual archive button on `/admin/archive`.

| URL | What it is |
|---|---|
| `/archive` | Searchable browser. Filters: free-text q (team or player), team dropdown, season dropdown, "matches with a 50+", "wicket in first over". |
| `/players` | Index of every player who's ever appeared in an archived match. |
| `/player/:slug` | Career page. Counts: matches played, 4s, 6s, 50s, 100s, wickets taken, dismissals. **Honest:** runs / SR / economy aren't derivable from the milestone-only event log; the page says so. |

---

## Embeds (drop these on the club website)

| URL | What it is |
|---|---|
| `/embed/score/:matchId` | Tiny iframe scorebar. |
| `/embed/clip/:matchId/:eventIdx` | Embedded YouTube cued ~3s before that ball, with **AI-generated caption** ("Smith's slog-sweep for six off Patel, 14th over"). |

---

## Share cards (for social)

Both formats render the same per-event card (wicket / 4 / 6 / 50 / 100 / milestone) with team branding. AI-generated subline when available, mechanical fallback otherwise.

| URL | Format |
|---|---|
| `/share/:matchId/:eventIdx.svg` | Vector — best for inline web. |
| `/share/:matchId/:eventIdx.png` | Rasterised via resvg-wasm — required for WhatsApp / Twitter previews. |

---

## Admin (you only — needs `?key=...`)

| URL | What it is |
|---|---|
| `/admin` (or `/3s/admin`, `/4s/admin`) | Main dashboard. Set the active match for the scope, configure YouTube URL, sponsors, team names. Trigger Play-Cricket fixture discovery. |
| `/admin/diagnose` or `/admin/diagnose/:matchId` | Match-health: cache freshness, fallback mode, data source, scrape errors, ball-by-ball availability. Auto-refresh every 15s. |
| `/admin/logs` | Scrape audit trail (D1 `scrape_log` table). Every real scrape attempt; filtered by match. |
| `/admin/mock-seed` | Seed a synthetic match so every spectator surface lights up. Use when testing changes without a live game. |
| `/admin/archive` | List archived matches; "archive now" button per active match; links to `/api/archive/:matchId`. |
| `/admin/clubs` | Club registry. Lists clubs (`default` seeded), add-club form with scraperId / discoveryId dropdowns. Foundation for multi-club support; not yet wired to scrape pipeline. |

---

## JSON APIs (for scripts, future tooling, or curiosity)

All public unless noted. CORS-enabled. Cache-Control: no-store.

**Scoring & events**
- `GET /api/score/:matchId` — current score snapshot
- `GET /api/tags/:matchId` — all wagon-wheel tags
- `GET /api/events/:matchId` — milestone events
- `GET /api/discover` — discovered Play-Cricket fixtures (requires `DISCOVERY_HOME_URL`)

**Archive**
- `GET /api/archive/:matchId` — full archived match (matches + innings + events + balls)
- `GET /api/archive/search?q&team&season&hasFifty&wicketFirstOver&limit&offset` — search results JSON
- `GET /api/head-to-head?teamA=...&teamB=...&limit=N` — prior meetings

**AI**
- `GET /api/report/:matchId` — match report (cached; `?force=1` regenerates, admin-only)
- `GET /api/caption/:matchId/:eventIdx` — share-card caption (cached; `?force=1` admin-only)
- `GET /api/commentary/:matchId/:overKey` — per-over commentary (cached; `?force=1` admin-only)

**Crowdsourcing**
- `POST /api/vibe/:matchId/:innings/:over/:ball` (body: `{vibe: '🔥'|'😮'|'🎯'|'👏'|'😂'}`) — react to a ball
- `GET /api/vibes/:matchId` — all reaction counters

**Admin (auth required)**
- `POST /api/admin/archive/:matchId` — promote match to D1
- `POST /api/admin/clubs` — upsert club (JSON or form-encoded)
- `POST /api/admin/clubs/:slug/delete` — remove club (rejects `playcricket`)

---

## Operational notes

**Bindings (in `wrangler.toml`):**
- `CRICKET_CACHE` — KV, holds live state (scores, events, tags, vibes, captions, reports, club registry)
- `LOG_DB` — D1, holds scrape audit trail + match archive (4 tables: matches, innings, events, balls)
- `AI` — Cloudflare Workers AI, used for commentary / match reports / smart captions (model: `@cf/meta/llama-3.1-8b-instruct`)

**Env vars / secrets:**
- `ADMIN_KEY`, `ADMIN_KEY_3S`, `ADMIN_KEY_4S` — admin gate per scope

**Migrations:**
- `0001_scrape_log.sql` — audit trail
- `0002_match_archive.sql` — 4-table archive schema

**Deploy:**
```
bun run deploy
```
And if you've added a migration:
```
bunx wrangler d1 migrations apply cricket-logs --remote
```

---

## What's NOT shipped

- Multi-club beyond a single feed. The `Scraper` / `Discovery` interfaces and `Club` registry exist, but the scrape pipeline is still hardwired to the registered Play-Cricket adapter. The next step (a real second-source onboarding) would wire `getClub(scope).scraperId` into dispatch.
- Anything not in this guide is either an internal helper or doesn't exist.

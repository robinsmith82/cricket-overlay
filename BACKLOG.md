# Backlog — "NV Play but free, for club cricket"

Pitch: every wicket and boundary becomes a clickable, shareable per-ball video clip; every tagged ball builds a live wagon wheel; every match leaves a permanent searchable artifact. All on Cloudflare's free tier.

Status legend: ✅ shipped · 🚧 in progress · ⏳ next up · 🗄 backlog

---

## Backlog (not yet picked)

### Tier 6 — multi-club

- 🗄 **Multi-source dispatch.** The `Scraper` / `Discovery` interfaces and `Club` registry are in place, but the scrape pipeline is still hardwired to the Play-Cricket adapter. Wire `getClub(scope).scraperId` into dispatch and onboard a second feed source.

---

## Already shipped

### v0 — overlay core

- ✅ Live overlay (OBS browser source), per-scope sponsors and team branding
- ✅ Three concurrent scopes (default / 3rd XI / 4th XI)
- ✅ Event detection (wickets / 4 / 6 / 50 / 100 / team milestones)
- ✅ Play-Cricket fixture discovery (`DISCOVERY_HOME_URL`), admin UI per scope
- ✅ Mock mode for testing
- ✅ Scrape-log audit trail in D1, viewer at `/admin/logs`

### Tier 0 — wire what's already coded

- ✅ **`/highlights/:matchId`** — event cards + per-ball YouTube deep links.
- ✅ **`/summary/:matchId`** — final scoreline, "final state" panel, top performers, full wagon wheel, OG meta.
- ✅ **Active-match shortcuts** — `/highlights`, `/summary`, `/tag`, `/reel`, `/live` (no id) → resolve to current active match for the scope.

### Tier 1 — ball-level video & live tagging

- ✅ **Per-ball YouTube deep-link strip on spectator page.** Latest events as clickable badges that jump to the right second on YouTube.
- ✅ **Live wagon wheel on spectator page.** `/api/tags/:matchId` JSON; client polls and re-renders the wheel.
- ✅ **Shot-type tag** (drive/cut/pull/sweep/glance/defence/edge/slog) alongside zone in tagger. Stored on `BallTag.shot`.

### Tier 2 — crowdsourcing

- ✅ **Open tagger with per-IP rate limit + dedupe.** Anyone with link can tag; weighted-majority per ball wins; HMAC-signed scorer cookie weights 5×. 2/sec, 60/min per IP. Per-voter cookie de-dupes (re-vote replaces previous).
- ✅ **Vibe reactions** per ball (🔥 😮 🎯 👏 😂). KV counter per (ball, emoji). Feeds `/reel` ranking.
- ✅ **Vibe-reaction UI on the spectator page.** Buttons + live counters on `/live`, reusing the rate-limit and voter-cookie machinery.
- ✅ **Auto-highlight ranking.** `/reel/:matchId` shows top 12 by `base × type + 0.5 × reactions + 0.25 × tag-votes`.

### Tier 3 — archive & stats

- ✅ **D1 match archive.** Completed matches promoted to `matches` / `innings` / `balls` / `events` tables. One atomic D1 batch per match. Auto-archives on terminal status; manual button on `/admin/archive`. Per-innings final state captured via `final-state:<matchId>:<innings>` snapshots so multi-innings fidelity survives. Public read at `/api/archive/:matchId`.
- ✅ **`/player/:slug`** — career page aggregating across archived matches. Honest about derivable stats (4s/6s/50s/100s/wickets/dismissals exact; runs/SR/economy not derivable from milestone-only events). `/players` index lists all known players.
- ✅ **`/archive`** — searchable UI with filters (free-text q, team, season, "has a 50+", "wicket in first over"). Single parameterised query, no N+1. JSON twin at `/api/archive/search`.
- ✅ **Head-to-head card.** Auto-shows prior archived meetings on discovered fixtures (admin page). Conservative win attribution — unknowns counted, never guessed. Public `/api/head-to-head?teamA&teamB`.

### Tier 4 — embed & distribution

- ✅ **`/embed/score/:matchId`** — tiny iframe scorebar for club website.
- ✅ **`/embed/clip/:matchId/:eventIdx`** — embedded YouTube cued ~3s before that ball + caption.
- ✅ **`/share/:matchId/:eventIdx.svg`** — share-card SVG per ball (wicket / boundary / milestone).
- ✅ **OG share-card PNGs.** SVG → PNG via `resvg-wasm` so cards render in WhatsApp / Twitter previews.

### Tier 5 — AI (Workers AI)

- ✅ **Auto-commentary.** Per-over 1–2 line summary from event diff. KV-cached, lazy generation, force-regen for admin.
- ✅ **Match report generator.** ~200-word post-match writeup from events + top performers + final state. Embedded inline on `/summary` and standalone at `/report/:matchId`.
- ✅ **Smart highlight captions.** "Smith's slog-sweep for six off Patel, 14th over." Used as share-card subline + embed-clip caption. Falls back to mechanical caption when generation fails or batter/bowler missing.

### Operational

- ✅ **`/admin/diagnose[/:matchId]`** — match-health dashboard (cache freshness, fallback mode, data source, scrape errors, ball-by-ball availability). Auto-refresh 15s.
- ✅ **`/admin/mock-seed`** — seeds a synthetic match (events + tags + vibes + per-innings final state) so every surface lights up without a live game.
- ✅ **`/admin/archive`** — admin viewer listing archived matches, with archive-now button per match.
- ✅ **`/docs`** — non-tech spec served from the worker (markdown bundled at build via `wrangler.toml [[rules]] type = "Text"`). Single source of truth.

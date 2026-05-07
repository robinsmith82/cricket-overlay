import type {
  BallEvent,
  Batter,
  Bowler,
  Env,
  LastDismissal,
  MatchStatus,
  Partnership,
  Powerplay,
  Score,
} from '../types';
import { signRequest } from '../signer';
import type { Scraper } from './types';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const RV_BASE = 'https://api.resultsvault.co.uk/rv/';
const RV_MASTER_ENTITY_ID = 130000;
const RV_API_ID = 1003;

const SITE_API_BASE = 'https://www.play-cricket.com/api/v2/';

async function scrapeMatch(matchId: string, env: Env): Promise<Score> {
  if (env.PLAY_CRICKET_API_TOKEN) {
    return scrapeViaSiteAPI(matchId, env.PLAY_CRICKET_API_TOKEN, env);
  }
  return scrapeViaResultsVault(matchId, env);
}

function failedScore(matchId: string, error: string, source: 'play-cricket' | 'resultsvault'): Score {
  return {
    matchId,
    fetchedAt: new Date().toISOString(),
    status: 'unknown',
    innings: 1,
    battingTeam: '',
    bowlingTeam: '',
    runs: 0,
    wickets: 0,
    overs: '0.0',
    error,
    source,
  };
}

// ---------- ResultsVault path (no token) -----------------------------------

async function rvFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      'X-IAS-API-REQUEST': signRequest(),
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
}

async function resolveRvMatchId(externalId: string, env: Env): Promise<number | null> {
  const cacheKey = `rvmap:${externalId}`;
  const cached = await env.CRICKET_CACHE.get(cacheKey);
  if (cached) {
    const n = Number(cached);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const url = `${RV_BASE}mappings/4/12/${encodeURIComponent(externalId)}/?sportid=1&apiid=${RV_API_ID}`;
  const res = await rvFetch(url);
  if (!res.ok) return null;
  const json = (await res.json()) as { object_id1?: number };
  const rvId = json.object_id1 && json.object_id1 > 0 ? json.object_id1 : null;
  if (rvId) await env.CRICKET_CACHE.put(cacheKey, String(rvId));
  return rvId;
}

type RVPlayerPerf = {
  __type?: string;
  player_id?: number;
  player_name?: string;
  number?: number | null;
  // Batting fields
  balls?: number | null;
  runs?: number | null;
  fours?: number | null;
  sixes?: number | null;
  dismissal_id?: number | null;
  dismissal_text?: string | null;
  // Bowling fields
  overs?: number | null;
  maidens?: number | null;
  wickets?: number | null;
  wides?: number | null;
  no_balls?: number | null;
};

type RVInnings = {
  innings_number: number;
  innings_order: number;
  runs: number;
  wickets: number;
  overs_bowled: number;
  status: number;
  PlayerPerfs?: RVPlayerPerf[];
};

type RVTeam = {
  is_home: boolean;
  team_name: string;
  match_score_text: string;
  result_id?: number;
  Innings: RVInnings[];
};

type RVBall = {
  runs?: number | null;
  ball_runs?: number | null;
  total_runs?: number | null;
  extras?: number | null;
  byes?: number | null;
  leg_byes?: number | null;
  wides?: number | null;
  no_balls?: number | null;
  is_wicket?: boolean | null;
  dismissal_id?: number | null;
  is_four?: boolean | null;
  is_six?: boolean | null;
  ball_count?: number | null;
  over_number?: number | null;
  ball_number?: number | null;
  inst_num?: number | null;
};

type RVMatchConfig = {
  max_overs?: number | null;
  balls_per_over?: number | null;
};

type RVMatch = {
  external_match_id: number;
  match_id: number;
  status_id: number;
  match_format_id?: number;
  home_name: string;
  away_name: string;
  score_text: string;
  MatchTeams: RVTeam[];
  MatchConfig?: RVMatchConfig;
};

function rvStatus(statusId: number): MatchStatus {
  // Observed codes:
  //   0  = scheduled / not started (real match 7591652)
  //   60 = finished, played to a result (real match 7671201)
  // Best-guess until we see them in the wild:
  //   1..29  = innings 1 in progress (mapped to 'live')
  //   30..59 = break / mid-innings (mapped to 'live' as fallback; refine when we see codes)
  //   61..69 = abandoned / no_result / drawn (TBD; map to 'finished' for now)
  // Update this mapping when a real rained-off / drawn match shows up.
  if (statusId === 0) return 'unknown';
  if (statusId >= 60) return 'finished';
  return 'live';
}

function formatOvers(oversBowled: number | null | undefined): string {
  if (typeof oversBowled !== 'number' || !Number.isFinite(oversBowled)) return '0.0';
  // ResultsVault stores overs as "<overs>.<balls>" decimal where balls < 6.
  // E.g. 14.2 means 14 overs and 2 balls. Render as-is, capped at 1dp.
  const overs = Math.floor(oversBowled);
  const balls = Math.round((oversBowled - overs) * 10);
  const safeBalls = Math.max(0, Math.min(5, balls));
  return `${overs}.${safeBalls}`;
}

function isBattingPerf(p: RVPlayerPerf): boolean {
  if (typeof p.__type === 'string') return p.__type.startsWith('Batting');
  // Fallback: a batter has a faced-balls count or a dismissal record.
  return p.balls != null || p.dismissal_id != null || p.dismissal_text != null;
}

function isBowlingPerf(p: RVPlayerPerf): boolean {
  if (typeof p.__type === 'string') return p.__type.startsWith('Bowling');
  // Fallback: a bowler has overs bowled (non-null) and no batting-only fields.
  return p.overs != null && p.dismissal_id == null && p.dismissal_text == null;
}

function extractBatters(perfs: RVPlayerPerf[] | undefined): Batter[] {
  if (!perfs || perfs.length === 0) return [];
  const batting = perfs.filter(isBattingPerf);
  const notOut = batting.filter((p) => p.dismissal_id == null && (p.dismissal_text == null || p.dismissal_text === ''));
  notOut.sort((a, b) => (b.number ?? 0) - (a.number ?? 0));
  // Highest batting position numbers are most recent in the order — current pair.
  const top = notOut.slice(0, 2);
  return top.map((p, i) => ({
    name: (p.player_name ?? '').toUpperCase(),
    runs: p.runs ?? 0,
    balls: p.balls ?? 0,
    notOut: true,
    onStrike: i === 0,
  }));
}

function extractLastDismissal(perfs: RVPlayerPerf[] | undefined): LastDismissal | undefined {
  if (!perfs || perfs.length === 0) return undefined;
  const dismissed = perfs.filter(
    (p) => isBattingPerf(p) && p.dismissal_id != null && p.dismissal_id > 0,
  );
  if (dismissed.length === 0) return undefined;
  // Most recent dismissal = highest fow_order if present, else last in list.
  dismissed.sort((a, b) => ((b as any).fow_order ?? 0) - ((a as any).fow_order ?? 0));
  const d = dismissed[0];
  return {
    batter: (d.player_name ?? '').toUpperCase(),
    runs: d.runs ?? 0,
    balls: d.balls ?? 0,
    dismissalText: (d.dismissal_text ?? '').trim(),
  };
}

function computePartnership(batters: Batter[], totalRuns: number): Partnership | undefined {
  if (!batters || batters.length === 0) return undefined;
  // First-pass approximation: when both batters at the crease, the partnership
  // runs equal their two contributions. Refines further with ball-by-ball data
  // (TODO once we see real getballs payloads).
  const runs = batters.reduce((acc, b) => acc + (b.runs ?? 0), 0);
  const balls = batters.reduce((acc, b) => acc + (b.balls ?? 0), 0);
  // Cap by team total to avoid weird states (extras can make individual sums exceed).
  return { runs: Math.min(runs, totalRuns), balls };
}

function computePowerplay(matchFormatId: number | undefined, oversBowled: number): Powerplay {
  if (typeof oversBowled !== 'number') return null;
  // Simple defaults until we learn the league's format codes.
  // T20 (format_id 2 in our sample) → PP overs 0-6.
  // 50-over → PP1 overs 0-10.
  if (matchFormatId === 2) return oversBowled < 6 ? 'PP1' : null;
  if (oversBowled < 10) return 'PP1';
  return null;
}

function extractBowler(perfs: RVPlayerPerf[] | undefined): Bowler | undefined {
  if (!perfs || perfs.length === 0) return undefined;
  const bowling = perfs.filter(isBowlingPerf);
  if (bowling.length === 0) return undefined;
  // Heuristic: the current bowler is whoever has the most overs in this list,
  // tie-broken by appearance order (last entry wins). With ball-by-ball data
  // we'd pick the bowler of the most recent ball — TODO when getballs lands.
  const current = bowling.reduce((best, p) =>
    (p.overs ?? 0) >= (best.overs ?? 0) ? p : best,
  bowling[0]);
  return {
    name: (current.player_name ?? '').toUpperCase(),
    overs: formatOvers(current.overs ?? 0),
    maidens: current.maidens ?? 0,
    runs: current.runs ?? 0,
    wickets: current.wickets ?? 0,
  };
}

async function fetchRecentBalls(rvMatchId: number, resultId: number, inningsNumber: number): Promise<BallEvent[]> {
  try {
    const url = `${RV_BASE}${RV_MASTER_ENTITY_ID}/matches/${rvMatchId}/?action=getballs&sportid=1&apiid=${RV_API_ID}&resultid=${resultId}&inningsnumber=${inningsNumber}`;
    const res = await rvFetch(url);
    if (!res.ok) return [];
    const json = (await res.json()) as RVBall[] | { Balls?: RVBall[] };
    const balls = Array.isArray(json) ? json : json.Balls ?? [];
    if (!balls.length) return [];
    // Take the last 6 in chronological order (assumed appended order).
    const tail = balls.slice(-6);
    return tail.map((b) => {
      const runs = b.total_runs ?? b.ball_runs ?? b.runs ?? 0;
      const isWicket = !!(b.is_wicket || (b.dismissal_id != null && b.dismissal_id > 0));
      const isFour = !!b.is_four || runs === 4;
      const isSix = !!b.is_six || runs === 6;
      const isWide = (b.wides ?? 0) > 0;
      const isNoBall = (b.no_balls ?? 0) > 0;
      return { runs, isWicket, isFour, isSix, isWide, isNoBall };
    });
  } catch {
    return [];
  }
}

function pickCurrentInnings(teams: RVTeam[]): { batting: RVTeam; bowling: RVTeam; innings: RVInnings | null } | null {
  if (teams.length < 2) return null;
  // Prefer the most recent innings_order across all teams, where status === 1
  // (open innings). Fall back to the highest innings_order regardless of status.
  let best: { team: RVTeam; innings: RVInnings } | null = null;
  for (const t of teams) {
    for (const i of t.Innings || []) {
      if (!best || i.innings_order > best.innings.innings_order) {
        best = { team: t, innings: i };
      }
    }
  }
  if (!best) return { batting: teams[0], bowling: teams[1], innings: null };
  const batting = best.team;
  const bowling = teams.find((t) => t !== batting) ?? teams[1];
  return { batting, bowling, innings: best.innings };
}

async function scrapeViaResultsVault(matchId: string, env: Env): Promise<Score> {
  try {
    const rvId = await resolveRvMatchId(matchId, env);
    if (!rvId) return failedScore(matchId, 'mapping_missing', 'resultsvault');
    const url = `${RV_BASE}${RV_MASTER_ENTITY_ID}/matches/${rvId}/?strmflg=3&apiid=${RV_API_ID}`;
    const res = await rvFetch(url);
    if (!res.ok) return failedScore(matchId, `rv_${res.status}`, 'resultsvault');
    const m = (await res.json()) as RVMatch;
    const picked = pickCurrentInnings(m.MatchTeams || []);
    if (!picked) return failedScore(matchId, 'no_teams', 'resultsvault');
    const innings = picked.innings;
    const battingTeam = picked.batting.team_name || (picked.batting.is_home ? m.home_name : m.away_name);
    const bowlingTeam = picked.bowling.team_name || (picked.bowling.is_home ? m.home_name : m.away_name);
    const status = rvStatus(m.status_id);

    const inningsNumber = innings?.innings_number ?? 1;
    const target =
      inningsNumber >= 2
        ? deriveTarget(m.MatchTeams || [], picked.batting)
        : undefined;

    const batters = extractBatters(innings?.PlayerPerfs);
    const bowler = extractBowler(innings?.PlayerPerfs);

    // Fire-and-forget recent-balls fetch when the batting team has a result_id.
    let recentBalls: BallEvent[] | undefined;
    if (innings && picked.batting.result_id) {
      const balls = await fetchRecentBalls(rvId, picked.batting.result_id, innings.innings_number);
      if (balls.length) recentBalls = balls;
    }

    const oversTotal =
      typeof m.MatchConfig?.max_overs === 'number' && m.MatchConfig.max_overs > 0
        ? m.MatchConfig.max_overs
        : undefined;

    const lastDismissal = extractLastDismissal(innings?.PlayerPerfs);
    const partnership = computePartnership(batters, innings?.runs ?? 0);
    const powerplay = computePowerplay(m.match_format_id, innings?.overs_bowled ?? 0);

    return {
      matchId,
      fetchedAt: new Date().toISOString(),
      status,
      innings: inningsNumber,
      battingTeam,
      bowlingTeam,
      runs: innings?.runs ?? 0,
      wickets: innings?.wickets ?? 0,
      overs: formatOvers(innings?.overs_bowled),
      ...(typeof target === 'number' ? { target } : {}),
      ...(typeof oversTotal === 'number' ? { oversTotal } : {}),
      ...(batters.length ? { batters } : {}),
      ...(bowler ? { bowler } : {}),
      ...(recentBalls ? { recentBalls } : {}),
      ...(lastDismissal ? { lastDismissal } : {}),
      ...(partnership ? { partnership } : {}),
      ...(powerplay ? { powerplay } : {}),
      source: 'resultsvault',
    };
  } catch (e) {
    return failedScore(matchId, e instanceof Error ? e.message : 'rv_error', 'resultsvault');
  }
}

function deriveTarget(teams: RVTeam[], batting: RVTeam): number | undefined {
  const otherInnings = teams
    .filter((t) => t !== batting)
    .flatMap((t) => t.Innings || [])
    .reduce((acc, i) => acc + (i.runs ?? 0), 0);
  return otherInnings > 0 ? otherInnings + 1 : undefined;
}

// ---------- Site API v2 path (with token) ----------------------------------
//
// Shape inferred from Play-Cricket's published Site API v2 docs (match_detail).
// Untested without a real token — adjust field names once we have a sample
// response. The structure here is intentionally defensive: every accessor
// has a fallback so a renamed field returns parse_failed rather than throwing.

type SiteAPIBat = {
  position?: string | number;
  batsman_name?: string;
  how_out?: string;
  fielder_name?: string;
  bowler_name?: string;
  runs?: string | number;
  fours?: string | number;
  sixes?: string | number;
  balls?: string | number;
};

type SiteAPIBowl = {
  bowler_name?: string;
  overs?: string | number;
  maidens?: string | number;
  runs?: string | number;
  wickets?: string | number;
  wides?: string | number;
  no_balls?: string | number;
};

type SiteAPIFow = {
  runs?: string | number;
  wickets?: string | number;
  batsman_out_name?: string;
  batsman_in_name?: string;
  batsman_in_runs?: string | number;
};

type SiteAPIInnings = {
  innings_number?: number;
  team_batting_name?: string;
  team_batting_id?: string;
  runs?: string | number;
  wickets?: string | number;
  overs?: string | number;
  bat?: SiteAPIBat[];
  bowl?: SiteAPIBowl[];
  fow?: SiteAPIFow[];
};

type SiteAPIMatch = {
  id?: number;
  status?: string;
  match_status?: string;
  result_description?: string;
  home_team_name?: string;
  home_team_id?: string;
  home_club_name?: string;
  away_team_name?: string;
  away_team_id?: string;
  away_club_name?: string;
  no_of_overs?: string | number;
  innings?: SiteAPIInnings[];
};

type SiteAPIResponse = {
  match_details?: SiteAPIMatch[];
};

async function scrapeViaSiteAPI(matchId: string, token: string, env: Env): Promise<Score> {
  try {
    const url = `${SITE_API_BASE}match_detail.json?match_id=${encodeURIComponent(matchId)}&api_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return failedScore(matchId, `site_api_${res.status}`, 'play-cricket');
    const json = (await res.json()) as SiteAPIResponse;
    const match = json.match_details?.[0];
    if (!match) return failedScore(matchId, 'site_api_no_match', 'play-cricket');

    // Play-Cricket Site API v2 returns innings in chronological order (1st,
    // then 2nd) and doesn't always populate an `innings_number` field. Trust
    // array position: the last entry is the innings currently in progress.
    const list = match.innings || [];
    const currentIdx = list.length - 1;
    const current = list[currentIdx];
    if (!current) return failedScore(matchId, 'site_api_no_innings', 'play-cricket');

    // Build "<club> - <team>" labels for both sides from the match-level fields,
    // then assign batting/bowling by team_batting_id. The Site API's per-side
    // name fields (home_team_name etc.) are just the team variant; combining
    // with home_club_name gives the consistent label users expect. Falling
    // back to the per-side name lets us tolerate older payloads.
    const homeLabel = composeTeamLabel(match.home_club_name, match.home_team_name);
    const awayLabel = composeTeamLabel(match.away_club_name, match.away_team_name);
    const battingId = current.team_batting_id;
    const battingIsHome =
      battingId != null
        ? battingId === match.home_team_id
        : (current.team_batting_name ?? '').includes(match.home_team_name ?? '__none__');
    const battingTeam = (battingIsHome ? homeLabel : awayLabel) || current.team_batting_name || '';
    const bowlingTeam = (battingIsHome ? awayLabel : homeLabel) || '';

    // Trust array position over `innings_number`: Play-Cricket reuses
    // innings_number=1 on both entries (it appears to be the team's own
    // innings index, not the match-wide one).
    const inningsNumber = currentIdx + 1;
    const oversRaw = current.overs;
    const overs =
      typeof oversRaw === 'number' ? formatOvers(oversRaw) : String(oversRaw ?? '0.0');
    const runs = numOr0(current.runs);
    const wickets = numOr0(current.wickets);

    const previous = currentIdx > 0 ? list[currentIdx - 1] : undefined;
    const previousRuns = previous ? numOr0(previous.runs) : 0;
    const target = inningsNumber >= 2 && previous ? previousRuns + 1 : undefined;
    const oversTotalRaw = numOr0(match.no_of_overs);
    const oversTotal = oversTotalRaw > 0 ? oversTotalRaw : undefined;

    const batters = extractSiteBatters(current.bat);
    const bowler = extractSiteCurrentBowler(current.bowl);
    const lastDismissal = extractSiteLastDismissal(current.bat, current.fow);
    const partnership = extractSitePartnership(runs, oversToBalls(overs), current.fow);
    const recentBalls = await reconstructRecentBalls(env, matchId, runs, wickets, overs);

    return {
      matchId,
      fetchedAt: new Date().toISOString(),
      status: siteAPIStatus(match.result_description ?? match.status ?? match.match_status),
      innings: inningsNumber,
      battingTeam,
      bowlingTeam,
      runs,
      wickets,
      overs,
      ...(typeof target === 'number' ? { target } : {}),
      ...(typeof oversTotal === 'number' ? { oversTotal } : {}),
      ...(batters.length ? { batters } : {}),
      ...(bowler ? { bowler } : {}),
      ...(lastDismissal ? { lastDismissal } : {}),
      ...(partnership ? { partnership } : {}),
      ...(recentBalls.length ? { recentBalls } : {}),
      source: 'play-cricket',
    };
  } catch (e) {
    return failedScore(matchId, e instanceof Error ? e.message : 'site_api_error', 'play-cricket');
  }
}

function composeTeamLabel(club: string | undefined, team: string | undefined): string {
  const c = (club ?? '').trim();
  const t = (team ?? '').trim();
  if (c && t) return `${c} - ${t}`;
  return c || t;
}

function numOr0(v: string | number | undefined): number {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function shortenName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full.trim().toUpperCase();
  const initial = parts[0][0];
  const last = parts[parts.length - 1];
  return `${initial}. ${last}`.toUpperCase();
}

function extractSiteBatters(bat: SiteAPIBat[] | undefined): Batter[] {
  if (!bat) return [];
  const atCrease = bat.filter((b) => (b.how_out ?? '').toLowerCase() === 'not out');
  const ordered = atCrease
    .slice()
    .sort((a, b) => numOr0(a.position) - numOr0(b.position))
    .slice(0, 2);
  if (ordered.length === 0) return [];
  // Striker = the not-out batter who has faced the most balls. Heuristic:
  // when both are at crease, the more-active one is on strike. Tied → first.
  let strikerIdx = 0;
  if (ordered.length === 2 && numOr0(ordered[1].balls) > numOr0(ordered[0].balls)) {
    strikerIdx = 1;
  }
  return ordered.map((b, i) => ({
    name: shortenName(b.batsman_name ?? ''),
    runs: numOr0(b.runs),
    balls: numOr0(b.balls),
    notOut: true,
    ...(i === strikerIdx ? { onStrike: true } : {}),
  }));
}

function extractSiteCurrentBowler(bowl: SiteAPIBowl[] | undefined): Bowler | undefined {
  if (!bowl || bowl.length === 0) return undefined;
  // The bowler whose over is in progress (overs ends in .1–.5) is current.
  // Otherwise fall back to the last entry — that's the most-recently-completed
  // over and likely still the bowler about to bowl.
  const inProgress = bowl
    .slice()
    .reverse()
    .find((b) => {
      const ov = String(b.overs ?? '');
      return /\.[1-5]$/.test(ov);
    });
  const picked = inProgress ?? bowl[bowl.length - 1];
  if (!picked) return undefined;
  const ovRaw = picked.overs;
  const overs =
    typeof ovRaw === 'number' ? formatOvers(ovRaw) : String(ovRaw ?? '0');
  return {
    name: shortenName(picked.bowler_name ?? ''),
    overs,
    maidens: numOr0(picked.maidens),
    runs: numOr0(picked.runs),
    wickets: numOr0(picked.wickets),
  };
}

function extractSiteLastDismissal(
  bat: SiteAPIBat[] | undefined,
  fow: SiteAPIFow[] | undefined,
): LastDismissal | undefined {
  if (!fow || fow.length === 0 || !bat) return undefined;
  const last = fow
    .slice()
    .sort((a, b) => numOr0(b.wickets) - numOr0(a.wickets))[0];
  if (!last?.batsman_out_name) return undefined;
  const card = bat.find((b) => b.batsman_name === last.batsman_out_name);
  if (!card) return undefined;
  const how = (card.how_out ?? '').toLowerCase();
  let dismissalText = card.how_out ?? '';
  if (how === 'b' && card.bowler_name) dismissalText = `b ${shortenName(card.bowler_name)}`;
  else if ((how === 'c' || how === 'ct') && card.fielder_name && card.bowler_name) {
    dismissalText = `c ${shortenName(card.fielder_name)} b ${shortenName(card.bowler_name)}`;
  } else if (how === 'lbw' && card.bowler_name) dismissalText = `lbw b ${shortenName(card.bowler_name)}`;
  else if (how === 'run out') dismissalText = 'run out';
  else if (how === 'st' && card.fielder_name && card.bowler_name) {
    dismissalText = `st ${shortenName(card.fielder_name)} b ${shortenName(card.bowler_name)}`;
  }
  return {
    batter: shortenName(last.batsman_out_name),
    runs: numOr0(card.runs),
    balls: numOr0(card.balls),
    dismissalText,
  };
}

function oversToBalls(overs: string): number {
  const [whole, partial] = String(overs).split('.');
  return numOr0(whole) * 6 + numOr0(partial ?? '0');
}

function extractSitePartnership(
  totalRuns: number,
  totalBalls: number,
  fow: SiteAPIFow[] | undefined,
): Partnership | undefined {
  if (!fow || fow.length === 0) {
    return { runs: totalRuns, balls: totalBalls };
  }
  const last = fow
    .slice()
    .sort((a, b) => numOr0(b.wickets) - numOr0(a.wickets))[0];
  if (!last) return { runs: totalRuns, balls: totalBalls };
  const runsAtFall = numOr0(last.runs);
  // Balls-at-fall isn't returned by Site API. Approximate from current rate —
  // close enough for a UI strip; the partnership ticks accurately ball-by-ball
  // once we're past the wicket.
  return { runs: Math.max(0, totalRuns - runsAtFall), balls: 0 };
}

/**
 * Reconstruct the current over's ball-by-ball strip by diffing successive
 * scrape snapshots from D1. Each scrape captures (runs, wickets, overs) — the
 * delta between two adjacent rows tells us what happened on the ball(s) in
 * between. We can't distinguish all extras (a wide run from a leg-bye), but
 * we can detect: dot, runs scored, wicket, four/six.
 *
 * Caveats acknowledged elsewhere: 4 byes will look like a four; balls
 * bowled between two scrapes get coalesced into a single event.
 */
async function reconstructRecentBalls(
  env: Env,
  matchId: string,
  currentRuns: number,
  currentWickets: number,
  currentOvers: string,
): Promise<BallEvent[]> {
  try {
    const ballsTotal = oversToBalls(currentOvers);
    const overStartBalls = Math.floor(ballsTotal / 6) * 6;
    // Pull the last ~60 rows for this match — enough to cover the current
    // over even at slow scrape rates without pulling a huge history.
    const rows = await env.LOG_DB
      .prepare(
        `SELECT runs, wickets, overs, ts FROM scrape_log
         WHERE match_id = ?1 AND ok = 1
         ORDER BY id DESC LIMIT 60`,
      )
      .bind(matchId)
      .all<{ runs: number; wickets: number; overs: string; ts: number }>();
    const history = (rows.results ?? []).slice().reverse();
    if (history.length < 2) return [];

    const events: BallEvent[] = [];
    let prev = { runs: history[0].runs, wickets: history[0].wickets, balls: oversToBalls(history[0].overs) };
    for (let i = 1; i < history.length; i++) {
      const cur = {
        runs: history[i].runs,
        wickets: history[i].wickets,
        balls: oversToBalls(history[i].overs),
      };
      const ballDelta = cur.balls - prev.balls;
      const runDelta = cur.runs - prev.runs;
      const wktDelta = cur.wickets - prev.wickets;
      // Skip rows where nothing changed.
      if (ballDelta === 0 && runDelta === 0 && wktDelta === 0) {
        prev = cur;
        continue;
      }
      // Extras-only event (runs/wicket but no legal ball): wide or no-ball.
      if (ballDelta === 0 && (runDelta > 0 || wktDelta > 0)) {
        events.push({
          runs: runDelta,
          isWide: true,
          ...(wktDelta > 0 ? { isWicket: true } : {}),
        });
        prev = cur;
        continue;
      }
      // 1+ legal balls bowled. If multiple balls between scrapes, emit one
      // combined event tagged at the last ball position — we can't split.
      if (ballDelta >= 1) {
        events.push({
          runs: runDelta,
          ...(runDelta === 4 ? { isFour: true } : {}),
          ...(runDelta === 6 ? { isSix: true } : {}),
          ...(wktDelta > 0 ? { isWicket: true } : {}),
        });
      }
      prev = cur;
    }

    // Add a virtual tail entry if the latest snapshot already includes the
    // most recent ball (which the loop captured) — nothing extra to do.
    // But we want only events for balls *in the current over*. The history
    // tail tells us how many balls in the current over have been bowled:
    const inThisOver = ballsTotal - overStartBalls;
    void currentRuns; void currentWickets;
    return events.slice(-Math.max(inThisOver, 1)).slice(-6);
  } catch {
    return [];
  }
}

function siteAPIStatus(s: string | undefined): MatchStatus {
  if (!s) return 'unknown';
  const lower = s.toLowerCase();
  if (lower.includes('progress') || lower.includes('live') || lower.includes('innings')) return 'live';
  if (lower.includes('finished') || lower.includes('won') || lower.includes('complete') || lower.includes('result')) return 'finished';
  if (lower.includes('drawn') || lower.includes('draw')) return 'drawn';
  if (lower.includes('abandoned')) return 'abandoned';
  if (lower.includes('cancelled') || lower.includes('canceled')) return 'no_result';
  if (lower.includes('break') || lower.includes('interval') || lower.includes('tea') || lower.includes('lunch')) return 'break';
  return 'unknown';
}

export const playCricketScraper: Scraper = {
  id: 'playcricket',
  label: 'Play-Cricket / ResultsVault',
  scrape(env, sourceUrl) {
    // `sourceUrl` is the Play-Cricket match id (numeric string), passed
    // through verbatim from existing call sites.
    return scrapeMatch(sourceUrl, env);
  },
};

export type MatchStatus =
  | 'live'
  | 'break'
  | 'finished'
  | 'abandoned'
  | 'no_result'
  | 'drawn'
  | 'unknown';

export type Batter = {
  name: string;
  runs: number;
  balls: number;
  notOut: boolean;
  onStrike?: boolean;
};

export type Bowler = {
  name: string;
  overs: string;
  maidens: number;
  runs: number;
  wickets: number;
};

export type BallEvent = {
  runs: number;          // total runs off the ball (incl. extras)
  isWicket?: boolean;
  isFour?: boolean;
  isSix?: boolean;
  isWide?: boolean;
  isNoBall?: boolean;
};

export type LastDismissal = {
  batter: string;
  runs: number;
  balls: number;
  dismissalText: string;
};

export type Partnership = {
  runs: number;
  balls: number;
};

export type Powerplay = 'PP1' | 'PP2' | null;

export type Score = {
  matchId: string;
  fetchedAt: string;
  status: MatchStatus;
  innings: number;
  battingTeam: string;
  bowlingTeam: string;
  runs: number;
  wickets: number;
  overs: string;
  target?: number;
  oversTotal?: number;
  batters?: Batter[];
  bowler?: Bowler;
  recentBalls?: BallEvent[];
  lastDismissal?: LastDismissal;
  partnership?: Partnership;
  powerplay?: Powerplay;
  error?: string;
  stale?: boolean;
  source?: 'play-cricket' | 'resultsvault' | 'mock';
};

export type Env = {
  CRICKET_CACHE: KVNamespace;
  LOG_DB: D1Database;
  AI: Ai;
  PLAY_CRICKET_API_TOKEN?: string;
  ADMIN_KEY?: string;
  ADMIN_KEY_3S?: string;
  ADMIN_KEY_4S?: string;
  // Google Cloud "YouTube Data API v3" key. Used to look up the broadcast's
  // actualStartTime so per-event YouTube deep-links use YouTube's wall-clock
  // rather than whenever the admin pasted the URL. Optional — falls back to
  // Date.now() when absent.
  YOUTUBE_API_KEY?: string;
  // Optional — Play-Cricket club home page used by fixture auto-discovery
  // (e.g. `https://yourclub.play-cricket.com/home`). When unset, `/api/discover`
  // returns an empty list and the admin UI shows no fixture picker.
  DISCOVERY_HOME_URL?: string;
};

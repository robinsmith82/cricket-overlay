import type { Env } from '../types';

/**
 * Identifier for a registered fixture-discovery implementation.
 *
 * Open-ended string union: future feed sources should extend this list
 * (e.g. `'playcricket' | 'someothersource'`). Keeping it a literal union
 * (rather than `string`) means `getDiscovery(id)` can be exhaustively
 * type-checked at the call site.
 */
export type DiscoveryId = 'playcricket';

/**
 * A fixture surfaced by a discovery implementation.
 */
export type DiscoveredMatch = {
  matchId: string;
  battingTeam: string;
  bowlingTeam: string;
  status: string;
  fetchedAt: string;
};

/**
 * Optional per-call hints passed through `Discovery.discover`.
 */
export interface DiscoverOpts {
  // Reserved for future use.
}

/**
 * A single source-of-truth adapter for a club's fixture-discovery feed.
 *
 * Today there's one real implementation (Play-Cricket, scraping the club
 * home page set in `DISCOVERY_HOME_URL`).
 */
export interface Discovery {
  /** Stable identifier used as the registry key. */
  id: DiscoveryId;
  /** Human-readable label, e.g. "Play-Cricket". */
  label: string;
  /**
   * List the matches this feed currently has in flight (or recently played).
   *
   * Implementations are expected to cache their own results — `discover()`
   * may be called frequently (admin UI polling, cron tick) and should not
   * hammer upstream feeds on every call.
   */
  discover(env: Env, opts?: DiscoverOpts): Promise<DiscoveredMatch[]>;
}

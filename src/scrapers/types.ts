import type { Env, Score } from '../types';

/**
 * Identifier for a registered scraper implementation.
 *
 * Open-ended string union: future club integrations should extend this list
 * (e.g. `'playcricket' | 'mock' | 'someothersource'`). Keeping it a literal
 * union (rather than `string`) means `getScraper(id)` can be exhaustively
 * type-checked at the call site.
 */
export type ScraperId = 'playcricket' | 'mock';

/**
 * Optional per-call hints passed through `Scraper.scrape`.
 */
export interface ScrapeOpts {
  /**
   * Mock-only: which innings to synthesise. The Play-Cricket scraper ignores
   * this — innings is always derived from upstream data.
   */
  innings?: 1 | 2;
}

/**
 * A single source-of-truth adapter for a club's live-scoring feed.
 *
 * Today there's one real implementation (Play-Cricket / ResultsVault) plus
 * a mock for OBS testing. Onboarding a second feed source means providing a
 * new `Scraper` and registering it in `src/scrapers/index.ts`.
 */
export interface Scraper {
  /** Stable identifier used as the registry key. */
  id: ScraperId;
  /** Human-readable label, e.g. "Play-Cricket / ResultsVault". */
  label: string;
  /**
   * Fetch the current state of a match.
   *
   * `sourceUrl` is whatever this scraper needs to identify the match. For
   * Play-Cricket today that's the match id (a numeric string), passed
   * through verbatim from existing call sites — when a feed actually uses
   * a URL, the same parameter carries it.
   */
  scrape(env: Env, sourceUrl: string, opts?: ScrapeOpts): Promise<Score>;
}

/**
 * Backwards-compatible shim over the multi-source scraper registry.
 *
 * The actual scraping logic lives in `src/scrapers/` — this module only
 * exists so that existing call sites keep working without edits.
 *
 * - `scrapeMatch(matchId, env)` is hardwired to the Play-Cricket scraper
 *   since that's the only real feed source today. Add a new scraper to
 *   `src/scrapers/` and dispatch off `Club.scraperId` (see `src/clubs.ts`)
 *   to onboard a second feed.
 * - `generateMockScore(innings)` is re-exported from the mock scraper so
 *   `?mock=1` overlay routes keep producing the same synthetic payload.
 */
import type { Env, Score } from './types';
import { getScraper } from './scrapers';

export { generateMockScore } from './scrapers/mock';

export async function scrapeMatch(matchId: string, env: Env): Promise<Score> {
  return getScraper('playcricket').scrape(env, matchId);
}

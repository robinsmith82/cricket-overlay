import { playCricketScraper } from './playcricket';
import { mockScraper } from './mock';
import type { Scraper, ScraperId } from './types';

/**
 * Registry of all available scraper implementations, keyed by `ScraperId`.
 *
 * Adding a new feed source means: implement the `Scraper` contract in a new
 * file under `src/scrapers/`, add the id to `ScraperId`, and register it
 * here.
 */
export const SCRAPERS: Record<ScraperId, Scraper> = {
  playcricket: playCricketScraper,
  mock: mockScraper,
};

export function getScraper(id: ScraperId): Scraper {
  const scraper = SCRAPERS[id];
  if (!scraper) {
    throw new Error(`Unknown scraper id: ${id}`);
  }
  return scraper;
}

export type { Scraper, ScraperId, ScrapeOpts } from './types';
export { playCricketScraper } from './playcricket';
export { mockScraper, generateMockScore } from './mock';

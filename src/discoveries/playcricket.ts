import type { Env } from '../types';
import { scrapeMatch } from '../scraper';
import type { DiscoveredMatch, Discovery } from './types';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CACHE_KEY = 'fixtures:playcricket';
const CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 min

type CacheEnvelope = {
  fetchedAt: string;
  matches: DiscoveredMatch[];
};

class MatchIdCollector {
  ids = new Set<string>();
  element(el: Element): void {
    const href = el.getAttribute('href');
    if (!href) return;
    const m = href.match(/\/website\/results\/(\d+)/);
    if (m) this.ids.add(m[1]);
  }
}

async function scrapeMatchIds(homeUrl: string): Promise<string[]> {
  const res = await fetch(homeUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'follow',
  });
  if (!res.ok) return [];
  const collector = new MatchIdCollector();
  await new HTMLRewriter().on('a[href*="/website/results/"]', collector).transform(res).text();
  return [...collector.ids];
}

async function discoverPlayCricketMatches(env: Env): Promise<DiscoveredMatch[]> {
  const homeUrl = env.DISCOVERY_HOME_URL;
  if (!homeUrl) return [];

  const cachedRaw = await env.CRICKET_CACHE.get(CACHE_KEY);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as CacheEnvelope;
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < CACHE_MAX_AGE_MS) return cached.matches;
    } catch {
      // fall through and refresh
    }
  }

  const ids = await scrapeMatchIds(homeUrl);
  if (ids.length === 0) return [];

  // Fan out summary fetches. scrapeMatch already caches per-match in KV, so
  // repeat lookups are cheap. Cap concurrency by chunks of 5 to avoid worker
  // subrequest pressure.
  const matches: DiscoveredMatch[] = [];
  const chunkSize = 5;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const summaries = await Promise.all(
      chunk.map((id) => scrapeMatch(id, env).catch(() => null)),
    );
    for (const s of summaries) {
      if (!s || s.error || !s.battingTeam) continue;
      matches.push({
        matchId: s.matchId,
        battingTeam: s.battingTeam,
        bowlingTeam: s.bowlingTeam,
        status: s.status,
        fetchedAt: s.fetchedAt,
      });
    }
  }

  const envelope: CacheEnvelope = {
    fetchedAt: new Date().toISOString(),
    matches,
  };
  await env.CRICKET_CACHE.put(CACHE_KEY, JSON.stringify(envelope));
  return matches;
}

export const playCricketDiscovery: Discovery = {
  id: 'playcricket',
  label: 'Play-Cricket',
  discover(env) {
    return discoverPlayCricketMatches(env);
  },
};

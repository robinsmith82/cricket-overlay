import type { Env } from './types';
import { SCRAPERS } from './scrapers';
import { DISCOVERIES } from './discoveries';
import type { ScraperId } from './scrapers/types';
import type { DiscoveryId } from './discoveries/types';

/**
 * A club registered against the overlay. Tier-6 step 3 — pure data model +
 * KV storage + admin UI. Step 4 will wire `scraperId` / `discoveryId` into
 * the scrape pipeline; for now the registry is read-only as far as the
 * existing routes are concerned.
 */
export type Club = {
  /** url-safe, lowercase slug. e.g. "default". Validated against SLUG_REGEX. */
  slug: string;
  /** human display name. e.g. "My Cricket Club". */
  name: string;
  /** which `Scraper` implementation runs for this club's live-scoring feed. */
  scraperId: ScraperId;
  /** which `Discovery` implementation lists this club's fixtures. */
  discoveryId: DiscoveryId;
  /** scraper-specific opts (free-form for now). Step 4 will tighten this. */
  scraperConfig?: Record<string, string>;
  /** discovery-specific opts (free-form for now). Step 4 will tighten this. */
  discoveryConfig?: Record<string, string>;
  /** Set on first write; preserved on subsequent upserts. */
  createdAt: number;
};

/**
 * Slug shape — intentionally tight. Lowercase letters/digits/hyphens, must
 * start with a letter or digit, max 31 chars. Rejects slashes, dots, spaces,
 * and uppercase so step 4 can use the slug verbatim in URL paths.
 */
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,30}$/;

const KV_PREFIX = 'club:';

function kvKey(slug: string): string {
  return `${KV_PREFIX}${slug}`;
}

function isScraperId(id: string): id is ScraperId {
  return Object.prototype.hasOwnProperty.call(SCRAPERS, id);
}

function isDiscoveryId(id: string): id is DiscoveryId {
  return Object.prototype.hasOwnProperty.call(DISCOVERIES, id);
}

/**
 * Read a single club from KV. Returns null if the slug isn't registered or
 * the stored payload doesn't parse as JSON.
 */
export async function readClub(env: Env, slug: string): Promise<Club | null> {
  const raw = await env.CRICKET_CACHE.get(kvKey(slug));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Club;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * List every registered club, sorted by `createdAt` ascending. List + per-key
 * get is two round-trips and not transactional — fine for an admin page; a
 * concurrent upsert during the list pass will at worst show stale data on the
 * next render.
 */
export async function listClubs(env: Env): Promise<Club[]> {
  const list = await env.CRICKET_CACHE.list({ prefix: KV_PREFIX });
  const clubs = await Promise.all(
    list.keys.map(async (k) => {
      const raw = await env.CRICKET_CACHE.get(k.name);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Club;
      } catch {
        return null;
      }
    }),
  );
  return clubs
    .filter((c): c is Club => c !== null)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Validate then upsert. On first write, sets `createdAt`; on subsequent
 * writes, preserves the existing `createdAt` from KV. Throws with a useful
 * message on validation failure — callers should surface this verbatim
 * (admin route maps it to a 400).
 */
export async function upsertClub(
  env: Env,
  club: {
    slug: string;
    name: string;
    scraperId: string;
    discoveryId: string;
    scraperConfig?: Record<string, string>;
    discoveryConfig?: Record<string, string>;
  },
): Promise<Club> {
  const slug = club.slug.trim();
  if (!SLUG_REGEX.test(slug)) {
    throw new Error(
      `Invalid slug "${slug}": must match ${SLUG_REGEX.source} (lowercase letters/digits/hyphens, 1-31 chars, must start with letter or digit).`,
    );
  }
  const name = club.name.trim();
  if (!name) {
    throw new Error('Club name is required.');
  }
  if (!isScraperId(club.scraperId)) {
    throw new Error(
      `Invalid scraperId "${club.scraperId}": must be one of ${Object.keys(SCRAPERS).join(', ')}.`,
    );
  }
  if (!isDiscoveryId(club.discoveryId)) {
    throw new Error(
      `Invalid discoveryId "${club.discoveryId}": must be one of ${Object.keys(DISCOVERIES).join(', ')}.`,
    );
  }

  const existing = await readClub(env, slug);
  const createdAt = existing?.createdAt ?? Date.now();

  const next: Club = {
    slug,
    name,
    scraperId: club.scraperId,
    discoveryId: club.discoveryId,
    createdAt,
  };
  if (club.scraperConfig && Object.keys(club.scraperConfig).length) {
    next.scraperConfig = club.scraperConfig;
  }
  if (club.discoveryConfig && Object.keys(club.discoveryConfig).length) {
    next.discoveryConfig = club.discoveryConfig;
  }

  await env.CRICKET_CACHE.put(kvKey(slug), JSON.stringify(next));
  return next;
}

/**
 * Delete a club by slug. The `default` seed is permanent — refuses to delete
 * it so the admin page never renders an empty registry. Edit it via upsert
 * instead. Admin route maps the throw to a 400.
 */
export async function deleteClub(env: Env, slug: string): Promise<void> {
  if (slug === 'default') {
    throw new Error('Refusing to delete the `default` seed club — edit it instead via upsert.');
  }
  await env.CRICKET_CACHE.delete(kvKey(slug));
}

/**
 * Idempotent first-run seed. If the registry is empty, write a `default`
 * club record so the admin page never renders an empty registry. Re-running
 * once any club exists is a no-op — including after the default has been
 * edited, since we only seed on a fully empty registry.
 *
 * Race-safe: if two requests hit `ensureSeeded` simultaneously and both see
 * an empty list, the second `put` is harmless (same key, same content).
 */
export async function ensureSeeded(env: Env): Promise<void> {
  const list = await env.CRICKET_CACHE.list({ prefix: KV_PREFIX, limit: 1 });
  if (list.keys.length > 0) return;
  const seed: Club = {
    slug: 'default',
    name: 'My Cricket Club',
    scraperId: 'playcricket',
    discoveryId: 'playcricket',
    createdAt: Date.now(),
  };
  await env.CRICKET_CACHE.put(kvKey('default'), JSON.stringify(seed));
}

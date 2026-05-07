import { playCricketDiscovery } from './playcricket';
import type { Discovery, DiscoveryId } from './types';

/**
 * Registry of all available discovery implementations, keyed by `DiscoveryId`.
 *
 * Adding a new feed source means: implement the `Discovery` contract in a
 * new file under `src/discoveries/`, add the id to `DiscoveryId`, and
 * register it here.
 */
export const DISCOVERIES: Record<DiscoveryId, Discovery> = {
  playcricket: playCricketDiscovery,
};

export function getDiscovery(id: DiscoveryId): Discovery {
  const discovery = DISCOVERIES[id];
  if (!discovery) {
    throw new Error(`Unknown discovery id: ${id}`);
  }
  return discovery;
}

export type { Discovery, DiscoveryId, DiscoverOpts, DiscoveredMatch } from './types';
export { playCricketDiscovery } from './playcricket';

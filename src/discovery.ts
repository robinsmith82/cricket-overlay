/**
 * Backwards-compatible shim over the multi-source discovery registry.
 *
 * The actual fixture-discovery logic lives in `src/discoveries/` — this
 * module only exists so that existing call sites (`src/index.ts`,
 * `src/admin.ts`) keep working without edits.
 *
 * - `discoverMatches(env)` is hardwired to the Play-Cricket discovery
 *   since that's the only fixture source today. Add a new discovery to
 *   `src/discoveries/` and dispatch off `Club.discoveryId` to onboard a
 *   second source.
 * - `DiscoveredMatch` is re-exported from the discoveries module so existing
 *   type imports keep resolving without edits.
 */
import type { Env } from './types';
import { getDiscovery } from './discoveries';
import type { DiscoveredMatch } from './discoveries';

export type { DiscoveredMatch } from './discoveries';

export async function discoverMatches(env: Env): Promise<DiscoveredMatch[]> {
  return getDiscovery('playcricket').discover(env);
}

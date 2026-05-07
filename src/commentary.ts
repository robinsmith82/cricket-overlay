import type { Env } from './types';
import { readEvents, type MatchEvent } from './events';

const MODEL = '@cf/meta/llama-3.1-8b-instruct';

const SYSTEM_PROMPT =
  "You are a club-cricket commentator. Write 1-2 short sentences max. " +
  "No emojis. No hype words like 'amazing' or 'incredible'. " +
  "Mention bowler, batter, and outcome where known. Plain past tense.";

export type CommentaryResult = {
  text: string;
  model: string;
  cached: boolean;
  empty?: boolean;
};

function cacheKey(scope: string, matchId: string, overKey: string): string {
  const s = scope || 'default';
  return `commentary:${s}:${matchId}:${overKey}`;
}

/**
 * Lazy per-over commentary generator. Reads stored events for the match,
 * filters to the requested over, and asks Workers AI to summarise. Caches
 * the generated text in KV permanently keyed by scope/match/over. Pass
 * `force` to bypass and regenerate.
 */
export async function getCommentaryForOver(
  env: Env,
  scope: string,
  matchId: string,
  overKey: string,
  force?: boolean,
): Promise<CommentaryResult> {
  const key = cacheKey(scope, matchId, overKey);

  if (!force) {
    const cached = await env.CRICKET_CACHE.get(key);
    if (cached !== null) {
      return { text: cached, model: MODEL, cached: true };
    }
  }

  const allEvents = await readEvents(env, matchId);
  const filteredEvents: MatchEvent[] = allEvents.filter((e) => e.over === overKey);

  if (filteredEvents.length === 0) {
    return { text: '', model: MODEL, cached: false, empty: true };
  }

  const userContent = JSON.stringify({ over: overKey, events: filteredEvents });

  // The exact `@cf/meta/llama-3.1-8b-instruct` slug isn't in the typed
  // AiModels list shipped with @cloudflare/workers-types yet (only the
  // -fp8 / -awq variants are), so we cast through a permissive run shape.
  const ai = env.AI as unknown as {
    run: (
      model: string,
      inputs: {
        messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
        max_tokens?: number;
        temperature?: number;
      },
    ) => Promise<{ response?: string }>;
  };

  const result = await ai.run(MODEL, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    max_tokens: 90,
    temperature: 0.4,
  });

  const text = (result.response ?? '').trim();

  await env.CRICKET_CACHE.put(key, text);

  return { text, model: MODEL, cached: false };
}

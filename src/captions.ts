import type { Env } from './types';
import { readEvents, type MatchEvent } from './events';
import { parseOverBall, readBallTag } from './archive';

export const MODEL = '@cf/meta/llama-3.1-8b-instruct';

const SYSTEM_PROMPT =
  'Write ONE short caption (max 12 words) for a club-cricket highlight clip. ' +
  'Past tense. No emojis. No hype words. Include batter, shot type if known, ' +
  'outcome, bowler, and over number where relevant. ' +
  "Style: 'Smith's slog-sweep for six off Patel, 14th over.'";

export type CaptionResult = {
  text: string;
  model: string;
  cached: boolean;
  empty?: boolean;
};

function cacheKey(matchId: string, eventIdx: number): string {
  return `caption:${matchId}:${eventIdx}`;
}

/**
 * Mechanical fallback caption for events where we don't want to spend a model
 * call (e.g. team-milestone with no batter/bowler). Mirrors the shape of
 * share.ts's `headlineFor` + `sublineFor` joined into a single line, so the
 * subline stays useful when the model isn't invoked.
 */
function mechanicalCaption(e: MatchEvent): string {
  const who = e.batter || 'Batter';
  const head = (() => {
    switch (e.type) {
      case 'wicket': return `${who} out`;
      case '4': return `${who} four`;
      case '6': return `${who} six`;
      case 'fifty': return `${who} fifty`;
      case 'hundred': return `${who} hundred`;
      case 'team-milestone': return `Team passes ${e.runs ?? ''}`.trim();
      default: return e.type;
    }
  })();
  const sub = (() => {
    switch (e.type) {
      case 'wicket': return e.context ? e.context : (e.bowler ? `b ${e.bowler}` : '');
      case '4':
      case '6': return e.bowler ? `off ${e.bowler}` : '';
      case 'fifty':
      case 'hundred': return e.runs ? `${e.runs}*` : '';
      case 'team-milestone': return '';
      default: return '';
    }
  })();
  const overTail = e.over ? `, over ${e.over}` : '';
  return sub ? `${head}, ${sub}${overTail}` : `${head}${overTail}`;
}

/**
 * Lazy AI caption generator for a single event. Pulls the indexed event,
 * looks up the matching ball-tag (for shot type), and asks Workers AI for
 * a one-line caption in the requested house style. Cached in KV keyed by
 * match + event index. Pass `force` to bypass and regenerate.
 *
 * If the event index is out of range, returns `{empty: true}`. If the event
 * has neither batter nor bowler (rare team-milestone), we skip the model
 * call entirely and return a mechanical caption — no point burning tokens
 * on an empty input.
 */
export async function getCaption(
  env: Env,
  matchId: string,
  eventIdx: number,
  force?: boolean,
): Promise<CaptionResult> {
  const key = cacheKey(matchId, eventIdx);

  if (!force) {
    const cached = await env.CRICKET_CACHE.get(key);
    if (cached !== null) {
      return { text: cached, model: MODEL, cached: true };
    }
  }

  const events = await readEvents(env, matchId);
  const evt = Number.isFinite(eventIdx) && eventIdx >= 0 && eventIdx < events.length ? events[eventIdx] : null;

  if (!evt) {
    return { text: '', model: MODEL, cached: false, empty: true };
  }

  // No batter and no bowler — almost always a team-milestone event with
  // nothing to say beyond the mechanical text. Don't spend a model call.
  if (!evt.batter && !evt.bowler) {
    const text = mechanicalCaption(evt);
    return { text, model: MODEL, cached: false };
  }

  // Look up the per-ball tag (shot type) if one was recorded. Tags may not
  // exist (taggers are optional), so a null result is fine.
  let shot: string | undefined;
  const ob = parseOverBall(evt.over);
  if (ob) {
    try {
      const tag = await readBallTag(env, matchId, evt.innings, ob.over, ob.ball);
      shot = tag?.shot;
    } catch {
      // tag lookup failures are non-fatal — fall through without a shot
    }
  }

  const inputs = {
    type: evt.type,
    batter: evt.batter ?? null,
    bowler: evt.bowler ?? null,
    over: evt.over,
    runs: evt.runs ?? null,
    context: evt.context ?? null,
    shot: shot ?? null,
  };
  const userContent = JSON.stringify(inputs);

  // The exact `@cf/meta/llama-3.1-8b-instruct` slug isn't in the typed
  // AiModels list shipped with @cloudflare/workers-types yet (only the
  // -fp8 / -awq variants are), so we cast through a permissive run shape.
  // Same pattern as src/commentary.ts.
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
    max_tokens: 40,
    temperature: 0.4,
  });

  const text = trimToOneSentence((result.response ?? '').trim());

  await env.CRICKET_CACHE.put(key, text);

  return { text, model: MODEL, cached: false };
}

/**
 * Llama sometimes adds a second sentence ("Great shot. The crowd loved it.")
 * or trailing quotes from being asked to mimic a quoted style. Keep the
 * first sentence and strip surrounding quote characters / leading labels.
 */
function trimToOneSentence(s: string): string {
  if (!s) return '';
  let out = s.trim();
  // Strip a leading "Caption:" label if the model decided to be helpful.
  out = out.replace(/^("|')?caption:\s*/i, '');
  // Strip wrapping quotes.
  out = out.replace(/^["'`]+|["'`]+$/g, '').trim();
  // Keep only the first sentence.
  const firstStop = out.search(/[.!?](\s|$)/);
  if (firstStop >= 0) {
    out = out.slice(0, firstStop + 1);
  }
  return out.trim();
}

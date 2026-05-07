import type { Env, Score } from './types';
import { readEvents, type MatchEvent } from './events';

export const MODEL = '@cf/meta/llama-3.1-8b-instruct';

const SYSTEM_PROMPT =
  "You are writing a club-cricket match report for a club newsletter. " +
  "Write roughly 200 words across 2-3 short paragraphs in plain past tense. " +
  "Mention the top batter, the top bowler, key turning points, and the final result. " +
  "No emojis. No hype words like 'amazing', 'incredible', 'thrilling', 'stunning'. " +
  "Plain factual prose, club-newsletter tone. Do not invent numbers or names " +
  "that aren't in the supplied data.";

export type MatchReportResult = {
  text: string;
  model: string;
  cached: boolean;
  generatedAt: number;
  empty?: boolean;
};

type StoredReport = {
  text: string;
  model: string;
  generatedAt: number;
};

function cacheKey(scope: string, matchId: string): string {
  const s = scope || 'default';
  return `report:${s}:${matchId}`;
}

type InningsSummary = {
  battingTeam: string;
  runs: number;
  wickets: number;
  overs: string;
};

type BatterLine = { name: string; fours: number; sixes: number; milestone?: 'fifty' | 'hundred' };
type BowlerLine = { name: string; wickets: number };
type KeyEventLine = {
  type: MatchEvent['type'];
  over: string;
  innings: number;
  batter?: string;
  bowler?: string;
  runs?: number;
  context?: string;
};

/** Build a compact JSON payload for the model. Keep it small — 8B-instruct
 * chokes on huge prompts. We collapse the events list to the moments that
 * actually shape a match report: first wicket per innings, every fifty/
 * hundred, and the last wicket per innings. */
function buildPayload(score: Score, events: MatchEvent[]): {
  result: string;
  innings: InningsSummary[];
  topBatters: BatterLine[];
  topBowlers: BowlerLine[];
  keyEvents: KeyEventLine[];
} {
  // Per-innings final state. We only ever have the latest scrape
  // snapshot for the live/final innings, so the prior innings is
  // reconstructed from the target (chase target = first innings runs + 1).
  const innings: InningsSummary[] = [];
  if (score.innings >= 2 && typeof score.target === 'number' && score.target > 0) {
    innings.push({
      battingTeam: score.bowlingTeam || '',
      runs: score.target - 1,
      wickets: 0,
      overs: '',
    });
  }
  innings.push({
    battingTeam: score.battingTeam || '',
    runs: score.runs | 0,
    wickets: score.wickets | 0,
    overs: score.overs || '',
  });

  // Top performers — derived from events. Same shape as src/summary.ts uses,
  // re-derived cheaply rather than exporting a helper from there.
  const fours: Record<string, number> = {};
  const sixes: Record<string, number> = {};
  const wicketsByBowler: Record<string, number> = {};
  const milestoneByBatter: Record<string, 'fifty' | 'hundred'> = {};
  for (const e of events) {
    if (e.type === '4' && e.batter) fours[e.batter] = (fours[e.batter] ?? 0) + 1;
    if (e.type === '6' && e.batter) sixes[e.batter] = (sixes[e.batter] ?? 0) + 1;
    if (e.type === 'wicket' && e.bowler) wicketsByBowler[e.bowler] = (wicketsByBowler[e.bowler] ?? 0) + 1;
    if (e.type === 'fifty' && e.batter) milestoneByBatter[e.batter] = milestoneByBatter[e.batter] === 'hundred' ? 'hundred' : 'fifty';
    if (e.type === 'hundred' && e.batter) milestoneByBatter[e.batter] = 'hundred';
  }

  const batterScore: Record<string, number> = {};
  for (const [n, c] of Object.entries(fours)) batterScore[n] = (batterScore[n] ?? 0) + c * 4;
  for (const [n, c] of Object.entries(sixes)) batterScore[n] = (batterScore[n] ?? 0) + c * 6;
  for (const n of Object.keys(milestoneByBatter)) {
    batterScore[n] = (batterScore[n] ?? 0) + (milestoneByBatter[n] === 'hundred' ? 1000 : 500);
  }
  const topBatters: BatterLine[] = Object.keys(batterScore)
    .sort((a, b) => batterScore[b] - batterScore[a])
    .slice(0, 3)
    .map((n) => ({
      name: n,
      fours: fours[n] ?? 0,
      sixes: sixes[n] ?? 0,
      milestone: milestoneByBatter[n],
    }));

  const topBowlers: BowlerLine[] = Object.entries(wicketsByBowler)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, w]) => ({ name, wickets: w }));

  // Key events — first wicket / fifty / hundred / last wicket per innings.
  const keyEvents: KeyEventLine[] = [];
  const inningsSet = new Set(events.map((e) => e.innings));
  for (const inn of Array.from(inningsSet).sort()) {
    const inEvents = events.filter((e) => e.innings === inn);
    const firstWicket = inEvents.find((e) => e.type === 'wicket');
    if (firstWicket) keyEvents.push(toKey(firstWicket));
    for (const e of inEvents) {
      if (e.type === 'fifty' || e.type === 'hundred') keyEvents.push(toKey(e));
    }
    const wickets = inEvents.filter((e) => e.type === 'wicket');
    const lastWicket = wickets[wickets.length - 1];
    if (lastWicket && lastWicket !== firstWicket) keyEvents.push(toKey(lastWicket));
  }

  return {
    result: describeResult(score),
    innings,
    topBatters,
    topBowlers,
    keyEvents,
  };
}

function toKey(e: MatchEvent): KeyEventLine {
  return {
    type: e.type,
    over: e.over,
    innings: e.innings,
    batter: e.batter,
    bowler: e.bowler,
    runs: e.runs,
    context: e.context,
  };
}

function describeResult(score: Score): string {
  if (score.status === 'finished') {
    if (score.innings >= 2 && typeof score.target === 'number') {
      const chased = score.runs >= score.target;
      if (chased) return `${score.battingTeam} won by ${10 - score.wickets} wickets`;
      const margin = score.target - 1 - score.runs;
      if (margin > 0) return `${score.bowlingTeam} won by ${margin} runs`;
      return 'Match tied';
    }
    return `Match finished — ${score.battingTeam} ${score.runs}/${score.wickets}`;
  }
  if (score.status === 'abandoned') return 'Match abandoned';
  if (score.status === 'no_result') return 'No result';
  if (score.status === 'drawn') return 'Match drawn';
  return `Match in progress — ${score.battingTeam} ${score.runs}/${score.wickets} (${score.overs})`;
}

/**
 * Lazy match-report generator. Reads stored events and the last-good score
 * for the match, asks Workers AI for a ~200-word newsletter writeup, caches
 * the generated text in KV permanently keyed by scope/match. Pass `force`
 * to bypass and regenerate.
 */
export async function getMatchReport(
  env: Env,
  scope: string,
  matchId: string,
  force?: boolean,
): Promise<MatchReportResult> {
  const key = cacheKey(scope, matchId);

  if (!force) {
    const cachedRaw = await env.CRICKET_CACHE.get(key);
    if (cachedRaw !== null) {
      try {
        const parsed = JSON.parse(cachedRaw) as StoredReport;
        return {
          text: parsed.text,
          model: parsed.model || MODEL,
          cached: true,
          generatedAt: parsed.generatedAt,
        };
      } catch {
        // legacy/plaintext cache value — fall through to regenerate
      }
    }
  }

  const events = await readEvents(env, matchId);
  if (events.length === 0) {
    return { text: '', model: MODEL, cached: false, generatedAt: 0, empty: true };
  }

  // Final-state score lives at `score:{matchId}:last_good` (set by the
  // scraper path in src/index.ts). That's the "final per-innings state"
  // the prompt refers to.
  let score: Score | null = null;
  const lastGoodRaw = await env.CRICKET_CACHE.get(`score:${matchId}:last_good`);
  if (lastGoodRaw) {
    try { score = JSON.parse(lastGoodRaw) as Score; } catch { /* ignore */ }
  }
  if (!score) {
    return { text: '', model: MODEL, cached: false, generatedAt: 0, empty: true };
  }

  const payload = buildPayload(score, events);
  const userContent = JSON.stringify(payload);

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
    max_tokens: 350,
    temperature: 0.5,
  });

  const text = (result.response ?? '').trim();
  const generatedAt = Date.now();
  const stored: StoredReport = { text, model: MODEL, generatedAt };
  await env.CRICKET_CACHE.put(key, JSON.stringify(stored));

  return { text, model: MODEL, cached: false, generatedAt };
}

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { scrapeMatch } from './scraper';
import type { Env } from './types';

// ---- Fixtures -------------------------------------------------------------
//
// Hand-trimmed Play-Cricket match_detail v2 sample for match 7237783 captured
// from a live in-progress 2nd-innings request. Three regressions are gated by
// these invariants:
//   1. innings_number is reused as 1 on both entries → must trust array
//      position to detect the current innings.
//   2. team_batting_name is the composite "<club> - <team>" but the per-side
//      home_team_name / away_team_name are just the team variant. Matching by
//      team_batting_id keeps batting/bowling labels consistent.
//   3. no_of_overs lives at the match level, not per-innings.

const TEAM_HOME_ID = '380307'; // Home Club — 1st XI
const TEAM_AWAY_ID = '278726'; // Away Club — Women's XI

const HOME_LABEL = 'Home Club CC - 1st XI';
const AWAY_LABEL = "Away Club CC - Women's XI";

function basePayload() {
  return {
    match_details: [
      {
        id: 7237783,
        result_description: 'Match In Progress',
        home_team_name: '1st XI',
        home_team_id: TEAM_HOME_ID,
        home_club_name: 'Home Club CC',
        away_team_name: "Women's XI",
        away_team_id: TEAM_AWAY_ID,
        away_club_name: 'Away Club CC',
        no_of_overs: '40',
        innings: [
          {
            team_batting_name: AWAY_LABEL,
            team_batting_id: TEAM_AWAY_ID,
            innings_number: 1,
            runs: '185',
            wickets: '9',
            overs: '36.1',
            bat: [],
            bowl: [],
            fow: [],
          },
          {
            team_batting_name: HOME_LABEL,
            team_batting_id: TEAM_HOME_ID,
            innings_number: 1,
            runs: '47',
            wickets: '5',
            overs: '11',
            bat: [],
            bowl: [],
            fow: [],
          },
        ],
      },
    ],
  };
}

// ---- Stubs ----------------------------------------------------------------

function stubEnv(): Env {
  const kv = new Map<string, string>();
  const cache = {
    get: async (k: string) => kv.get(k) ?? null,
    put: async (k: string, v: string) => {
      kv.set(k, v);
    },
    delete: async (k: string) => {
      kv.delete(k);
    },
    list: async () => ({ keys: [] }),
  } as unknown as KVNamespace;

  // D1 stub: every prepare(...).bind(...).all() returns no rows so
  // reconstructRecentBalls short-circuits to [] and the score path stays
  // synchronous-looking.
  const db = {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: [] }),
      }),
    }),
  } as unknown as D1Database;

  return {
    CRICKET_CACHE: cache,
    LOG_DB: db,
    AI: {} as Ai,
    PLAY_CRICKET_API_TOKEN: 'stub-token',
  };
}

type FetchInput = string | URL | Request;
const originalFetch = globalThis.fetch;

function installFetchStub(payload: unknown) {
  globalThis.fetch = (async (input: FetchInput) => {
    const url = typeof input === 'string' ? input : 'url' in input ? input.url : String(input);
    if (!url.includes('match_detail.json')) {
      throw new Error(`Unexpected fetch in test: ${url}`);
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  /* fetch installed per-test */
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---- Tests ----------------------------------------------------------------

describe('scrapeViaSiteAPI (via scrapeMatch)', () => {
  test('reports innings 2 when both innings present, with target + oversTotal', async () => {
    installFetchStub(basePayload());
    const score = await scrapeMatch('7237783', stubEnv());

    expect(score.source).toBe('play-cricket');
    expect(score.innings).toBe(2);
    expect(score.runs).toBe(47);
    expect(score.wickets).toBe(5);
    expect(score.overs).toBe('11');
    expect(score.target).toBe(186); // 185 + 1
    expect(score.oversTotal).toBe(40);
  });

  test('assigns batting + bowling labels by team_batting_id (Club - Team)', async () => {
    installFetchStub(basePayload());
    const score = await scrapeMatch('7237783', stubEnv());

    expect(score.battingTeam).toBe(HOME_LABEL);
    expect(score.bowlingTeam).toBe(AWAY_LABEL);
  });

  test('reports innings 1 with no target when only first innings is present', async () => {
    const payload = basePayload();
    payload.match_details[0].innings = [payload.match_details[0].innings[0]];
    installFetchStub(payload);

    const score = await scrapeMatch('7237783', stubEnv());

    expect(score.innings).toBe(1);
    expect(score.runs).toBe(185);
    expect(score.target).toBeUndefined();
    expect(score.battingTeam).toBe(AWAY_LABEL);
    expect(score.bowlingTeam).toBe(HOME_LABEL);
    expect(score.oversTotal).toBe(40);
  });

  test('falls back to team_batting_name when team_batting_id is missing', async () => {
    const payload = basePayload();
    // Strip the id from the current (2nd) innings — fallback path must still
    // pick the right side via substring matching against home_team_name.
    delete (payload.match_details[0].innings[1] as { team_batting_id?: string }).team_batting_id;
    installFetchStub(payload);

    const score = await scrapeMatch('7237783', stubEnv());

    expect(score.battingTeam).toBe(HOME_LABEL);
    expect(score.bowlingTeam).toBe(AWAY_LABEL);
  });
});

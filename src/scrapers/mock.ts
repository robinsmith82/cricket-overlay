import type { BallEvent, Batter, Bowler, Score } from '../types';
import type { Scraper } from './types';

function mockRecentBalls(ballsTotal: number, wkts: number): BallEvent[] {
  // Deterministic 6-ball trail derived from the ball counter so it cycles
  // visibly. Uses a small palette of outcomes weighted to look real-ish.
  const out: BallEvent[] = [];
  for (let i = 5; i >= 0; i--) {
    const idx = ballsTotal - i;
    if (idx <= 0) continue;
    // Hash the index into one of a few outcomes.
    const r = ((idx * 2654435761) >>> 0) % 100;
    if (r < 38) out.push({ runs: 0 });
    else if (r < 60) out.push({ runs: 1 });
    else if (r < 75) out.push({ runs: 2 });
    else if (r < 82) out.push({ runs: 3 });
    else if (r < 90) out.push({ runs: 4, isFour: true });
    else if (r < 94) out.push({ runs: 6, isSix: true });
    else if (r < 96) out.push({ runs: 1, isWide: true });
    else if (r < 98) out.push({ runs: 1, isNoBall: true });
    else out.push({ runs: 0, isWicket: true });
  }
  // Sanity: keep wicket dot in trail only if wickets > 0
  if (wkts === 0) for (const b of out) if (b.isWicket) { b.isWicket = false; b.runs = 0; }
  return out;
}

export function generateMockScore(innings: 1 | 2 = 1): Score {
  const now = new Date();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const balls = Math.floor((minutes * 60 + seconds) / 5);
  const overs = `${Math.floor(balls / 6)}.${balls % 6}`;
  const runs = Math.floor(balls * 1.4);
  const wickets = Math.min(Math.floor(balls / 25), 9);

  // Synthetic batters + bowler driven by the same wall-clock so the numbers
  // visibly tick up alongside the team total.
  const strikerRuns = Math.max(0, Math.floor(runs * 0.42));
  const strikerBalls = Math.max(0, Math.floor(balls * 0.55));
  const partnerRuns = Math.max(0, Math.floor(runs * 0.28));
  const partnerBalls = Math.max(0, Math.floor(balls * 0.4));
  const batters: Batter[] = [
    { name: 'R. SMITH', runs: strikerRuns, balls: strikerBalls, notOut: true, onStrike: true },
    { name: 'J. PATEL', runs: partnerRuns, balls: partnerBalls, notOut: true },
  ];
  const bowlerOversBalls = Math.max(0, Math.floor(balls / 3));
  const bowler: Bowler = {
    name: 'A. KHAN',
    overs: `${Math.floor(bowlerOversBalls / 6)}.${bowlerOversBalls % 6}`,
    maidens: Math.min(2, Math.floor(bowlerOversBalls / 18)),
    runs: Math.max(0, Math.floor(runs * 0.45)),
    wickets: Math.min(wickets, 3),
  };

  if (innings === 2) {
    // 2nd innings demo: side-batting chasing 187. Drive same wall-clock to make
    // RR / REQ / target visible.
    const target = 187;
    const chaseRuns = Math.min(target + 5, runs);
    const chaseWkts = Math.min(7, wickets);
    return {
      matchId: 'mock',
      fetchedAt: now.toISOString(),
      status: 'live',
      innings: 2,
      battingTeam: 'Home CC 4th XI',
      bowlingTeam: 'Away CC 4th XI',
      runs: chaseRuns,
      wickets: chaseWkts,
      overs,
      oversTotal: 50,
      target,
      batters: [
        { name: 'R. SMITH', runs: Math.floor(chaseRuns * 0.5), balls: Math.floor(balls * 0.55), notOut: true, onStrike: true },
        { name: 'J. PATEL', runs: Math.floor(chaseRuns * 0.32), balls: Math.floor(balls * 0.4), notOut: true },
      ],
      bowler: {
        name: 'A. KHAN',
        overs: `${Math.floor(balls / 18)}.${(balls % 18) % 6}`,
        maidens: 1,
        runs: Math.floor(chaseRuns * 0.4),
        wickets: Math.min(2, chaseWkts),
      },
      recentBalls: mockRecentBalls(balls, chaseWkts),
      partnership: { runs: 42, balls: 38 },
      powerplay: null,
    };
  }

  return {
    matchId: 'mock',
    fetchedAt: now.toISOString(),
    status: 'live',
    innings: 1,
    battingTeam: 'Home CC 4th XI',
    bowlingTeam: 'Away CC 4th XI',
    runs,
    wickets,
    overs,
    oversTotal: 50,
    batters,
    bowler,
    recentBalls: mockRecentBalls(balls, wickets),
    partnership: { runs: strikerRuns + partnerRuns, balls: strikerBalls + partnerBalls },
    powerplay: Math.floor(balls / 6) < 10 ? 'PP1' : null,
    ...(wickets > 0
      ? {
          lastDismissal: {
            batter: 'M. JONES',
            runs: 23,
            balls: 18,
            dismissalText: 'c PATEL b KHAN',
          },
        }
      : {}),
  };
}

export const mockScraper: Scraper = {
  id: 'mock',
  label: 'Mock (OBS testing)',
  async scrape(_env, _sourceUrl, opts) {
    return generateMockScore(opts?.innings ?? 1);
  },
};

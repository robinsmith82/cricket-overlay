import type { Env } from './types';
import { readEvents, type MatchEvent } from './events';
import type { BrandingConfig } from './branding';

const SCOPE_LABELS: Record<string, string> = {
  '3s': '3rd XI',
  '4s': '4th XI',
};

const TYPE_STYLES: Record<MatchEvent['type'], { label: string; accent: string; icon: string }> = {
  wicket: { label: 'WICKET', accent: '#ff4d6d', icon: 'OUT' },
  '4': { label: 'FOUR', accent: '#4189ff', icon: '4' },
  '6': { label: 'SIX', accent: '#ff4d9b', icon: '6' },
  fifty: { label: 'FIFTY', accent: '#ffd23a', icon: '50' },
  hundred: { label: 'HUNDRED', accent: '#ffd23a', icon: '100' },
  'team-milestone': { label: 'MILESTONE', accent: '#3ddc84', icon: '·' },
  moment: { label: 'MOMENT', accent: '#c9b46c', icon: '★' },
};

/**
 * Per-ball SVG share card. 1200x630 (OG-card aspect) so it can also be served
 * as og:image when we later add SVG→PNG conversion.
 */
export async function renderShareCardSvg(
  env: Env,
  matchId: string,
  scope: string,
  eventIdx: number,
  _branding: BrandingConfig,
  caption?: string,
): Promise<string> {
  const events = await readEvents(env, matchId);
  const evt = Number.isFinite(eventIdx) && eventIdx >= 0 && eventIdx < events.length ? events[eventIdx] : null;
  const scopeLabel = SCOPE_LABELS[scope] ?? '';

  if (!evt) {
    return fallbackCard('Clip not found', `Event ${eventIdx} doesn't exist for this match.`);
  }

  const style = TYPE_STYLES[evt.type] ?? { label: evt.type.toUpperCase(), accent: '#8a93a4', icon: '·' };
  const headline = headlineFor(evt);
  // Prefer the AI caption as the subline when present — it carries shot
  // type / bowler / over in one human sentence. Fall back to the existing
  // mechanical line when the caption is absent or empty.
  const subline = (caption && caption.trim()) ? caption.trim() : sublineFor(evt);

  const W = 1200, H = 630;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1a1f2b"/>
      <stop offset="100%" stop-color="#0e1116"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${style.accent}" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="${style.accent}" stop-opacity="0.25"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="0" y="0" width="14" height="${H}" fill="${style.accent}"/>
  <rect x="0" y="${H - 6}" width="${W}" height="6" fill="url(#accent)"/>

  <!-- scope chip -->
  <text x="60" y="80" font-family="Helvetica,Arial,sans-serif" font-size="22" font-weight="800" fill="#ffd23a" letter-spacing="6">${escapeXml((scopeLabel || 'CRICKET').toUpperCase())}</text>

  <!-- type badge -->
  <rect x="58" y="110" rx="6" ry="6" width="${textWidth(style.label, 26) + 40}" height="50" fill="${style.accent}" fill-opacity="0.18" stroke="${style.accent}" stroke-opacity="0.6"/>
  <text x="78" y="145" font-family="Helvetica,Arial,sans-serif" font-size="26" font-weight="800" fill="${style.accent}" letter-spacing="4">${escapeXml(style.label)}</text>

  <!-- big icon column -->
  <text x="${W - 80}" y="${H / 2 + 40}" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="220" font-weight="900" fill="${style.accent}" fill-opacity="0.85">${escapeXml(style.icon)}</text>

  <!-- headline -->
  <text x="60" y="${H / 2}" font-family="Helvetica,Arial,sans-serif" font-size="64" font-weight="800" fill="#ffffff">${escapeXml(headline)}</text>
  <text x="60" y="${H / 2 + 70}" font-family="Helvetica,Arial,sans-serif" font-size="28" font-weight="500" fill="#8a93a4">${escapeXml(subline)}</text>

  <!-- footer -->
  <text x="60" y="${H - 50}" font-family="Helvetica,Arial,sans-serif" font-size="20" font-weight="700" fill="#8a93a4" letter-spacing="3">OVER ${escapeXml(evt.over)} · INNINGS ${evt.innings}</text>
</svg>`;
}

function headlineFor(e: MatchEvent): string {
  const who = e.batter || 'Batter';
  switch (e.type) {
    case 'wicket': return `${who} OUT`;
    case '4': return `${who} · FOUR`;
    case '6': return `${who} · SIX!`;
    case 'fifty': return `${who} · 50`;
    case 'hundred': return `${who} · 💯 100!`;
    case 'team-milestone': return `Team passes ${e.runs}`;
    default: return e.type;
  }
}
function sublineFor(e: MatchEvent): string {
  switch (e.type) {
    case 'wicket': return e.context ? e.context : (e.bowler ? `b ${e.bowler}` : 'dismissed');
    case '4':
    case '6': return e.bowler ? `off ${e.bowler}` : '';
    case 'fifty':
    case 'hundred': return e.runs ? `${e.runs}*` : '';
    case 'team-milestone': return 'team milestone';
    default: return '';
  }
}

function textWidth(s: string, fontSize: number): number {
  // Rough monospace-ish estimate good enough for sizing the badge box.
  return Math.ceil(s.length * fontSize * 0.62);
}

function fallbackCard(title: string, desc: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="#0e1116"/>
  <text x="600" y="300" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="48" font-weight="800" fill="#ffd23a">${escapeXml(title)}</text>
  <text x="600" y="360" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="24" fill="#8a93a4">${escapeXml(desc)}</text>
</svg>`;
}

function escapeXml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string));
}

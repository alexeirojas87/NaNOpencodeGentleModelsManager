// orchestration-v2 WU-C 3.1 (spec TH-4) — WCAG 2.1 AA contrast gate for the
// light theme. This test reads the real `styles.css`, resolves the :root
// custom properties and computes the relative-luminance ratio for a pinned
// pair table: every text-role pair MUST reach ≥4.5:1 and every UI/focus pair
// ≥3:1 on its ACTUAL surface (TH-4 wording). Pair endpoints are pinned by
// token NAME, never by literal hex, so the one-knob retheme allowed by TH-1
// keeps this gate meaningful: change a token and the table re-proves (or
// re-breaks) accessibility. A missing token fails as "not declared" — the
// same math also guards RED on a dark-first token set.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** 6-digit hex values only — the token block convention this change keeps. */
function rootTokens(css: string): Map<string, string> {
  const root = css.match(/:root\s*\{([^}]*)\}/s);
  if (!root) throw new Error('no :root token block found in styles.css');
  const tokens = new Map<string, string>();
  for (const m of root[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens.set(m[1], (m[2] as string).toLowerCase());
  }
  return tokens;
}

// vitest runs with the repo root as cwd; resolve the stylesheet from there
// because the jsdom environment rewrites import.meta.url to an http scheme.
const tokens = rootTokens(
  readFileSync(resolve(process.cwd(), 'web/src/styles.css'), 'utf8'),
);

function token(name: string): string {
  const value = tokens.get(name);
  if (!value) {
    throw new Error(
      `theme token ${name} is not declared as a 6-digit hex custom property`,
    );
  }
  return value;
}

/** WCAG 2.1 relative luminance over an sRGB hex color. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrastRatio(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// [label, foreground token, background token] — the pinned table.
const TEXT_PAIRS: [string, string, string][] = [
  ['body text on card surface', '--text', '--surface'],
  ['body text on page background', '--text', '--bg'],
  ['muted text on card surface', '--muted', '--surface'],
  ['muted text on page background', '--muted', '--bg'],
  ['links and primary labels on surface', '--accent-strong', '--surface'],
  [
    'button text on primary background',
    '--on-accent-strong',
    '--accent-strong',
  ],
  ['button text on primary hover', '--on-accent-strong', '--accent-active'],
  ['warning text on surface', '--warning', '--surface'],
  ['warning text on page background', '--warning', '--bg'],
  ['restart banner text on its tint', '--warning', '--warning-tint'],
  ['icon glyph on blue tile', '--tile-blue-fg', '--tile-blue-bg'],
  ['icon glyph on green tile', '--tile-green-fg', '--tile-green-bg'],
  ['icon glyph on purple tile', '--tile-purple-fg', '--tile-purple-bg'],
  ['icon glyph on yellow tile', '--tile-yellow-fg', '--tile-yellow-bg'],
  ['icon glyph on neutral tile', '--tile-neutral-fg', '--tile-neutral-bg'],
];

const UI_PAIRS: [string, string, string][] = [
  ['focus ring on card surface', '--accent', '--surface'],
  ['focus ring on page background', '--accent', '--bg'],
  ['active nav pill against page', '--accent-strong', '--bg'],
];

describe('WCAG 2.1 AA contrast over the :root token set (TH-4)', () => {
  for (const [label, fg, bg] of TEXT_PAIRS) {
    it(`${label} >= 4.5:1`, () => {
      expect(contrastRatio(token(fg), token(bg))).toBeGreaterThanOrEqual(4.5);
    });
  }
  for (const [label, fg, bg] of UI_PAIRS) {
    it(`${label} >= 3:1`, () => {
      expect(contrastRatio(token(fg), token(bg))).toBeGreaterThanOrEqual(3);
    });
  }
});

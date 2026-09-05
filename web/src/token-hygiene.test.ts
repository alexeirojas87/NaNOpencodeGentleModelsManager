// orchestration-v2 remediation W-1 — committed TH-1/TH-2 evidence gate. The
// scenarios were proven only by one-off command audits; this makes them
// provable at every `pnpm test`. Machinery mirrors contrast.test.ts (fs read +
// pure parsing, no browser), picked up by the same `web` vitest project glob.
// TH-1 one-knob-retheme: colors/radii/shadows exist ONLY in :root — (a) zero
// color literals in styles.css outside :root, (b) zero in any component
// (*.tsx, string literals included), (c) non-:root border-radius/box-shadow
// are bare var()s; so a token edit re-skins all four views with no view edits.
// TH-2 modals-light: --bg/--surface pass a light luminance floor and every
// audited surface class sources background/color via var(), riding that set.
// Nuance: .overlay paints var(--overlay) — a dark translucent SCRIM backdrop,
// not a surface; the modal on top of it is .modal, which rides --surface.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Hex (#rgb..#rrggbbaa), rgb()/rgba(), hsl()/hsla(). `srgb` in color-mix()
// cannot match: \b fails on the leading "s".
const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/;

// vitest runs with the repo root as cwd (see the note in contrast.test.ts).
const css = readFileSync(
  resolve(process.cwd(), 'web/src/styles.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ''); // tolerate hex prose inside comments
const rootBlock = css.match(/:root\s*\{([^}]*)\}/s);
if (!rootBlock) throw new Error('no :root token block found in styles.css');
const outsideRoot = css.replace(rootBlock[0], '');

// 6-digit hex values only — the same :root parsing convention as contrast.
const rootTokens = new Map<string, string>();
for (const m of rootBlock[1].matchAll(
  /(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g,
)) {
  rootTokens.set(m[1], m[2].toLowerCase());
}
function token(name: string): string {
  const v = rootTokens.get(name);
  if (!v) throw new Error(`token ${name} is not a 6-digit hex :root property`);
  return v;
}

// WCAG 2.1 relative luminance — identical math to contrast.test.ts.
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function colorHits(src: string, label: string): string[] {
  return src
    .split('\n')
    .flatMap((line, i) => (COLOR.test(line) ? [`${label}:${i + 1}`] : []));
}

// Flat selector/body pairs; @media/@keyframes wrappers drop out of the split,
// which is fine — none of them declare surface colors here.
const rules = [...outsideRoot.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim().replace(/\s+/g, ' '),
  body: m[2],
}));

// Declarations of `prop` in rules mentioning `.cls`. \b alone would let
// ".rail" match ".rail-item" (hyphen is a non-word char), hence the guard.
function decls(cls: string, prop: string) {
  const guard = new RegExp(`\\.${cls}(?![\\w-])`);
  const own = new RegExp(`^\\s*${prop}\\s*:\\s*(.+)$`);
  return rules
    .filter((r) => guard.test(r.selector))
    .flatMap((r) =>
      r.body
        .split(';')
        .map((part) => part.match(own))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => ({ selector: r.selector, value: m[1].trim() })),
    );
}

const SURFACES =
  'modal overlay savebar card panel rail banner orch-table models-table diff'.split(
    ' ',
  );

describe('TH-1 — token single source of truth (one-knob retheme)', () => {
  it('styles.css declares no color literal outside :root', () => {
    expect(colorHits(outsideRoot, 'web/src/styles.css')).toEqual([]);
  });
  it('no component source (*.tsx, string literals included) carries one', () => {
    const src = resolve(process.cwd(), 'web/src');
    const files = readdirSync(src, { recursive: true })
      .map(String) // @types/node unions Buffer into the recursive result
      .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
      .sort();
    // Four views + shared components must be covered, not vacuously skipped.
    expect(files.length).toBeGreaterThanOrEqual(10);
    const found = files.flatMap((f) =>
      colorHits(readFileSync(resolve(src, f), 'utf8'), `web/src/${f}`),
    );
    expect(found).toEqual([]);
  });
  it('border-radius/box-shadow outside :root are bare var(--token)s', () => {
    const bad = [
      ...outsideRoot.matchAll(/(?:border-radius|box-shadow)\s*:\s*([^;{}]+)/g),
    ]
      .map((m) => m[1].trim())
      .filter((v) => !/^var\(--[\w-]+\)$/.test(v));
    expect(bad).toEqual([]);
  });
});
describe('TH-2 — whole-app light surfaces (modals-light)', () => {
  it(':root page --bg and card --surface are light (luminance >= 0.90)', () => {
    expect(luminance(token('--bg'))).toBeGreaterThanOrEqual(0.9);
    expect(luminance(token('--surface'))).toBeGreaterThanOrEqual(0.9);
  });
  it('every audited surface class exists in styles.css', () => {
    const missing = SURFACES.filter(
      (c) =>
        !rules.some((r) => new RegExp(`\\.${c}(?![\\w-])`).test(r.selector)),
    );
    expect(missing).toEqual([]);
  });
  it('surface classes source background/color exclusively via var() tokens', () => {
    let checked = 0;
    const offenders: string[] = [];
    for (const cls of SURFACES) {
      for (const prop of ['background', 'background-color', 'color']) {
        for (const d of decls(cls, prop)) {
          checked += 1;
          const pass =
            /^(none|transparent|inherit)$/.test(d.value) ||
            d.value.includes('var(--');
          if (!pass) offenders.push(`${d.selector} { ${prop}: ${d.value} }`);
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10); // non-vacuous audit
    expect(offenders).toEqual([]);
  });
  it('modal/savebar/card/panel ride var(--surface); .overlay is only a scrim', () => {
    for (const cls of ['modal', 'savebar', 'card', 'panel']) {
      const values = decls(cls, 'background').map((d) => d.value);
      expect(values.length, `.${cls} declares no background`).toBeGreaterThan(
        0,
      );
      expect(values.join(' ')).toContain('var(--surface)');
    }
    expect(decls('overlay', 'background').map((d) => d.value)).toEqual([
      'var(--overlay)',
    ]);
  });
});

// orchestration-v2 WU-C 3.3 (spec TH-5, design D7) — the bundled icon set:
// 14 hand-drawn inline SVGs, zero dependencies, offline-build-safe (CX-4).
// Every glyph inherits its color via stroke="currentColor" so tiles and
// buttons theme themselves through the CSS token layer; 16px at a 24-unit
// viewBox keeps strokes crisp. All icons are aria-hidden — the surrounding
// text or aria-label carries the accessible name. The spinner's rotation
// rides the global prefers-reduced-motion block (static arc when off).
import type { ReactNode } from 'react';

function Icon({
  children,
  spinning = false,
}: {
  children: ReactNode;
  spinning?: boolean;
}) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={spinning ? 'icon-spin' : undefined}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/* --- rail ------------------------------------------------------------------ */

export function IconPlug() {
  return (
    <Icon>
      <path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0V7zM12 16v5" />
    </Icon>
  );
}

export function IconCube() {
  return (
    <Icon>
      <path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
    </Icon>
  );
}

export function IconList() {
  return (
    <Icon>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </Icon>
  );
}

export function IconPulse() {
  return (
    <Icon>
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </Icon>
  );
}

/* --- actions & states -------------------------------------------------------- */

export function IconPlus() {
  return (
    <Icon>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function IconClose() {
  return (
    <Icon>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  );
}

export function IconChevronDown() {
  return (
    <Icon>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function IconRefresh() {
  return (
    <Icon>
      <path d="M23 4v6h-6M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </Icon>
  );
}

export function IconSync() {
  return (
    <Icon>
      <path d="M1 4v6h6M23 20v-6h-6" />
      <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15" />
    </Icon>
  );
}

export function IconAlert() {
  return (
    <Icon>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01" />
    </Icon>
  );
}

export function IconCheck() {
  return (
    <Icon>
      <path d="M20 6 9 17l-5-5" />
    </Icon>
  );
}

export function IconSpinner() {
  return (
    <Icon spinning>
      <circle cx="12" cy="12" r="9" strokeDasharray="42 15" />
    </Icon>
  );
}

export function IconFileText() {
  return (
    <Icon>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </Icon>
  );
}

export function IconClone() {
  return (
    <Icon>
      <path d="M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2z" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </Icon>
  );
}

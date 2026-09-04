// WU10.1/10.2 — component tests for the Status view (jsdom web project).
// Binding acceptance surface (tasks WU10 / spec SCW-4, MC-5, PC-1):
//   consumption  the view reads GET /api/status ONLY — the fetch script
//                throws on any other URL, so a stray fs-flavored or write
//                call can never pass unnoticed (all data logic is
//                server-side; the web layer has none);
//   SCW-4        backups render newest-first EXACTLY in the server's order
//                (the client never re-sorts) with a documented restore
//                pointer, and the two backup systems stay distinguished
//                (dashboard model-dashboard-backups vs gentle-ai-owned
//                ~/.gentle-ai/backups);
//   MC-5 rollup  drift cells render verbatim from the server-truth
//                DriftCell[]; the client never compares numbers itself —
//                proven by feeding an ALIGNED cell (declared === snapshot)
//                and asserting the row still renders (no client filter);
//   CX-3         restartRequired surfaces "Restart OpenCode to apply";
//   PC-1 error UX parity with the other views: a 404 config_missing or
//                422 config_unparseable GET renders the honest error panel
//                (message from the server envelope, Retry recovers) —
//                never a success state, never a "created/ repaired" claim.
// No live network, no real ~/.config: every fetch is scripted (the
// WU6–WU9 pattern); CSS is never imported by tests.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DriftCell, StatusResponse } from '../../../shared/types';
import StatusView from './StatusView';

function fixture(overrides?: Partial<StatusResponse>): StatusResponse {
  return {
    path: '/sandbox/opencode.json',
    hash: 'hash-status-0001',
    mtime: 1756000000000,
    drift: [],
    snapshotAsOf: '2026-09-04',
    backups: [],
    restartRequired: false,
    ...overrides,
  };
}

const DRIFT_QWEN: DriftCell = {
  provider: 'nan',
  model: 'qwen3.8-flash',
  field: 'contextWindow',
  declared: 1000000,
  snapshot: 262144,
  advisory: true,
};
const DRIFT_MIMO: DriftCell = {
  provider: 'nan',
  model: 'mimo-v2.5',
  field: 'contextWindow',
  declared: 262144,
  snapshot: 1048576,
  advisory: true,
};

interface Reply {
  status: number;
  body: unknown;
}

/**
 * Scripted fetch (WU6–WU9 pattern), narrowed to this view's contract:
 * GET /api/status replays the queue (sticky last); ANY other method or
 * URL is a hard failure — the Status view must consume the status
 * endpoint and nothing else.
 */
function scriptApi(opts: { gets?: Reply[] } = {}) {
  const calls: Array<{ method: string; url: string }> = [];
  const gets = [...(opts.gets ?? [{ status: 200, body: fixture() }])];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (method === 'GET' && url === '/api/status') {
        const next = gets.length > 1 ? gets.shift() : gets[0];
        return json(next!.status, next!.body);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return { calls };
}

const errEnvelope = (code: string, message: string) => ({
  ok: false,
  error: { code, message },
});

async function rendered() {
  render(<StatusView />);
  await screen.findByRole('heading', { name: 'Status' });
}

function driftTable(): HTMLElement {
  return screen.getByRole('table', { name: 'Snapshot drift' });
}

function backupList(): HTMLElement {
  return screen.getByRole('list', { name: 'Backup restore points' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Status — identity from GET /api/status only (10.1)', () => {
  it('renders path, hash, ISO mtime and snapshotAsOf without touching any other endpoint', async () => {
    const { calls } = scriptApi();
    await rendered();

    expect(screen.getByText('/sandbox/opencode.json')).toBeTruthy();
    expect(screen.getByText('hash-status-0001')).toBeTruthy();
    // mtime is rendered as a deterministic ISO 8601 stamp, not a locale string.
    expect(
      screen.getByText(new Date(1756000000000).toISOString()),
    ).toBeTruthy();
    expect(screen.getByText('2026-09-04')).toBeTruthy();
    // Consumption contract: status is the ONLY request the view ever makes.
    expect(calls).toEqual([{ method: 'GET', url: '/api/status' }]);
  });

  it('Refresh re-reads the status endpoint and shows the fresh state', async () => {
    const { calls } = scriptApi({
      gets: [
        { status: 200, body: fixture() },
        {
          status: 200,
          body: fixture({
            hash: 'hash-after-save',
            restartRequired: true,
            backups: ['/sandbox/model-dashboard-backups/opencode-x.json'],
          }),
        },
      ],
    });
    await rendered();
    expect(screen.queryByText('hash-after-save')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(screen.getByText('hash-after-save')).toBeTruthy();
    });
    // Still zero writes — even after interaction the view only ever GETs status.
    expect(calls).toEqual([
      { method: 'GET', url: '/api/status' },
      { method: 'GET', url: '/api/status' },
    ]);
  });
});

describe('Status — drift rollup from server-truth cells (MC-5)', () => {
  it('counts cells and renders declared vs snapshot verbatim with the advisory chip', async () => {
    scriptApi({
      gets: [
        { status: 200, body: fixture({ drift: [DRIFT_QWEN, DRIFT_MIMO] }) },
      ],
    });
    await rendered();

    expect(screen.getByText('2 drift cells')).toBeTruthy();
    const table = within(driftTable());
    const qwenRow = table.getByRole('row', { name: /nan\/qwen3\.8-flash/ });
    within(qwenRow).getByText('1000000');
    within(qwenRow).getByText('262144');
    const chip = within(qwenRow).getByText('drift');
    expect(chip.getAttribute('title')).toContain('Advisory only');

    const mimoRow = table.getByRole('row', { name: /nan\/mimo-v2\.5/ });
    within(mimoRow).getByText('262144');
    within(mimoRow).getByText('1048576');
  });

  it('renders whatever the server says — an aligned cell is NOT filtered client-side', async () => {
    // The client never compares numbers itself: even a (server-should-never-
    // emit-it) cell whose values agree must render, proving no client-side
    // equality filter exists on the rollup path.
    scriptApi({
      gets: [
        {
          status: 200,
          body: fixture({
            drift: [{ ...DRIFT_QWEN, declared: 262144 }],
          }),
        },
      ],
    });
    await rendered();

    expect(screen.getByText('1 drift cell')).toBeTruthy();
    within(driftTable()).getByRole('row', { name: /nan\/qwen3\.8-flash/ });
  });

  it('zero drift states the honest empty case, scoped to matched metadata', async () => {
    scriptApi();
    await rendered();
    expect(screen.queryByRole('table', { name: 'Snapshot drift' })).toBeNull();
    expect(screen.getByText(/No drift reported/).textContent).toMatch(/match/);
  });
});

describe('Status — backups newest-first + restore pointer (SCW-4)', () => {
  const NEWEST =
    '/sandbox/model-dashboard-backups/opencode-2026-09-04T12:30:00.000Z.json';
  const MIDDLE =
    '/sandbox/model-dashboard-backups/opencode-2026-09-04T12:00:00.000Z.json';
  const OLDEST =
    '/sandbox/model-dashboard-backups/opencode-2026-09-03T09:15:00.000Z.json';

  it('lists backups in the server order and points restore at the newest with a copy command', async () => {
    scriptApi({
      gets: [
        { status: 200, body: fixture({ backups: [NEWEST, MIDDLE, OLDEST] }) },
      ],
    });
    await rendered();

    const items = within(backupList()).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining(NEWEST),
      expect.stringContaining(MIDDLE),
      expect.stringContaining(OLDEST),
    ]);
    expect(items[0]!.textContent).toContain('newest');

    // Restore pointer: concrete command for the newest backup…
    expect(
      screen.getByText(`cp "${NEWEST}" "/sandbox/opencode.json"`),
    ).toBeTruthy();
    // …labeled as a manual, dashboard-never-restores operation…
    expect(screen.getByText(/never restores/i)).toBeTruthy();
    // …and distinguished from the gentle-ai-owned sync backups in the same
    // explanatory paragraph (both tokens present on one <p>).
    expect(
      screen.getByText(
        (_content, el) =>
          el?.tagName === 'P' &&
          (el.textContent ?? '').includes('~/.gentle-ai/backups') &&
          (el.textContent ?? '').includes('gentle-ai restore'),
      ),
    ).toBeTruthy();
  });

  it('no backups yet renders the empty state and invents no command', async () => {
    scriptApi();
    await rendered();
    expect(screen.getByText(/No backups yet/)).toBeTruthy();
    expect(
      screen.queryByRole('list', { name: 'Backup restore points' }),
    ).toBeNull();
    expect(screen.queryByText(/^cp /)).toBeNull();
  });
});

describe('Status — restartRequired carrier (CX-3)', () => {
  it('true surfaces the restart notice; false says no restart is pending', async () => {
    scriptApi({
      gets: [{ status: 200, body: fixture({ restartRequired: true }) }],
    });
    await rendered();
    expect(screen.getByText('Restart OpenCode to apply')).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();

    scriptApi();
    await rendered();
    expect(
      screen.getByRole('status', { name: /no restart pending/i }),
    ).toBeTruthy();
  });
});

describe('Status — PC-1 error states (10.2 parity)', () => {
  it('404 config_missing renders the error panel with the server message; Retry recovers', async () => {
    const missingMessage =
      'CONFIG not found at /sandbox/opencode.json. The dashboard will not create or repair it.';
    const { calls } = scriptApi({
      gets: [
        { status: 404, body: errEnvelope('config_missing', missingMessage) },
        { status: 200, body: fixture() },
      ],
    });
    render(<StatusView />);
    await screen.findByRole('alert');

    expect(
      screen.getByRole('heading', { name: 'Configuration unavailable' }),
    ).toBeTruthy();
    expect(screen.getByText(missingMessage)).toBeTruthy();
    // Honest failure surface: no success/data state renders behind it.
    expect(screen.queryByText('hash-status-0001')).toBeNull();
    expect(screen.queryByText(/Sync succeeded/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('hash-status-0001');
    expect(calls.length).toBe(2);
  });

  it('422 config_unparseable renders the honest panel and never claims a repair', async () => {
    const unparseable =
      'CONFIG at /sandbox/opencode.json is not valid JSON — nothing was modified.';
    scriptApi({
      gets: [
        {
          status: 422,
          body: errEnvelope('config_unparseable', unparseable),
        },
      ],
    });
    render(<StatusView />);
    await screen.findByRole('alert');

    expect(screen.getByText(unparseable)).toBeTruthy();
    expect(screen.queryByText(/repaired|created a new config/i)).toBeNull();
    expect(
      screen.queryByRole('list', { name: 'Backup restore points' }),
    ).toBeNull();
  });
});

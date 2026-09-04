// WU9.3 (RED) — component tests for the sync panel (design §UI "Sync panel
// streams output + exit-code chip"; spec OA-3 scenarios). Scripted fetch
// only (the WU6–WU8 pattern): no live network, no real ~/.config, no real
// gentle-ai. The panel's contract:
//   run → POST /api/sync (bare pass-through, unchanged CLI, never a body
//       carrying hashes or secrets);
//   exit 0 → output surfaced + `exit 0` chip + success note + onSynced() so
//       the parent re-GETs /api/config and the list reflects post-sync CONFIG;
//   non-zero exit → output + failure chip, NO success state, NO re-baseline;
//   HTTP error (e.g. sync_timeout 504) → the envelope message surfaces and
//       the action stays retryable.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncPanel } from './SyncPanel';

interface Call {
  method: string;
  url: string;
  body?: string;
}

function scriptSync(
  replies: { status: number; body: unknown }[],
  gate?: Promise<void>,
) {
  const calls: Call[] = [];
  const queue = [...replies];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({
        method,
        url,
        body: init?.body ? String(init.body) : undefined,
      });
      if (method === 'POST' && url === '/api/sync') {
        if (gate) await gate;
        const reply = queue.shift();
        if (!reply) throw new Error(`sync script exhausted at ${url}`);
        return new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: 'not_found', message: `unexpected ${method} ${url}` },
        }),
        { status: 404 },
      );
    }),
  );
  return { calls };
}

const syncOk = (exitCode: number, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { ok: true, exitCode, stdout: '', stderr: '', ...extra },
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('sync panel — run and success (OA-3 success scenario)', () => {
  it('runs a bare pass-through sync, surfaces output + exit-0 chip, and re-baselines via onSynced', async () => {
    const { calls } = scriptSync([
      syncOk(0, {
        stdout: 'gentle-ai sync: refreshed 47 agents\n',
        hash: 'hash-post-sync',
      }),
    ]);
    const onSynced = vi.fn();
    render(<SyncPanel onSynced={onSynced} />);

    fireEvent.click(screen.getByRole('button', { name: 'Run sync' }));
    // Busy state while the child runs: announced, and not double-clickable.
    expect(screen.getByText('Running gentle-ai sync…')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Run sync' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(await screen.findByText('exit 0')).toBeTruthy();

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('/api/sync');
    // Bare pass-through: no args invented server-side, and never any hash,
    // config content or secret-shaped material in the body.
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({});
    expect(calls[0].body).not.toContain('apiKey');
    expect(calls[0].body).not.toContain('hash');

    expect(screen.getByText(/refreshed 47 agents/)).toBeTruthy();
    expect(screen.getByText(/Sync succeeded — CONFIG reloaded/)).toBeTruthy();
    expect(onSynced).toHaveBeenCalledTimes(1);
    // Retryable afterwards: the button is live again.
    expect(
      (screen.getByRole('button', { name: 'Run sync' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe('sync panel — failure (OA-3 failure scenario)', () => {
  it('a non-zero exit surfaces output and the failure code with NO success state', async () => {
    const onSynced = vi.fn();
    scriptSync([
      syncOk(4, {
        stdout: 'gentle-ai sync: starting\n',
        stderr: 'gentle-ai sync: profile store locked\n',
      }),
    ]);
    render(<SyncPanel onSynced={onSynced} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run sync' }));

    expect(await screen.findByText('exit 4')).toBeTruthy();
    expect(screen.getByText(/gentle-ai sync: starting/)).toBeTruthy();
    expect(screen.getByText(/profile store locked/)).toBeTruthy();
    // No success state renders — and nothing re-baselines the list.
    expect(screen.queryByText(/Sync succeeded/)).toBeNull();
    expect(onSynced).not.toHaveBeenCalled();
  });

  it('an HTTP failure (sync_timeout 504) surfaces the envelope message and stays retryable', async () => {
    const onSynced = vi.fn();
    scriptSync([
      {
        status: 504,
        body: {
          ok: false,
          error: {
            code: 'sync_timeout',
            message: 'gentle-ai sync timed out after 60000 ms and was killed.',
          },
        },
      },
    ]);
    render(<SyncPanel onSynced={onSynced} />);
    fireEvent.click(screen.getByRole('button', { name: 'Run sync' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('timed out after 60000 ms');
    expect(screen.queryByText(/^exit /)).toBeNull();
    expect(screen.queryByText(/Sync succeeded/)).toBeNull();
    expect(onSynced).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'Run sync' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

// WU6.2 — RED component tests for the Providers view (jsdom project from WU1).
// Binding acceptance surface:
//   CX-2  presence badge shows "Configured — hidden"; the apiKey VALUE never
//         appears in the DOM or in anything the component sends back;
//   CX-3  successful save → "Restart OpenCode to apply" notice;
//   SCW-2 409 stale → two-column key-path diff modal with Reload / Overwrite;
//   PC-3  apiKey is replace-only: empty input = no change, the PUT body omits
//         apiKey when untouched, and the masked {configured} shape is NEVER
//         echoed back as if it were a value.
// No live network and no real ~/.config files: every fetch is mocked with a
// scripted in-memory API; fixtures are fixed ConfigResponse shapes matching
// shared/types.ts.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConfigResponse } from '../../../shared/types';
import ProvidersView from './ProvidersView';

/** Sentinel that must never surface anywhere in the UI or in any request body. */
const LEAK_SENTINEL = 'sk-LEAK-CHECK-b7d2f4a1';

/** Fixed masked GET /api/config fixture — shapes match shared/types.ts. */
function fixture(overrides?: Partial<ConfigResponse>): ConfigResponse {
  return {
    hash: 'hash-base-0001',
    mtime: 1756000000000,
    providers: {
      nan: {
        name: 'NaN',
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: 'https://api.nan.example/v1',
          apiKey: { configured: true },
        },
        models: {
          'qwen3.8-flash': { name: 'Qwen 3.8 Flash', contextWindow: 262144 },
          'glm5.3-flash': { name: 'GLM 5.3 Flash' },
        },
      },
      headroom: {
        name: 'Headroom',
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'https://api.headroom.example' },
        models: {},
      },
      nanSendvalu: {
        name: 'Sendvalu',
        options: {
          baseURL: 'https://sendvalu.example/v1',
          apiKey: { configured: false },
        },
        models: { 'x1-mini': {} },
      },
    },
    agents: {},
    authJson: { exists: [] },
    snapshotAsOf: null,
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/**
 * Scripted fetch: GET /api/config replays `gets` (last entry sticky),
 * PUT /api/providers/:id consumes `puts` in order. An exhausted PUT script
 * fails the test loudly instead of silently answering 200.
 */
function scriptApi(opts: {
  gets?: ConfigResponse[];
  puts?: { status: number; body: unknown }[];
}) {
  const calls: Call[] = [];
  const gets = [...(opts.gets ?? [fixture()])];
  const puts = [...(opts.puts ?? [])];
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : undefined;
      calls.push({ method, url, body });
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (method === 'GET' && url === '/api/config') {
        const next = gets.length > 1 ? gets.shift() : gets[0];
        return json(200, next);
      }
      if (method === 'PUT' && url.startsWith('/api/providers/')) {
        const reply = puts.shift();
        if (!reply) throw new Error(`PUT script exhausted at ${url}`);
        return json(reply.status, reply.body);
      }
      return json(404, {
        ok: false,
        error: { code: 'not_found', message: `unexpected ${method} ${url}` },
      });
    },
  );
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

const okWrite = (hash: string) => ({
  status: 200,
  body: { ok: true, hash },
});

function card(id: string) {
  return screen.getByRole('group', { name: id });
}

function field(id: string, label: string): HTMLInputElement {
  return within(card(id)).getByLabelText(label) as HTMLInputElement;
}

async function renderedView() {
  render(<ProvidersView />);
  await screen.findByText('Configured — hidden');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Providers view — list + masking (PC-2, CX-2)', () => {
  it('loads providers from GET /api/config and shows id, name, npm, baseURL, model count', async () => {
    scriptApi({});
    await renderedView();
    expect(card('nan')).toBeTruthy();
    expect(card('headroom')).toBeTruthy();
    expect(card('nanSendvalu')).toBeTruthy();
    expect(field('nan', 'Name').value).toBe('NaN');
    expect(field('nan', 'npm').value).toBe('@ai-sdk/openai-compatible');
    expect(field('nan', 'Base URL').value).toBe('https://api.nan.example/v1');
    expect(within(card('nan')).getByText('2 models')).toBeTruthy();
    expect(within(card('headroom')).getByText('0 models')).toBeTruthy();
    expect(within(card('nanSendvalu')).getByText('1 model')).toBeTruthy();
  });

  it('renders presence badges only — set, not set, and absent never invents a value', async () => {
    scriptApi({});
    await renderedView();
    expect(within(card('nan')).getByText('Configured — hidden')).toBeTruthy();
    expect(within(card('nanSendvalu')).getByText('Not set')).toBeTruthy();
    // headroom has NO apiKey key at all — absent stays absent, shown as unset
    expect(within(card('headroom')).getByText('Not set')).toBeTruthy();
    // The API-key input starts EMPTY — the masked shape must never pre-fill it
    expect(field('nan', 'API key').value).toBe('');
    // No apiKey value and no serialized mask shape anywhere in the DOM
    expect(document.body.innerHTML).not.toContain('sk-');
    expect(document.body.innerHTML).not.toContain('"configured"');
  });

  it('defends CX-2 even against a malformed payload leaking a raw key: value never renders', async () => {
    const leaked = fixture();
    // Simulate a server bug that ships the raw string instead of the mask.
    (leaked.providers.nan.options as Record<string, unknown>).apiKey =
      LEAK_SENTINEL;
    scriptApi({ gets: [leaked] });
    render(<ProvidersView />);
    // Card headings are provider IDs (the name is a field value, not a node)
    await screen.findByRole('group', { name: 'nan' });
    expect(document.body.innerHTML).not.toContain(LEAK_SENTINEL);
    expect(document.body.innerHTML).not.toContain('sk-');
  });
});

describe('Providers view — save flow (PC-3, CX-3)', () => {
  it('sends only changed fields, omits apiKey when untouched, adopts echoed hash, shows restart notice', async () => {
    const { calls } = scriptApi({
      puts: [okWrite('echo-A')],
    });
    await renderedView();
    // Save bar: nothing dirty yet — no changes, Save disabled
    expect(screen.getByText('No changes')).toBeTruthy();
    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(field('nan', 'Base URL'), {
      target: { value: 'https://new-base.example/v1' },
    });
    expect(screen.getByText('1 change')).toBeTruthy();
    fireEvent.click(saveButton);

    await screen.findByText('Restart OpenCode to apply');
    const put = calls.find(
      (c) => c.method === 'PUT' && c.url === '/api/providers/nan',
    );
    expect(put?.body).toEqual({
      hash: 'hash-base-0001',
      baseURL: 'https://new-base.example/v1',
    });
    // apiKey untouched: key absent entirely (never an empty string, never a mask)
    expect(JSON.stringify(put?.body)).not.toContain('apiKey');
    expect(JSON.stringify(put?.body)).not.toContain('configured');
    // Bar returns to clean state after the write commits
    await waitFor(() => expect(screen.getByText('No changes')).toBeTruthy());
  });

  it('chains multiple providers sequentially, re-baselining the hash from every WriteResponse echo (SCW-2)', async () => {
    const { calls } = scriptApi({
      puts: [okWrite('echo-A'), okWrite('echo-B')],
    });
    await renderedView();
    fireEvent.change(field('nan', 'Name'), { target: { value: 'NaN Labs' } });
    fireEvent.change(field('headroom', 'npm'), {
      target: { value: '@ai-sdk/anthropic' },
    });
    expect(screen.getByText('2 changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText('Restart OpenCode to apply');
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.length).toBe(2);
    expect(puts[0].url).toBe('/api/providers/nan');
    expect(puts[0].body).toEqual({ hash: 'hash-base-0001', name: 'NaN Labs' });
    // Second write uses the hash echoed by the FIRST write as its base
    expect(puts[1].url).toBe('/api/providers/headroom');
    expect(puts[1].body).toEqual({
      hash: 'echo-A',
      npm: '@ai-sdk/anthropic',
    });
  });

  it('apiKey is replace-only: an explicit typed value is sent as the string; leaving it empty sends nothing', async () => {
    const { calls } = scriptApi({ puts: [okWrite('echo-A')] });
    await renderedView();
    fireEvent.change(field('nan', 'API key'), {
      target: { value: 'sk-user-provided-new-key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Restart OpenCode to apply');
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({
      hash: 'hash-base-0001',
      apiKey: 'sk-user-provided-new-key',
    });
    // The masked shape must never be echoed back as if it were a value
    expect(JSON.stringify(put?.body)).not.toContain('configured');
    // A saved key becomes an empty input again with a "configured" badge — replace-only, never reveal
    expect(field('nan', 'API key').value).toBe('');
    expect(within(card('nan')).getByText('Configured — hidden')).toBeTruthy();
  });

  it('Discard drops pending edits and returns inputs to loaded values', async () => {
    scriptApi({});
    await renderedView();
    fireEvent.change(field('nan', 'Name'), { target: { value: 'Junk' } });
    expect(screen.getByText('1 change')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByText('No changes')).toBeTruthy();
    expect(field('nan', 'Name').value).toBe('NaN');
  });

  it('surfaces a 400 invalid save with readable per-path errors and keeps pending edits', async () => {
    scriptApi({
      puts: [
        {
          status: 400,
          body: {
            ok: false,
            error: {
              code: 'invalid',
              message: 'Config validation failed.',
              issues: [
                {
                  path: 'provider.nan.options.baseURL',
                  message: 'Expected string, received number',
                },
              ],
            },
          },
        },
      ],
    });
    await renderedView();
    fireEvent.change(field('nan', 'Base URL'), { target: { value: 'oops' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(
      /provider\.nan\.options\.baseURL: Expected string, received number/,
    );
    expect(screen.queryByText('Restart OpenCode to apply')).toBeNull();
    // Pending edit survives the failure (SCW-2: edits are never discarded)
    expect(screen.getByText('1 change')).toBeTruthy();
  });
});

describe('Providers view — 409 conflict modal (SCW-2)', () => {
  const staleReply = {
    status: 409,
    body: {
      ok: false,
      error: {
        code: 'stale',
        message: 'CONFIG changed since you loaded it — write rejected.',
        expected: 'hash-base-0001',
        actual: 'hash-external-9',
      },
    },
  };

  const freshCopy = () =>
    fixture({
      hash: 'hash-external-9',
      providers: {
        ...fixture().providers,
        nan: {
          ...fixture().providers.nan,
          options: {
            baseURL: 'https://outsider-edited.example/v1',
            apiKey: { configured: true },
          },
        },
      },
    });

  async function openConflict() {
    const api = scriptApi({
      gets: [fixture(), freshCopy()],
      // The conflict, then the scripted retry success consumed by Overwrite.
      puts: [staleReply, okWrite('echo-retry-10')],
    });
    await renderedView();
    fireEvent.change(field('nan', 'Base URL'), {
      target: { value: 'https://mine.example/v1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog');
    return { ...api, dialog };
  }

  it('shows a two-column key-path diff with Reload / Overwrite actions', async () => {
    const { dialog } = await openConflict();
    // Two columns: dashboard pending copy vs current config file
    expect(within(dialog).getByText(/Dashboard/)).toBeTruthy();
    expect(within(dialog).getByText(/Config file/)).toBeTruthy();
    // Diffed by key path, values side by side
    expect(
      within(dialog).getByText('provider.nan.options.baseURL'),
    ).toBeTruthy();
    expect(within(dialog).getByText('https://mine.example/v1')).toBeTruthy();
    expect(
      within(dialog).getByText('https://outsider-edited.example/v1'),
    ).toBeTruthy();
    // Staleness evidence: both hashes visible
    expect(within(dialog).getByText('hash-base-0001')).toBeTruthy();
    expect(within(dialog).getByText('hash-external-9')).toBeTruthy();
    // Actions per design §UI
    expect(
      within(dialog).getByRole('button', { name: 'Reload fresh' }),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: 'Overwrite' }),
    ).toBeTruthy();
  });

  it('Overwrite retries the failed save with the new hash and succeeds', async () => {
    const { dialog, calls } = await openConflict();
    const stalePuts = calls.filter((c) => c.method === 'PUT').length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Overwrite' }));
    await screen.findByText('Restart OpenCode to apply');
    expect(screen.queryByRole('dialog')).toBeNull();
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.length).toBe(stalePuts + 1);
    const last = puts[puts.length - 1];
    expect(last.url).toBe('/api/providers/nan');
    // Retry carries the FRESH hash (from the conflict flow's reload), not the stale one
    expect(last.body).toEqual({
      hash: 'hash-external-9',
      baseURL: 'https://mine.example/v1',
    });
  });

  it('Reload adopts the fresh copy, keeps pending edits re-appliable, and closes the modal', async () => {
    const { dialog } = await openConflict();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Reload fresh' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Pending edit is kept and stays dirty against the fresh copy (SCW-2)
    expect(field('nan', 'Base URL').value).toBe('https://mine.example/v1');
    expect(screen.getByText('1 change')).toBeTruthy();
  });
});

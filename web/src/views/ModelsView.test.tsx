// WU7.2 (RED) — component tests for the Models view (jsdom web project).
// Binding acceptance surface (tasks WU7):
//   MC-5  declared 1M vs snapshot 262K shown SIDE BY SIDE with an amber
//         "drift" chip — ADVISORY ONLY: saving still preserves the declared
//         value (no field rewrite, no blocking);
//   MC-3  "add model" pre-fills from a matching snapshot entry and the save
//         creates provider.nan.models["glm5.3-flash"];
//   MC-4  removal requires an explicit confirm; Cancel sends NO request, so
//         the entry stays byte-identical (nothing can have changed server-side);
//   MC-2  the provider selector is generic and empty model lists render;
//   PC-4  a non-matching provider (different npm/name metadata) gets no drift
//         data and no catalog pre-fill — nothing is hardcoded per provider id.
// No live network, no real ~/.config: every fetch is scripted (the WU6
// pattern). The catalog fixture IS the real bundled snapshot — proof that the
// pre-fill path consumes 7.1's shipped data.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import nanSnapshotJson from '../../../server/src/catalog/nan-snapshot.json';
import type {
  CatalogResponse,
  ConfigResponse,
  DriftCell,
  StatusResponse,
} from '../../../shared/types';
import ModelsView from './ModelsView';

/** The actual WU7.1 bundle — the view must pre-fill from shipped metadata. */
const catalogFixture = nanSnapshotJson as CatalogResponse;

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
          'qwen3.8-flash': {
            name: 'Qwen 3.8 Flash',
            contextWindow: 1000000,
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
          'qwen3.6': { name: 'Qwen 3.6', contextWindow: 262144 },
          'mimo-v2.5': { name: 'MiMo v2.5', contextWindow: 262144 },
        },
      },
      headroom: {
        name: 'Headroom',
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: 'https://api.headroom.example' },
        models: {},
      },
      nanSendvalu: {
        // Same npm as nan — only the NAME metadata distinguishes it. The
        // declared glm5.3 context would "drift" against the snapshot IF a
        // buggy client matched by npm alone; drift must stay empty here.
        name: 'NaN Sendvalu',
        npm: '@ai-sdk/openai-compatible',
        options: { apiKey: { configured: false } },
        models: { 'glm5.3': { name: 'GLM 5.3', contextWindow: 1000000 } },
      },
    },
    agents: {},
    authJson: { exists: [] },
    snapshotAsOf: catalogFixture.asOf,
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

function statusFixture(drift: DriftCell[]): StatusResponse {
  return {
    path: '/sandbox/opencode.json',
    hash: 'hash-base-0001',
    mtime: 1756000000000,
    drift,
    snapshotAsOf: catalogFixture.asOf,
    backups: [],
    restartRequired: false,
  };
}

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/**
 * Scripted fetch (WU6 pattern): the three GETs replay fixed payloads;
 * POST/PUT/DELETE consume their queues in order and fail loudly when the
 * script is exhausted (a stray request can never pass unnoticed).
 */
function scriptApi(
  opts: {
    gets?: ConfigResponse[];
    status?: StatusResponse;
    catalog?: CatalogResponse | null;
    posts?: { status: number; body: unknown }[];
    puts?: { status: number; body: unknown }[];
    deletes?: { status: number; body: unknown }[];
  } = {},
) {
  const calls: Call[] = [];
  const gets = [...(opts.gets ?? [fixture()])];
  const status = opts.status ?? statusFixture([DRIFT_QWEN, DRIFT_MIMO]);
  const catalog =
    opts.catalog === null ? undefined : (opts.catalog ?? catalogFixture);
  const posts = [...(opts.posts ?? [])];
  const puts = [...(opts.puts ?? [])];
  const deletes = [...(opts.deletes ?? [])];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
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
      if (method === 'GET' && url === '/api/status') {
        return json(200, status);
      }
      if (method === 'GET' && url === '/api/catalog') {
        if (!catalog) {
          return json(404, {
            ok: false,
            error: { code: 'not_found', message: 'no catalog' },
          });
        }
        return json(200, catalog);
      }
      if (method === 'POST' && /^\/api\/providers\/[^/]+\/models$/.test(url)) {
        const reply = posts.shift();
        if (!reply) throw new Error(`POST script exhausted at ${url}`);
        return json(reply.status, reply.body);
      }
      if (method === 'PUT' && /^\/api\/providers\/[^/]+\/models\//.test(url)) {
        const reply = puts.shift();
        if (!reply) throw new Error(`PUT script exhausted at ${url}`);
        return json(reply.status, reply.body);
      }
      if (method === 'DELETE' && url.startsWith('/api/providers/')) {
        const reply = deletes.shift();
        if (!reply) throw new Error(`DELETE script exhausted at ${url}`);
        return json(reply.status, reply.body);
      }
      return json(404, {
        ok: false,
        error: { code: 'not_found', message: `unexpected ${method} ${url}` },
      });
    }),
  );
  return { calls };
}

const okWrite = (hash: string) => ({ status: 200, body: { ok: true, hash } });

function row(modelId: string): HTMLElement {
  return screen.getByRole('row', { name: modelId });
}

function form(name: string | RegExp): HTMLElement {
  return screen.getByRole('form', { name });
}

function input(container: HTMLElement, label: string): HTMLInputElement {
  return within(container).getByLabelText(label) as HTMLInputElement;
}

function selectProvider(id: string) {
  fireEvent.change(screen.getByLabelText('Provider'), {
    target: { value: id },
  });
}

async function renderedModels() {
  render(<ModelsView />);
  await screen.findByRole('row', { name: 'qwen3.8-flash' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Models view — drift is signature, never authority (MC-5)', () => {
  it('shows declared 1M vs snapshot 262K side by side with an amber advisory chip', async () => {
    scriptApi();
    await renderedModels();
    const drifted = row('qwen3.8-flash');
    // Side by side: both numbers visible in the same row (the design signature).
    expect(within(drifted).getByText('1000000')).toBeTruthy();
    expect(within(drifted).getByText('262144')).toBeTruthy();
    // The chip is labeled drift and framed as advisory (never an order).
    const chip = within(drifted).getByText('drift');
    expect(String(chip.getAttribute('title')).toLowerCase()).toContain(
      'advisory',
    );
    // An aligned declaration (qwen3.6 == snapshot) gets no chip at all.
    expect(within(row('qwen3.6')).queryByText('drift')).toBeNull();
    // Drift never disables the editing affordances (advisory, not blocking).
    expect(
      (
        within(drifted).getByRole('button', {
          name: 'Edit',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it('saving with drift present keeps the declared 1M verbatim — no snapshot rewrite (MC-5)', async () => {
    const { calls } = scriptApi({ puts: [okWrite('echo-A')] });
    await renderedModels();
    fireEvent.click(
      within(row('qwen3.8-flash')).getByRole('button', { name: 'Edit' }),
    );
    const editForm = form(/qwen3\.8-flash/);
    // The form initializes from the DECLARED value, not the snapshot value.
    expect(input(editForm, 'Context window').value).toBe('1000000');
    fireEvent.change(input(editForm, 'Name'), {
      target: { value: 'Qwen 3.8 Turbo' },
    });
    expect(screen.getByText('1 change')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Restart OpenCode to apply');
    const put = calls.find(
      (c) =>
        c.method === 'PUT' &&
        c.url === '/api/providers/nan/models/qwen3.8-flash',
    );
    // Only the touched field ships; contextWindow is not even mentioned, so
    // the server-side merge keeps the declared bytes (MC-5, MC-1).
    expect(put?.body).toEqual({
      hash: 'hash-base-0001',
      model: { name: 'Qwen 3.8 Turbo' },
    });
    expect(JSON.stringify(put?.body)).not.toContain('contextWindow');
    expect(JSON.stringify(put?.body)).not.toContain('262144');
    expect(JSON.stringify(put?.body)).not.toContain('1000000');
    // The declared value still displays after the save.
    expect(within(row('qwen3.8-flash')).getByText('1000000')).toBeTruthy();
  });
});

describe('Models view — add model (MC-3, MC-1)', () => {
  it('snapshot pre-fill opens the form from bundled metadata and creates provider.nan.models["glm5.3-flash"]', async () => {
    const { calls } = scriptApi({ posts: [okWrite('echo-A')] });
    // The provider's declared models do NOT contain glm5.3-flash yet.
    await renderedModels();
    expect(screen.queryByRole('row', { name: 'glm5.3-flash' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add model' });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'glm5.3-flash' }),
    );
    const addForm = await waitFor(() => form(/glm5\.3-flash/));
    // Pre-filled from the snapshot: docs name + context quota.
    expect(input(addForm, 'Model id').value).toBe('glm5.3-flash');
    expect(input(addForm, 'Name').value).toBe('GLM 5.3 Flash');
    expect(input(addForm, 'Context window').value).toBe(String(1048576));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Restart OpenCode to apply');
    const post = calls.find(
      (c) => c.method === 'POST' && c.url === '/api/providers/nan/models',
    );
    expect(post?.body).toEqual({
      hash: 'hash-base-0001',
      modelId: 'glm5.3-flash',
      model: { name: 'GLM 5.3 Flash', contextWindow: 1048576 },
    });
    // The new entry shows up in the table (optimistic fold of the POST echo).
    expect(within(row('glm5.3-flash')).getByText('1048576')).toBeTruthy();
  });

  it('manual add sends only the fields the user filled — nothing invented (MC-1)', async () => {
    const { calls } = scriptApi({ posts: [okWrite('echo-A')] });
    await renderedModels();
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add model' });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Manual entry' }),
    );
    const addForm = await waitFor(() => form(/manual/i));
    fireEvent.change(input(addForm, 'Model id'), {
      target: { value: 'my-model' },
    });
    fireEvent.change(input(addForm, 'Name'), { target: { value: 'My Model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Restart OpenCode to apply');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/providers/nan/models');
    // Sparse: absent inputs produce NO keys (no empty strings, no defaults).
    expect(post?.body).toEqual({
      hash: 'hash-base-0001',
      modelId: 'my-model',
      model: { name: 'My Model' },
    });
  });
});

describe('Models view — remove needs confirmation (MC-4)', () => {
  it('cancel sends no request at all — the entry stays byte-identical', async () => {
    const { calls } = scriptApi();
    await renderedModels();
    fireEvent.click(
      within(row('mimo-v2.5')).getByRole('button', { name: 'Remove' }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: /mimo-v2\.5/,
    });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // No request of any kind left the browser ⇒ the server file is untouched.
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    // The row is still there with its declared bytes rendered.
    expect(row('mimo-v2.5')).toBeTruthy();
    expect(within(row('mimo-v2.5')).getByText('262144')).toBeTruthy();
    expect(screen.getByText('No changes')).toBeTruthy();
  });

  it('confirm sends exactly one DELETE carrying the current hash', async () => {
    const { calls } = scriptApi({ deletes: [okWrite('echo-D')] });
    await renderedModels();
    fireEvent.click(
      within(row('mimo-v2.5')).getByRole('button', { name: 'Remove' }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: /mimo-v2\.5/,
    });
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Confirm remove' }),
    );
    await screen.findByText('Restart OpenCode to apply');
    const dels = calls.filter((c) => c.method === 'DELETE');
    expect(dels.length).toBe(1);
    expect(dels[0].url).toBe('/api/providers/nan/models/mimo-v2.5');
    expect(dels[0].body).toEqual({ hash: 'hash-base-0001' });
    // Gone from the table; siblings untouched.
    await waitFor(() =>
      expect(screen.queryByRole('row', { name: 'mimo-v2.5' })).toBeNull(),
    );
    expect(row('qwen3.8-flash')).toBeTruthy();
  });
});

describe('Models view — selector and generality (MC-2, PC-4)', () => {
  it('selector lists every provider and an empty model list renders explicitly', async () => {
    scriptApi();
    await renderedModels();
    const options = screen
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(['nan', 'headroom', 'nanSendvalu']);
    selectProvider('headroom');
    expect(await screen.findByText('No models declared')).toBeTruthy();
    // Empty provider still offers the add form (0..N generality).
    expect(screen.getByRole('button', { name: 'Add model' })).toBeTruthy();
  });

  it('a same-npm different-name provider gets no drift and no catalog pre-fill', async () => {
    scriptApi();
    await renderedModels();
    selectProvider('nanSendvalu');
    // glm5.3 declares 1000000 — the snapshot entry says 1048576 — yet this
    // provider does not match the snapshot metadata: NO chip may render.
    const glmRow = await waitFor(() => row('glm5.3'));
    expect(within(glmRow).queryByText('drift')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add model' });
    expect(
      within(dialog).queryByRole('button', { name: 'glm5.3-flash' }),
    ).toBeNull();
    // Manual entry remains available for every provider.
    expect(
      within(dialog).getByRole('button', { name: 'Manual entry' }),
    ).toBeTruthy();
  });
});

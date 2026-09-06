// WU8.1 (RED) — component tests for the Orchestration view (jsdom web project).
// Binding acceptance surface (tasks WU8 / spec OA-1..OA-4):
//   OA-1  the base/-cheap/-deep matrix and the non-phase list are derived
//         GENERICALLY from the GET /api/config response's agent.* keys
//         (0..N, nothing hardcoded — a fixture gaining agents must render
//         with zero code changes); unset agents show "runtime default";
//   OA-2  every picker offers ONLY the provider/model pairs present in the
//         config response (the installed catalog);
//   OA-4  prompt bodies and gentle-ai:* markers render read-only, and no
//         save call ever carries their content;
//   OA-3  after a successful agent-model save the UI advises running
//         gentle-ai sync (text only — the endpoint ships WU9).
// Save flows reuse the established conventions: mutations go through
// PUT /api/agents/:name/model ONLY, hashes chain from every WriteResponse
// echo (SCW-2), 409 opens the conflict diff, 400 issues land in the save
// bar, and success surfaces the CX-3 restart banner. No live network, no
// real ~/.config: every fetch is scripted (the WU6/WU7 pattern).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfigEntry, ConfigResponse } from '../../../shared/types';
import OrchestrationView from './OrchestrationView';

/** The 10 sdd phases as they appear in CONFIG today (data, not a constant the view may assume). */
const PHASES = [
  'propose',
  'spec',
  'design',
  'tasks',
  'apply',
  'verify',
  'archive',
  'explore',
  'research',
  'onboard',
];

/**
 * 44 synthetic agents mirroring the live config's naming convention:
 * 10 phase families × {base, -cheap, -deep} = 30 matrix cells, plus 14
 * non-phase agents (12 non-sdd + the 2 orphan `sdd-orchestrator-*`
 * variants that have no base agent). Exactly 4 carry an explicit model —
 * the spec OA-1 "defaults shown" scenario.
 */
function sampleAgents(extra?: Record<string, AgentConfigEntry>) {
  const agents: Record<string, AgentConfigEntry> = {};
  for (const phase of PHASES) {
    agents[`sdd-${phase}`] = { description: 'synthetic' };
    agents[`sdd-${phase}-cheap`] = { description: 'synthetic' };
    agents[`sdd-${phase}-deep`] = { description: 'synthetic' };
  }
  agents['sdd-spec-deep'].model = 'nan/qwen3.8-flash';
  agents['sdd-tasks-deep'].model = 'nan/qwen3.8-flash';
  agents['sdd-design'].prompt = 'Design prompt body.';
  const nonPhase: Array<[string, AgentConfigEntry]> = [
    [
      'explore',
      { description: 'd', prompt: 'Explore prompt body — synthetic.' },
    ],
    [
      'general',
      {
        description: 'd',
        'gentle-ai:sdd-model-assignments': { 'sdd-spec': 'nan/qwen3.6' },
      },
    ],
    [
      'gentle-orchestrator',
      {
        description: 'd',
        prompt:
          'You are the gentle orchestrator.\n<gentle-ai:sdd-model-assignments>\nsdd-spec-deep: nan/qwen3.8-flash\n</gentle-ai:sdd-model-assignments>\nRoute phases accordingly.',
      },
    ],
    ['jd-judge-a', { description: 'd' }],
    ['jd-judge-b', { description: 'd' }],
    ['jd-fix-agent', { description: 'd' }],
    ['review-readability', { description: 'd' }],
    ['review-refuter', { description: 'd' }],
    ['review-reliability', { description: 'd' }],
    ['review-resilience', { description: 'd' }],
    ['review-risk', { description: 'd' }],
    ['review-validator', { description: 'd' }],
    [
      'sdd-orchestrator-cheap',
      { description: 'd', model: 'nan/qwen3.8-flash' },
    ],
    [
      'sdd-orchestrator-deep',
      { description: 'd', model: 'nanSendvalu/glm5.3' },
    ],
  ];
  for (const [name, entry] of nonPhase) agents[name] = entry;
  return { ...agents, ...extra };
}

/** Installed catalog = provider ids × declared model ids (the ONLY picker source). */
const INSTALLED_PAIRS = [
  'nan/qwen3.8-flash',
  'nan/qwen3.6',
  'nan/mimo-v2.5',
  'nanSendvalu/glm5.3',
];

function fixture(agents: Record<string, AgentConfigEntry>): ConfigResponse {
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
          'qwen3.8-flash': { name: 'Qwen 3.8 Flash', contextWindow: 1000000 },
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
        name: 'NaN Sendvalu',
        npm: '@ai-sdk/openai-compatible',
        options: { apiKey: { configured: false } },
        models: { 'glm5.3': { name: 'GLM 5.3', contextWindow: 1000000 } },
      },
    },
    agents,
    defaultAgent: 'gentle-orchestrator',
    authJson: { exists: [] },
    snapshotAsOf: '2026-09-04',
  };
}

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/** The AT-1 shape: exactly the 4 bundled presets (server asset tested WU-A). */
const TEMPLATES_REPLY = {
  status: 200,
  body: {
    templates: [
      {
        id: 'reviewer',
        label: 'Reviewer',
        description: 'Code review',
        prompt: '# Reviewer\nYou review code changes for correctness first.',
      },
      {
        id: 'executor',
        label: 'Executor',
        description: 'Task delivery',
        prompt:
          '# Executor\nYou implement exactly the assigned task and nothing else.',
      },
      {
        id: 'orchestrator',
        label: 'Orchestrator',
        description: 'Coordination',
        prompt:
          '# Orchestrator\nYou coordinate work; you do not implement it yourself.',
      },
      {
        id: 'blank',
        label: 'Blank',
        description: 'Stub',
        prompt: '# New agent\nThis agent has no custom instructions yet.',
      },
    ],
  },
};

/**
 * Scripted fetch (WU6/WU7 pattern): GET /api/config replays the queue
 * (sticky last), PUT /api/agents/:name/model consumes its queue and fails
 * loudly when exhausted — a stray request can never pass unnoticed.
 * WU-B adds the create-flow lanes: templates (sticky) plus fail-loud queues
 * for the prompt-resolve GET and the POST /api/agents create.
 */
function scriptApi(
  opts: {
    gets?: ConfigResponse[];
    puts?: { status: number; body: unknown }[];
    /** WU9 — queued replies for POST /api/sync (fails loud when exhausted). */
    syncs?: { status: number; body: unknown }[];
    /** WU-B — GET /api/templates (sticky single reply by default). */
    templates?: { status: number; body: unknown }[];
    /** WU-B — GET /api/agents/:name/prompt queue (fails loud when exhausted). */
    prompts?: { status: number; body: unknown }[];
    /** WU-B — POST /api/agents queue (fails loud when exhausted). */
    creates?: { status: number; body: unknown }[];
    /** agent-pipelines WU-4 — GET /api/agent-pipelines (sticky last).
     * Raw response bodies (or {status,body} envelopes) both accepted. */
    pipelines?: unknown[];
    /** agent-pipelines WU-4 — POST/PUT /api/agent-pipelines[/name] queue. */
    pipelineWrites?: { status: number; body: unknown }[];
    /** agent-pipelines WU-4 — DELETE /api/agent-pipelines/name queue. */
    pipelineDeletes?: { status: number; body: unknown }[];
    /** agent-pipelines WU-4 — DELETE /api/agents/name queue. */
    agentDeletes?: { status: number; body: unknown }[];
    /** agent-pipelines WU-4 — PUT /api/config/default-agent queue. */
    defaults?: { status: number; body: unknown }[];
  } = {},
) {
  const calls: Call[] = [];
  const gets = [...(opts.gets ?? [fixture(sampleAgents())])];
  const puts = [...(opts.puts ?? [])];
  const syncs = [...(opts.syncs ?? [])];
  const templates = [...(opts.templates ?? [TEMPLATES_REPLY])];
  const prompts = [...(opts.prompts ?? [])];
  const creates = [...(opts.creates ?? [])];
  const pipelines = [...(opts.pipelines ?? [{ pipelines: {} }])];
  const pipelineWrites = [...(opts.pipelineWrites ?? [])];
  const pipelineDeletes = [...(opts.pipelineDeletes ?? [])];
  const agentDeletes = [...(opts.agentDeletes ?? [])];
  const defaults = [...(opts.defaults ?? [])];
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
      if (method === 'PUT' && /^\/api\/agents\/[^/]+\/model$/.test(url)) {
        const reply = puts.shift();
        if (!reply) throw new Error(`PUT script exhausted at ${url}`);
        return json(reply.status, reply.body);
      }
      if (method === 'POST' && url === '/api/sync') {
        const reply = syncs.shift();
        if (!reply) throw new Error('POST /api/sync script exhausted');
        return json(reply.status, reply.body);
      }
      if (method === 'GET' && url === '/api/templates') {
        const reply = templates.length > 1 ? templates.shift() : templates[0];
        if (!reply) throw new Error('GET /api/templates script exhausted');
        return json(reply.status, reply.body);
      }
      if (method === 'GET' && /^\/api\/agents\/[^/]+\/prompt$/.test(url)) {
        const reply = prompts.shift();
        if (!reply) throw new Error(`GET prompt script exhausted at ${url}`);
        return json(reply.status, reply.body);
      }
      if (method === 'POST' && url === '/api/agents') {
        const reply = creates.shift();
        if (!reply) throw new Error('POST /api/agents script exhausted');
        return json(reply.status, reply.body);
      }
      // --- agent-pipelines WU-4 lanes -------------------------------------
      if (method === 'GET' && url === '/api/agent-pipelines') {
        const next = pipelines.length > 1 ? pipelines.shift() : pipelines[0];
        const env = next as { status?: number; body?: unknown };
        const payload = env && 'body' in env ? env.body : next; // raw or envelope shape
        return json(200, payload);
      }
      if (
        (method === 'POST' && url === '/api/agent-pipelines') ||
        (method === 'PUT' && /^\/api\/agent-pipelines\//.test(url))
      ) {
        const reply = pipelineWrites.shift();
        if (!reply) throw new Error(`${method} ${url} script exhausted`);
        return json(reply.status, reply.body);
      }
      if (method === 'DELETE' && /^\/api\/agent-pipelines\//.test(url)) {
        const reply = pipelineDeletes.shift();
        if (!reply) throw new Error(`${method} ${url} script exhausted`);
        return json(reply.status, reply.body);
      }
      if (method === 'DELETE' && /^\/api\/agents\//.test(url)) {
        const reply = agentDeletes.shift();
        if (!reply) throw new Error(`${method} ${url} script exhausted`);
        return json(reply.status, reply.body);
      }
      if (method === 'PUT' && url === '/api/config/default-agent') {
        const reply = defaults.shift();
        if (!reply) throw new Error('PUT default-agent script exhausted');
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

function matrixTable(): HTMLElement {
  return screen.getByRole('table', { name: 'Phase model assignments' });
}

function otherTable(): HTMLElement {
  return screen.getByRole('table', { name: 'Other agents' });
}

async function rendered() {
  render(<OrchestrationView />);
  await screen.findByRole('table', { name: 'Phase model assignments' });
}

function picker(agentName: string): HTMLSelectElement {
  return screen.getByRole('combobox', {
    name: `${agentName} model`,
  }) as HTMLSelectElement;
}

function optionValues(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((o) => o.value);
}

function selectedText(select: HTMLSelectElement): string {
  const opt = select.selectedOptions[0];
  return opt ? String(opt.textContent) : '';
}

function setModel(agentName: string, value: string) {
  fireEvent.change(picker(agentName), { target: { value } });
}

const writes = (calls: Call[]) => calls.filter((c) => c.method === 'PUT');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Orchestration — matrix and list derived generically from agent.* (OA-1)', () => {
  it('renders the base/-cheap/-deep matrix as exactly 30 gated cells', async () => {
    scriptApi();
    await rendered();
    const matrix = within(matrixTable());
    // 10 families × 3 columns = 30 cells; header + 10 rows. WU-4: the whole
    // fixture is gentle-ai-owned, so every cell is read-only text — the
    // DERIVATION is unchanged, only the cell surface is gated (S10).
    expect(matrix.queryAllByRole('combobox')).toHaveLength(0);
    expect(matrix.getAllByRole('row').length).toBe(11);
    const specRow = matrix.getByRole('row', { name: 'sdd-spec' });
    expect(
      within(specRow).queryByRole('combobox', { name: 'sdd-spec-cheap model' }),
    ).toBeNull();
    expect(within(specRow).getAllByText('runtime default').length).toBe(2);
    expect(within(specRow).getByText('nan/qwen3.8-flash')).toBeTruthy();
  });

  it('lists the 14 non-phase agents, including orphan -cheap/-deep variants', async () => {
    scriptApi();
    await rendered();
    const others = within(otherTable());
    // header + 14 rows; every row is an agent — WU-4 gates them all here
    // (the fixture's others are all gentle-ai-owned), so read-only text
    // replaces the pickers.
    expect(others.getAllByRole('row').length).toBe(15);
    expect(others.queryAllByRole('combobox')).toHaveLength(0);
    for (const name of [
      'sdd-orchestrator-cheap',
      'sdd-orchestrator-deep',
      'gentle-orchestrator',
      'review-validator',
      'jd-judge-a',
      'explore',
    ]) {
      expect(others.getByRole('row', { name })).toBeTruthy();
    }
    // Orphan variants must NOT be promoted into matrix rows.
    expect(
      within(matrixTable()).queryByRole('row', {
        name: 'sdd-orchestrator-cheap',
      }),
    ).toBeNull();
  });

  it('gains a 15th non-phase row when CONFIG gains one agent — zero code changes', async () => {
    scriptApi({
      gets: [
        fixture(sampleAgents({ 'review-doc-integrity': { description: 'd' } })),
      ],
    });
    await rendered();
    const others = within(otherTable());
    expect(others.getAllByRole('row').length).toBe(16);
    // WU-4: the new row is review-* (reserved) — it renders read-only, and
    // the generic derivation is otherwise unchanged.
    expect(
      others.getByRole('row', { name: 'review-doc-integrity' }),
    ).toBeTruthy();
    expect(
      others.queryByRole('combobox', { name: 'review-doc-integrity model' }),
    ).toBeNull();
    expect(
      within(
        others.getByRole('row', { name: 'review-doc-integrity' }),
      ).getByText('runtime default'),
    ).toBeTruthy();
    // Still 30 matrix cells — the lone agent cannot form a family row.
    expect(within(matrixTable()).getAllByRole('row').length).toBe(11);
  });

  it('derives a brand-new family row from unseen names; the missing cell renders absent', async () => {
    scriptApi({
      gets: [
        fixture(
          sampleAgents({
            'quantum-phase': { description: 'd' },
            'quantum-phase-cheap': { description: 'd' },
          }),
        ),
      ],
    });
    await rendered();
    const matrix = within(matrixTable());
    expect(matrix.getAllByRole('row').length).toBe(12); // header + 11
    // WU-4: the reserved cells are gated; only the user-owned
    // quantum-phase base/cheap pickers remain active.
    expect(matrix.getAllByRole('combobox').length).toBe(2);
    const row = matrix.getByRole('row', { name: 'quantum-phase' });
    expect(within(row).getByText('agent absent')).toBeTruthy();
    expect(
      screen.queryByRole('combobox', { name: 'quantum-phase-deep model' }),
    ).toBeNull();
  });

  it('shows "runtime default" for unset agents and the declared pairs for the 4 explicit ones', async () => {
    scriptApi();
    await rendered();
    // WU-4: the fixture is all-reserved, so values surface as read-only
    // text — the declared/defaults truth is unchanged (S10).
    const specRow = within(matrixTable()).getByRole('row', {
      name: 'sdd-spec',
    });
    expect(within(specRow).getAllByText('runtime default').length).toBe(2);
    expect(within(specRow).getByText('nan/qwen3.8-flash')).toBeTruthy();
    expect(
      within(
        within(matrixTable()).getByRole('row', { name: 'sdd-tasks' }),
      ).getByText('nan/qwen3.8-flash'),
    ).toBeTruthy();
    expect(
      within(
        within(otherTable()).getByRole('row', {
          name: 'sdd-orchestrator-cheap',
        }),
      ).getByText('nan/qwen3.8-flash'),
    ).toBeTruthy();
    expect(
      within(
        within(otherTable()).getByRole('row', {
          name: 'sdd-orchestrator-deep',
        }),
      ).getByText('nanSendvalu/glm5.3'),
    ).toBeTruthy();
  });
});

describe('Orchestration — pickers are limited to the installed catalog (OA-2)', () => {
  it('offers only provider/model pairs present in the config response', async () => {
    // WU-4: picker behavior is pinned on user-owned rows (reserved rows are
    // gated read-only); the catalog rule itself is unchanged.
    scriptApi({
      gets: [
        fixture(
          sampleAgents({
            'my-helper': { description: 'd' },
            'my-assistant': { description: 'd' },
          }),
        ),
      ],
    });
    await rendered();
    for (const name of ['my-helper', 'my-assistant']) {
      expect(optionValues(picker(name))).toEqual(['', ...INSTALLED_PAIRS]);
    }
    // headroom declares ZERO models → no headroom option anywhere;
    // uninstalled pairs are simply not offered.
    for (const name of ['my-helper', 'my-assistant']) {
      const values = optionValues(picker(name));
      expect(values.some((v) => v.startsWith('headroom/'))).toBe(false);
      expect(values).not.toContain('nan/not-installed');
    }
  });

  it('keeps a declared model that is no longer installed visible', async () => {
    scriptApi({
      gets: [
        fixture(
          sampleAgents({
            'my-helper': { description: 'd', model: 'ghostly/missing-1' },
            'my-assistant': { description: 'd' },
          }),
        ),
      ],
    });
    await rendered();
    const stale = picker('my-helper');
    expect(stale.value).toBe('ghostly/missing-1');
    // It is displayed for THIS agent without leaking into other pickers.
    expect(optionValues(stale)).toEqual([
      '',
      'ghostly/missing-1',
      ...INSTALLED_PAIRS,
    ]);
    expect(optionValues(picker('my-assistant'))).toEqual([
      '',
      ...INSTALLED_PAIRS,
    ]);
  });
});

describe('Orchestration — prompts open a reader modal, cells stay picker-only (OA-4, D8)', () => {
  it('cells carry a view-prompt trigger and marker chips, never prompt bodies (WU-B D8)', async () => {
    scriptApi({
      prompts: [
        {
          status: 200,
          body: {
            name: 'explore',
            source: 'inline',
            prompt: 'Explore prompt body — synthetic.',
          },
        },
      ],
    });
    await rendered();
    // No prompt body or marker block renders inside any cell (reader-only).
    expect(screen.queryByText(/Explore prompt body — synthetic\./)).toBeNull();
    expect(screen.queryByText(/Design prompt body\./)).toBeNull();
    expect(screen.queryByText(/<gentle-ai:sdd-model-assignments>/)).toBeNull();
    // The structured gentle-ai:* key survives as a labeled read-only chip,
    // with NO value content rendered into the cell.
    const generalRow = within(otherTable()).getByRole('row', {
      name: 'general',
    });
    expect(
      within(generalRow).getByText('gentle-ai:sdd-model-assignments'),
    ).toBeTruthy();
    expect(within(generalRow).getByText('read-only')).toBeTruthy();
    expect(generalRow.querySelectorAll('pre').length).toBe(0);
    // Exactly the 3 agents with a prompt body expose the trigger.
    expect(screen.getAllByRole('button', { name: 'view prompt' }).length).toBe(
      3,
    );
    const jdRow = within(otherTable()).getByRole('row', {
      name: 'jd-judge-a',
    });
    expect(
      within(jdRow).queryByRole('button', { name: 'view prompt' }),
    ).toBeNull();
    // WU-4: the tables hold NO editors at all — the fixture's agents are all
    // gentle-ai-owned, so every cell is read-only text (no combobox to sweep).
    expect(screen.queryAllByRole('textbox').length).toBe(0);
    expect(document.querySelectorAll('textarea').length).toBe(0);
    expect(within(matrixTable()).queryAllByRole('combobox')).toHaveLength(0);
    expect(within(otherTable()).queryAllByRole('combobox')).toHaveLength(0);
    // The only active combobox outside modals is the header AP-7 default
    // agent picker — tables stay editor-free.
    expect(
      String(
        screen
          .getByRole('combobox', { name: 'Default agent' })
          .getAttribute('aria-label'),
      ),
    ).toMatch(/^Default agent$/);
    // "view prompt" opens the read-only reader with the FULL content.
    const exploreRow = within(otherTable()).getByRole('row', {
      name: 'explore',
    });
    fireEvent.click(
      within(exploreRow).getByRole('button', { name: 'view prompt' }),
    );
    const reader = await screen.findByRole('dialog', {
      name: 'explore prompt',
    });
    expect(
      within(reader).getByText('Explore prompt body — synthetic.'),
    ).toBeTruthy();
    expect(reader.querySelectorAll('textarea, input').length).toBe(0);
    fireEvent.click(within(reader).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('never sends prompt or marker content in any save call', async () => {
    // WU-4: the save flow is pinned on user-owned agents (reserved rows are
    // gated); the wire contract is unchanged.
    const { calls } = scriptApi({
      gets: [
        fixture(
          sampleAgents({
            'my-helper': {
              description: 'd',
              prompt: 'Helper prompt.',
            },
            'my-assistant': {
              description: 'd',
              'gentle-ai:sdd-model-assignments': { 'my-helper': 'nan/qwen3.6' },
            },
          }),
        ),
      ],
      puts: [okWrite('echo-A'), okWrite('echo-B')],
    });
    await rendered();
    setModel('my-helper', 'nan/qwen3.6');
    setModel('my-assistant', 'nan/mimo-v2.5');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Restart OpenCode to apply');
    const w = writes(calls);
    expect(w.length).toBe(2);
    for (const c of w) {
      // The ONLY endpoint and the ONLY body keys the view may use.
      expect(c.url).toMatch(/^\/api\/agents\/[^/]+\/model$/);
      expect(Object.keys(c.body ?? {}).sort()).toEqual(['hash', 'model']);
    }
    const wire = JSON.stringify(w);
    expect(wire).not.toContain('prompt');
    expect(wire).not.toContain('gentle-ai');
    expect(wire).not.toContain('apiKey');
    expect(wire).not.toContain('configured');
  });
});

describe('Orchestration — set/clear saves through PUT /api/agents/:name/model (OA-2, OA-3)', () => {
  // WU-4: reserved rows are gated, so the direct-PUT save flows are pinned
  // on user-owned agents — their picker semantics are UNCHANGED (S11).
  const ownedAgents = () =>
    sampleAgents({
      'my-helper': { description: 'standalone' },
      'my-assistant': { description: 'standalone', model: 'nan/qwen3.8-flash' },
    });

  it('sets a model, chains the echoed hash, and advises running gentle-ai sync', async () => {
    const { calls } = scriptApi({
      gets: [fixture(ownedAgents())],
      puts: [okWrite('echo-A')],
    });
    await rendered();
    setModel('my-helper', 'nan/qwen3.6');
    expect(screen.getByText('1 change')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // CX-3 restart notice + the OA-3 advisory (text only — sync ships WU9).
    await screen.findByText('Restart OpenCode to apply');
    expect(
      screen.getByText(/run gentle-ai sync to refresh prompt table/),
    ).toBeTruthy();
    const put = writes(calls)[0];
    expect(put.url).toBe('/api/agents/my-helper/model');
    expect(put.body).toEqual({ hash: 'hash-base-0001', model: 'nan/qwen3.6' });
    expect(picker('my-helper').value).toBe('nan/qwen3.6');
    expect(screen.getByText('No changes')).toBeTruthy();
  });

  it('clearing an assignment PUTs null and the row falls back to runtime default', async () => {
    const { calls } = scriptApi({
      gets: [fixture(ownedAgents())],
      puts: [okWrite('echo-X')],
    });
    await rendered();
    expect(picker('my-assistant').value).toBe('nan/qwen3.8-flash');
    setModel('my-assistant', '');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Restart OpenCode to apply');
    expect(writes(calls)[0].body).toEqual({
      hash: 'hash-base-0001',
      model: null,
    });
    expect(picker('my-assistant').value).toBe('');
    expect(selectedText(picker('my-assistant'))).toBe('runtime default');
  });

  it('flushes multiple agent edits sequentially, chaining every echoed hash', async () => {
    const { calls } = scriptApi({
      gets: [fixture(ownedAgents())],
      puts: [okWrite('echo-A'), okWrite('echo-B')],
    });
    await rendered();
    setModel('my-helper', 'nan/mimo-v2.5');
    setModel('my-assistant', 'nan/qwen3.6');
    expect(screen.getByText('2 changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Restart OpenCode to apply');
    const w = writes(calls);
    expect(w.length).toBe(2);
    expect(w[0].url).toBe('/api/agents/my-helper/model');
    expect(w[0].body).toEqual({
      hash: 'hash-base-0001',
      model: 'nan/mimo-v2.5',
    });
    expect(w[1].url).toBe('/api/agents/my-assistant/model');
    expect(w[1].body).toEqual({ hash: 'echo-A', model: 'nan/qwen3.6' });
    expect(picker('my-assistant').value).toBe('nan/qwen3.6');
  });

  it('discarding pending picker changes restores the loaded values', async () => {
    const { calls } = scriptApi({ gets: [fixture(ownedAgents())] });
    await rendered();
    setModel('my-helper', 'nan/qwen3.6');
    setModel('my-assistant', '');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByText('No changes')).toBeTruthy();
    expect(picker('my-helper').value).toBe('');
    expect(picker('my-assistant').value).toBe('nan/qwen3.8-flash');
    expect(writes(calls).length).toBe(0);
  });
});

describe('Orchestration — conflict and validation reuse the established flows (SCW-2, SCW-3)', () => {
  // WU-4: flows re-anchored on user-owned agents (reserved rows are gated);
  // the SCW-2/SCW-3 mechanics are unchanged.
  const ownedAgents = (extra?: Record<string, AgentConfigEntry>) =>
    sampleAgents({
      'my-helper': { description: 'standalone' },
      'my-assistant': { description: 'standalone', model: 'nan/qwen3.8-flash' },
      ...extra,
    });

  it('409 opens the conflict diff; Reload fresh keeps the edit re-appliable on the new hash', async () => {
    const fresh = fixture(
      ownedAgents({
        'my-helper': { description: 'standalone', model: 'nan/qwen3.8-flash' },
      }),
    );
    fresh.hash = 'hash-external-9';
    const stale = {
      status: 409,
      body: {
        ok: false,
        error: {
          code: 'stale',
          message: 'Config changed since it was loaded; save rejected.',
          expected: 'hash-base-0001',
          actual: 'hash-external-9',
        },
      },
    };
    const { calls } = scriptApi({
      gets: [fixture(ownedAgents()), fresh],
      puts: [stale, okWrite('echo-F')],
    });
    await rendered();
    setModel('my-helper', 'nan/qwen3.6');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Config conflict',
    });
    expect(within(dialog).getByText('agent.my-helper.model')).toBeTruthy();
    expect(within(dialog).getByText('hash-base-0001')).toBeTruthy();
    expect(within(dialog).getByText('hash-external-9')).toBeTruthy();
    expect(within(dialog).getByText('nan/qwen3.6')).toBeTruthy();
    expect(within(dialog).getByText('nan/qwen3.8-flash')).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Reload fresh' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Pending edit survives the reload and re-applies against the fresh hash.
    expect(screen.getByText('1 change')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Restart OpenCode to apply');
    const w = writes(calls);
    expect(w.length).toBe(2);
    expect(w[1].body).toEqual({
      hash: 'hash-external-9',
      model: 'nan/qwen3.6',
    });
  });

  it('409 Overwrite retries the remaining write immediately with the fresh hash', async () => {
    const fresh = fixture(ownedAgents());
    fresh.hash = 'hash-external-9';
    const stale = {
      status: 409,
      body: {
        ok: false,
        error: {
          code: 'stale',
          message: 'Config changed since it was loaded; save rejected.',
          expected: 'hash-base-0001',
          actual: 'hash-external-9',
        },
      },
    };
    const { calls } = scriptApi({
      gets: [fixture(ownedAgents()), fresh],
      puts: [stale, okWrite('echo-W')],
    });
    await rendered();
    setModel('my-assistant', 'nan/qwen3.6');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Config conflict',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Overwrite' }));
    await screen.findByText('Restart OpenCode to apply');
    const w = writes(calls);
    expect(w.length).toBe(2);
    expect(w[1].body).toEqual({
      hash: 'hash-external-9',
      model: 'nan/qwen3.6',
    });
    expect(picker('my-assistant').value).toBe('nan/qwen3.6');
  });

  it('400 renders per-path issues in the save bar and keeps pending edits', async () => {
    const { calls } = scriptApi({
      gets: [fixture(ownedAgents())],
      puts: [
        {
          status: 400,
          body: {
            ok: false,
            error: {
              code: 'invalid',
              message: 'Validation failed.',
              issues: [
                {
                  path: 'agent.my-helper.model',
                  message: 'expected a "provider/model" string',
                },
              ],
            },
          },
        },
      ],
    });
    await rendered();
    setModel('my-helper', 'nan/qwen3.6');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/agent\.my-helper\.model: expected a/),
    ).toBeTruthy();
    // Pending edits survive; no success state, no advisory.
    expect(picker('my-helper').value).toBe('nan/qwen3.6');
    expect(screen.queryByText('Restart OpenCode to apply')).toBeNull();
    expect(screen.queryByText(/run gentle-ai sync/)).toBeNull();
    expect(writes(calls).length).toBe(1);
  });
});

describe('Orchestration — empty state (0..N)', () => {
  it('renders an explicit empty state when CONFIG declares no agents', async () => {
    scriptApi({ gets: [fixture({})] });
    render(<OrchestrationView />);
    expect(await screen.findByText('No agents declared')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    // WU-B: the create CTA is available even with zero agents (bootstrap).
    expect(screen.getByRole('button', { name: 'Create agent' })).toBeTruthy();
  });
});

describe('Orchestration — create flow: CTA, AC-8 placement, reader XSS (WU-B)', () => {
  async function openCreate() {
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    const dlg = await screen.findByRole('dialog', { name: 'New agent' });
    // Presets arrived (AT-1) before any selection is scripted.
    await within(dlg).findByText('Reviewer');
    return dlg;
  }
  const createCalls = (calls: Call[]) =>
    calls.filter((c) => c.method === 'POST' && c.url === '/api/agents');

  it('the header CTA opens the New agent modal and fetches the presets once', async () => {
    const { calls } = scriptApi();
    await rendered();
    const dlg = await openCreate();
    expect(within(dlg).getByLabelText('Name')).toBeTruthy();
    expect(
      calls.filter((c) => c.method === 'GET' && c.url === '/api/templates')
        .length,
    ).toBe(1);
    fireEvent.click(within(dlg).getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'New agent' })).toBeNull(),
    );
    // WU-4: the all-reserved matrix renders read-only cells — no pickers.
    expect(within(matrixTable()).queryAllByRole('combobox')).toHaveLength(0);
  });

  it('a template create closes the modal, re-reads CONFIG and the agent lands as a generic list row (AC-8, AC-9, CX-3)', async () => {
    const after = fixture(
      sampleAgents({
        'my-helper': {
          description: 'created via dashboard',
          prompt: '# New agent\nThis agent has no custom instructions yet.',
        },
      }),
    );
    after.hash = 'hash-post-create';
    const { calls } = scriptApi({
      gets: [fixture(sampleAgents()), after],
      creates: [{ status: 200, body: { ok: true, hash: 'hash-post-create' } }],
    });
    await rendered();
    const dlg = await openCreate();
    fireEvent.change(within(dlg).getByLabelText('Name'), {
      target: { value: 'my-helper' },
    });
    fireEvent.change(within(dlg).getByLabelText('Prompt source'), {
      target: { value: 'template:blank' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'New agent' })).toBeNull(),
    );
    // AC-8: generic derivation places the lone agent as a list row — the
    // view logic is untouched, the reloaded CONFIG is the only input.
    const row = within(otherTable()).getByRole('row', { name: 'my-helper' });
    expect(row).toBeTruthy();
    expect(picker('my-helper').value).toBe('');
    const post = createCalls(calls)[0];
    expect(post.body).toEqual({
      hash: 'hash-base-0001',
      name: 'my-helper',
      agent: {
        prompt: '# New agent\nThis agent has no custom instructions yet.',
      },
    });
    // CX-3 restart notice applies after create; CONFIG was re-read once.
    expect(screen.getByText('Restart OpenCode to apply')).toBeTruthy();
    expect(
      calls.filter((c) => c.method === 'GET' && c.url === '/api/config').length,
    ).toBe(2);
  });

  it('an evil cloned prompt is inert in the reader modal (XSS threat, text node only)', async () => {
    const evil = `<script>alert('xss')</script>`;
    scriptApi({
      gets: [fixture(sampleAgents({ 'evil-xss': { prompt: evil } }))],
      prompts: [
        {
          status: 200,
          body: { name: 'evil-xss', source: 'inline', prompt: evil },
        },
      ],
    });
    vi.stubGlobal(
      'alert',
      vi.fn(() => true),
    );
    await rendered();
    const row = within(otherTable()).getByRole('row', { name: 'evil-xss' });
    expect(
      within(row).getByRole('button', { name: 'view prompt' }),
    ).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'view prompt' }));
    const reader = await screen.findByRole('dialog', {
      name: 'evil-xss prompt',
    });
    // The payload is visible as literal text…
    expect(within(reader).getByText(evil)).toBeTruthy();
    // …and NOTHING executed: zero script nodes, alert never called.
    expect(document.querySelectorAll('script').length).toBe(0);
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('Orchestration — sync panel pass-through re-baselines the list (WU9, OA-3)', () => {
  /** Sync reply for the view-level queue. */
  const syncReply = (
    exitCode: number,
    extra: Record<string, unknown> = {},
  ): { status: number; body: unknown } => ({
    status: 200,
    body: {
      ok: true,
      exitCode,
      stdout: 'gentle-ai sync: prompt table refreshed\n',
      stderr: '',
      ...extra,
    },
  });

  it('a successful sync re-GETs /api/config and the list reflects post-sync agents', async () => {
    const pre = fixture(sampleAgents());
    const post = fixture(
      sampleAgents({ 'post-sync-agent': { model: 'nan/qwen3.6' } }),
    );
    post.hash = 'hash-post-sync';
    const { calls } = scriptApi({
      gets: [pre, post],
      syncs: [syncReply(0, { hash: 'hash-post-sync' })],
    });
    await rendered();
    // Pre-sync the agent does not exist anywhere generic-derived.
    expect(
      within(otherTable()).queryByRole('row', { name: 'post-sync-agent' }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Run sync' }));
    expect(await screen.findByText('exit 0')).toBeTruthy();

    // The panel's success path asked the parent to refresh, and the parent
    // re-read CONFIG: GET /api/config ran exactly twice. (WU-4: the count is
    // scoped to /api/config — the definitions lane polls in parallel and is
    // not a CONFIG reload; the proven semantics are unchanged.)
    expect(
      calls.filter((c) => c.method === 'GET' && c.url === '/api/config'),
    ).toHaveLength(2);
    await waitFor(() =>
      expect(
        within(otherTable()).getByRole('row', { name: 'post-sync-agent' }),
      ).toBeTruthy(),
    );
    expect(picker('post-sync-agent').value).toBe('nan/qwen3.6');
    expect(screen.getByText(/Sync succeeded — CONFIG reloaded/)).toBeTruthy();
  });

  it('a failed sync surfaces output + failure chip but never reloads or claims success', async () => {
    const { calls } = scriptApi({
      syncs: [
        syncReply(2, {
          stdout: 'gentle-ai sync: starting\n',
          stderr: 'sync aborted\n',
        }),
      ],
    });
    await rendered();
    fireEvent.click(screen.getByRole('button', { name: 'Run sync' }));
    expect(await screen.findByText('exit 2')).toBeTruthy();
    expect(screen.getByText(/sync aborted/)).toBeTruthy();
    expect(screen.queryByText(/Sync succeeded/)).toBeNull();
    // Still the single initial CONFIG read — nothing re-baselined on failure
    // (definitions-lane GET scoped out — same semantics as above).
    expect(
      calls.filter((c) => c.method === 'GET' && c.url === '/api/config'),
    ).toHaveLength(1);
  });

  it('a successful sync clears the OA-3 "run gentle-ai sync" advisory it answers', async () => {
    const { calls } = scriptApi({
      gets: [
        fixture(sampleAgents({ 'my-helper': { description: 'standalone' } })),
      ],
      puts: [okWrite('echo-A')],
      syncs: [syncReply(0, { hash: 'echo-A' })],
    });
    await rendered();
    // WU-6 MIGRATION of the pinned legacy flow: reserved `sdd-spec` no
    // longer takes setModel — the row has NO active picker (S10), and the
    // assignment leg flows through the panel's ONE native sync (POST
    // /api/sync). The retained direct-PUT leg is re-anchored on the
    // user-owned `my-helper` to raise the advisory (S11).
    expect(
      screen.queryByRole('combobox', { name: 'sdd-spec model' }),
    ).toBeNull();
    expect(
      within(
        within(matrixTable()).getByRole('row', { name: 'sdd-spec' }),
      ).queryAllByRole('combobox'),
    ).toHaveLength(0);
    setModel('my-helper', 'nan/qwen3.6');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Restart OpenCode to apply');
    expect(
      screen.getByText('run gentle-ai sync to refresh prompt table'),
    ).toBeTruthy();

    // The assignment leg: apply through the panel — the native sync that IS
    // that advice; exit 0 clears the advisory once done.
    fireEvent.change(screen.getByLabelText('assign sdd-spec (deep)'), {
      target: { value: 'nan/qwen3.6' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply assignments' }));
    expect(await screen.findByText('exit 0')).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.queryByText('run gentle-ai sync to refresh prompt table'),
      ).toBeNull(),
    );
    // And the list refresh re-anchored the view on the fresh CONFIG (2 CONFIG GETs).
    expect(
      calls.filter((c) => c.method === 'GET' && c.url === '/api/config'),
    ).toHaveLength(2);
  });
});

// ===================== agent-pipelines WU-4 (task 4.1 — RED) ================
// Grouping + badges + disabled member cells + delete confirms + user-owned
// danger buttons + default-agent picker surface (AP-9, AP-4, AP-6, AP-7).
import type { PipelineDefinition } from '../../../shared/types';
import {
  RESERVED_EXACT as CLIENT_EXACT,
  RESERVED_PREFIXES as CLIENT_PREFIXES,
} from '../client-ownership';
import {
  RESERVED_EXACT,
  RESERVED_PREFIXES,
} from '../../../server/src/config/ownership';

/** One pipeline over the sampleAgents base: mypl + 2 roles (AP-1 def). */
function pipelineAgents() {
  return sampleAgents({
    mypl: {
      mode: 'primary',
      description: 'coordinate mypl',
      prompt: 'You are `mypl`, the "mypl" pipeline coordinator.\nDelegate…',
    },
    'mypl-build': {
      mode: 'subagent',
      hidden: true,
      description: 'builds',
      prompt: 'Build prompt.',
    },
    'mypl-review': {
      mode: 'subagent',
      hidden: true,
      description: 'reviews',
      prompt: 'Review prompt.',
    },
    'my-helper': { description: 'standalone', prompt: 'Helper prompt.' },
  });
}

const PIPELINE_DEFS: { pipelines: Record<string, PipelineDefinition> } = {
  pipelines: {
    mypl: {
      roles: [
        {
          name: 'mypl-build',
          description: 'builds',
          promptSource: 'template',
          prompt: 'Build prompt.',
        },
        {
          name: 'mypl-review',
          description: 'reviews',
          promptSource: 'template',
          prompt: 'Review prompt.',
        },
      ],
      orchestrator: { description: 'coordinate mypl' },
    },
  },
};

function pipelineTable(): HTMLElement {
  return screen.getByRole('table', { name: 'Pipeline mypl' });
}

async function renderedPipelines() {
  render(<OrchestrationView />);
  await screen.findByRole('table', { name: 'Pipeline mypl' });
}

describe('Orchestration — pipeline groups with badges (AP-9)', () => {
  it('members render grouped under the pipeline, never in the flat list', async () => {
    scriptApi({
      gets: [fixture(pipelineAgents())],
      pipelines: [PIPELINE_DEFS],
    });
    await renderedPipelines();
    const group = within(pipelineTable());
    for (const name of ['mypl', 'mypl-build', 'mypl-review']) {
      const row = group.getByRole('row', { name });
      // Badge grouping per member row (orchestrator included).
      expect(within(row).getByText('pipeline mypl')).toBeTruthy();
    }
    // The flat list holds the standalone user-owned helper — never members.
    const others = within(otherTable());
    expect(others.getByRole('row', { name: 'my-helper' })).toBeTruthy();
    for (const member of ['mypl', 'mypl-build', 'mypl-review']) {
      expect(others.queryByRole('row', { name: member })).toBeNull();
    }
    // Phase matrix untouched (AP-9 pattern: groupAgents/splitVariant intact;
    // WU-4 gates its reserved cells to read-only text — 0 active pickers).
    expect(within(matrixTable()).queryAllByRole('combobox')).toHaveLength(0);
  });

  it("member model cells are DISABLED with a builder pointer (AP-4: 'builder is the edit path)", async () => {
    scriptApi({
      gets: [fixture(pipelineAgents())],
      pipelines: [PIPELINE_DEFS],
    });
    await renderedPipelines();
    const buildRow = within(pipelineTable()).getByRole('row', {
      name: 'mypl-build',
    });
    const memberPicker = picker('mypl-build');
    expect(memberPicker.disabled).toBe(true);
    expect(selectedText(memberPicker)).toBeTruthy();
    expect(
      within(buildRow).getByRole('button', { name: 'edit in builder' }),
    ).toBeTruthy();
    // The pointer opens the builder PREFILLED from the definition (3b path).
    fireEvent.click(
      within(buildRow).getByRole('button', { name: 'edit in builder' }),
    );
    const dlg = await screen.findByRole('dialog', { name: 'Pipeline builder' });
    expect(
      (within(dlg).getByLabelText('Pipeline name') as HTMLInputElement).value,
    ).toBe('mypl');
    expect(
      (within(dlg).getByLabelText('Pipeline name') as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(within(dlg).getByText('Edit pipeline mypl')).toBeTruthy();
  });

  it('the pipeline delete confirm lists orchestrator + role names (N+1 rows)', async () => {
    const { calls } = scriptApi({
      gets: [fixture(pipelineAgents())],
      pipelines: [PIPELINE_DEFS],
    });
    await renderedPipelines();
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete pipeline mypl' }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Delete pipeline mypl?',
    });
    // Every affected row named (AP-5 surface): orchestrator + both roles.
    expect(within(confirm).getByText('mypl (orchestrator)')).toBeTruthy();
    expect(within(confirm).getByText(/^mypl-build/)).toBeTruthy();
    expect(within(confirm).getByText(/^mypl-review/)).toBeTruthy();
    expect(within(confirm).getByText(/3 rows/)).toBeTruthy();
    // Cancel sends NO request (MC-4 convention).
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls.filter((c) => c.method === 'DELETE').length).toBe(0);
  });

  it('confirming deletes via ONE DELETE with the base hash; success reloads and shows CX-3', async () => {
    const after = fixture(
      sampleAgents({
        'my-helper': { description: 'standalone', prompt: 'Helper prompt.' },
      }),
    );
    after.hash = 'hash-post-delete';
    const { calls } = scriptApi({
      gets: [fixture(pipelineAgents()), after],
      pipelines: [PIPELINE_DEFS, { pipelines: {} }],
      pipelineDeletes: [okWrite('hash-post-delete')],
    });
    await renderedPipelines();
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete pipeline mypl' }),
    );
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Delete pipeline mypl?',
    });
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Confirm delete' }),
    );
    await screen.findByText('Restart OpenCode to apply');
    const dels = calls.filter((c) => c.method === 'DELETE');
    expect(dels.length).toBe(1);
    expect(dels[0].url).toBe('/api/agent-pipelines/mypl');
    expect(dels[0].body).toEqual({ hash: 'hash-base-0001' });
    // Exactly one restart notice, and CONFIG + defs re-read.
    expect(screen.getAllByText('Restart OpenCode to apply').length).toBe(1);
    expect(await screen.findByRole('row', { name: 'my-helper' })).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Pipeline mypl' })).toBeNull();
  });
});

describe('Orchestration — user-owned danger buttons and prompt editing (AP-6, OA-4)', () => {
  it('danger delete renders ONLY on user-owned standalone rows (AP-6 predicate)', async () => {
    scriptApi({
      gets: [fixture(pipelineAgents())],
      pipelines: [PIPELINE_DEFS],
    });
    await renderedPipelines();
    const others = within(otherTable());
    const helperRow = others.getByRole('row', { name: 'my-helper' });
    expect(
      within(helperRow).getByRole('button', { name: 'delete' }),
    ).toBeTruthy();
    // Reserved rows never offer delete (sync owns them); members too.
    // (sdd-* live in the matrix families here — the three exact others rows.)
    for (const reservedRow of ['explore', 'general', 'gentle-orchestrator']) {
      const row = others.getByRole('row', { name: reservedRow });
      expect(within(row).queryByRole('button', { name: 'delete' })).toBeNull();
    }
    const memberRow = within(pipelineTable()).getByRole('row', {
      name: 'mypl-build',
    });
    expect(
      within(memberRow).queryByRole('button', { name: 'delete' }),
    ).toBeNull();
  });

  it("user-owned rows get an 'edit prompt' cell; reserved rows keep reader-only (OA-4')", async () => {
    scriptApi({
      gets: [fixture(pipelineAgents())],
      pipelines: [PIPELINE_DEFS],
      // The editor prefetches the current text through the reader endpoint.
      prompts: [
        {
          status: 200,
          body: {
            name: 'my-helper',
            source: 'inline',
            prompt: 'Helper prompt.',
          },
        },
      ],
    });
    await renderedPipelines();
    const helperRow = within(otherTable()).getByRole('row', {
      name: 'my-helper',
    });
    expect(
      within(helperRow).getByRole('button', { name: 'edit prompt' }),
    ).toBeTruthy();
    expect(
      within(helperRow).getByRole('button', { name: 'view prompt' }),
    ).toBeTruthy();
    for (const reservedRow of ['explore', 'general', 'gentle-orchestrator']) {
      const row = within(otherTable()).getByRole('row', { name: reservedRow });
      expect(
        within(row).queryByRole('button', { name: 'edit prompt' }),
      ).toBeNull();
    }
    // Clicking it opens the editor (wired to 4.4's PromptEditorModal).
    fireEvent.click(
      within(helperRow).getByRole('button', { name: 'edit prompt' }),
    );
    const dlg = await screen.findByRole('dialog', {
      name: 'my-helper prompt editor',
    });
    expect(within(dlg).getByLabelText('Prompt')).toBeTruthy();
  });

  it('standalone delete confirms by name, DELETEs once with the hash, reloads', async () => {
    const after = fixture(
      sampleAgents({
        mypl: { mode: 'primary', description: 'd', prompt: 'p' },
        'mypl-build': {
          mode: 'subagent',
          hidden: true,
          prompt: 'Build prompt.',
        },
        'mypl-review': {
          mode: 'subagent',
          hidden: true,
          prompt: 'Review prompt.',
        },
      }),
    );
    after.hash = 'hash-after-agent-delete';
    const { calls } = scriptApi({
      gets: [fixture(pipelineAgents()), after],
      pipelines: [PIPELINE_DEFS, PIPELINE_DEFS],
      agentDeletes: [okWrite('hash-after-agent-delete')],
    });
    await renderedPipelines();
    const helperRow = within(otherTable()).getByRole('row', {
      name: 'my-helper',
    });
    fireEvent.click(within(helperRow).getByRole('button', { name: 'delete' }));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Delete my-helper?',
    });
    expect(within(confirm).getByText(/backup/i)).toBeTruthy(); // SCW-4 promise
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Confirm delete' }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('alertdialog', { name: 'Delete my-helper?' }),
      ).toBeNull(),
    );
    const dels = calls.filter((c) => c.method === 'DELETE');
    expect(dels.length).toBe(1);
    expect(dels[0].url).toBe('/api/agents/my-helper');
    expect(dels[0].body).toEqual({ hash: 'hash-base-0001' });
  });
});

describe('Orchestration — default-agent picker offers visible primaries (AP-7)', () => {
  function defaultPicker(): HTMLSelectElement {
    return screen.getByRole('combobox', {
      name: 'Default agent',
    }) as HTMLSelectElement;
  }

  it('options exclude subagents/hidden roles; selecting PUTs gated, clears with sentinel', async () => {
    const { calls } = scriptApi({
      gets: [fixture(pipelineAgents())],
      pipelines: [PIPELINE_DEFS],
      defaults: [okWrite('echo-d1')],
    });
    await renderedPipelines();
    const values = optionValues(defaultPicker());
    // Orchestrators are selectable…
    expect(values).toContain('mypl');
    // …hidden role rows are not (loader throw set mirrored client-side).
    expect(values).not.toContain('mypl-build');
    expect(values).not.toContain('mypl-review');
    // Built-ins/standalone stay offered (visibility gate, not ownership).
    expect(values).toContain('gentle-orchestrator');
    expect(values).toContain('my-helper');
    fireEvent.change(defaultPicker(), { target: { value: 'mypl' } });
    await waitFor(() =>
      expect(
        calls.filter(
          (c) => c.method === 'PUT' && c.url === '/api/config/default-agent',
        ).length,
      ).toBe(1),
    );
    expect(
      calls.filter(
        (c) => c.method === 'PUT' && c.url === '/api/config/default-agent',
      )[0].body,
    ).toEqual({ hash: 'hash-base-0001', agent: 'mypl' });
    expect(screen.getByText('Restart OpenCode to apply')).toBeTruthy();
  });

  it('the clear option sends agent:null (unset ⇒ build-in fallback, C-R1d)', async () => {
    const { calls } = scriptApi({
      gets: [fixture(pipelineAgents())],
      pipelines: [PIPELINE_DEFS],
      defaults: [okWrite('echo-clear')],
    });
    await renderedPipelines();
    fireEvent.change(defaultPicker(), { target: { value: '__clear__' } });
    await waitFor(() =>
      expect(
        calls.filter(
          (c) => c.method === 'PUT' && c.url === '/api/config/default-agent',
        ).length,
      ).toBe(1),
    );
    expect(
      calls.filter(
        (c) => c.method === 'PUT' && c.url === '/api/config/default-agent',
      )[0].body,
    ).toEqual({ hash: 'hash-base-0001', agent: null });
  });
});

describe('Orchestration — pipeline create via the toggle closes once and re-reads (AC-9’, CX-3)', () => {
  it('builder submit through the header CTA: modal closes, one restart notice, both reads refresh', async () => {
    const after = fixture(pipelineAgents());
    after.hash = 'hash-post-create';
    const { calls } = scriptApi({
      gets: [fixture(sampleAgents()), after],
      pipelines: [{ pipelines: {} }, PIPELINE_DEFS],
      pipelineWrites: [okWrite('hash-post-create')],
    });
    await rendered();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
    const create = await screen.findByRole('dialog', { name: 'New agent' });
    fireEvent.click(within(create).getByRole('radio', { name: 'Pipeline' }));
    const builder = await screen.findByRole('dialog', {
      name: 'Pipeline builder',
    });
    await within(builder).findByText('Reviewer');
    fireEvent.change(within(builder).getByLabelText('Pipeline name'), {
      target: { value: 'mypl' },
    });
    fireEvent.change(
      within(builder).getByLabelText('Orchestrator description'),
      { target: { value: 'coordinate mypl' } },
    );
    const roleCard = within(builder).getByLabelText('Role 1');
    fireEvent.change(within(roleCard).getByLabelText('Role 1 name'), {
      target: { value: 'mypl-build' },
    });
    fireEvent.change(within(roleCard).getByLabelText('Role 1 description'), {
      target: { value: 'builds' },
    });
    fireEvent.change(within(roleCard).getByLabelText('Role 1 prompt'), {
      target: {
        value: '# Reviewer\nYou review code changes for correctness first.',
      },
    });
    fireEvent.click(
      within(builder).getByRole('button', { name: 'Create pipeline' }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Pipeline builder' }),
      ).toBeNull(),
    );
    // Exactly ONE restart notice (CX-3) after the batch persisted.
    expect(screen.getAllByText('Restart OpenCode to apply').length).toBe(1);
    // CONFIG + definitions both re-read (the group renders from the fresh defs).
    expect(
      calls.filter((c) => c.method === 'GET' && c.url === '/api/config').length,
    ).toBe(2);
    expect(
      calls.filter(
        (c) => c.method === 'GET' && c.url === '/api/agent-pipelines',
      ).length,
    ).toBe(2);
    expect(
      await screen.findByRole('table', { name: 'Pipeline mypl' }),
    ).toBeTruthy();
  });
});

describe('Orchestration — model assignments panel (WU-5, S1/S2/S4 integration)', () => {
  it('mounts the assignments section: knowledge rows for the 14 phases + read-only fallback for unknown slugs', async () => {
    scriptApi({
      gets: [
        fixture(
          sampleAgents({
            'sdd-custom-thing-deep': { model: 'nan/qwen3.6' },
          }),
        ),
      ],
    });
    await rendered();
    expect(screen.getByText('Model assignments')).toBeTruthy();
    const grid = screen.getByRole('table', { name: 'Assignments grid' });
    // Knowledge rows render for the catalog phases (S1 render leg).
    for (const slug of ['sdd-init', 'sdd-spec', 'jd-fix-agent']) {
      expect(within(grid).getByRole('row', { name: slug })).toBeTruthy();
    }
    // Unknown config slugs render the generic fallback READ-ONLY (S2/S19).
    const fallback = within(grid).getByRole('row', { name: 'custom-thing' });
    expect(within(fallback).getByText(/read-only/)).toBeTruthy();
    expect(screen.queryByLabelText('assign custom-thing (deep)')).toBeNull();
  });

  it('panel Apply shares the sync reload path: exit 0 → advisory cleared + exactly 2 CONFIG GETs (S4/S12)', async () => {
    const { calls } = scriptApi({
      syncs: [
        {
          status: 200,
          body: {
            ok: true,
            exitCode: 0,
            stdout: '',
            stderr: '',
            hash: 'hash-applied',
          },
        },
      ],
    });
    await rendered();
    fireEvent.change(screen.getByLabelText('assign sdd-spec (deep)'), {
      target: { value: 'nan/mimo-v2.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply assignments' }));
    expect(await screen.findByText('exit 0')).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.queryByText('run gentle-ai sync to refresh prompt table'),
      ).toBeNull(),
    );
    expect(
      calls.filter((c) => c.method === 'GET' && c.url === '/api/config'),
    ).toHaveLength(2);
  });
});

describe('Orchestration — gentle-ai-owned rows lose direct pickers (WU-4, S10/S11)', () => {
  it('EVERY isReserved row renders read-only model text, never an active picker (S10)', async () => {
    scriptApi();
    await rendered();
    // Representatives across the whole reserved surface: sdd-* matrix
    // families, orphan orchestrator variants, jd-*, review-*, and the three
    // exact reserved names (D1 — ALL isReserved rows, not just sdd-*).
    for (const name of [
      'sdd-spec',
      'sdd-spec-deep',
      'sdd-orchestrator-cheap',
      'sdd-orchestrator-deep',
      'jd-judge-a',
      'review-validator',
      'general',
      'explore',
      'gentle-orchestrator',
    ]) {
      expect(
        screen.queryByRole('combobox', { name: `${name} model` }),
      ).toBeNull();
    }
    // Declared models surface as read-only mono text (not an empty control).
    const specRow = within(matrixTable()).getByRole('row', {
      name: 'sdd-spec',
    });
    expect(within(specRow).getByText('nan/qwen3.8-flash')).toBeTruthy(); // the -deep cell's declared model
    const orchRow = within(otherTable()).getByRole('row', {
      name: 'sdd-orchestrator-deep',
    });
    expect(within(orchRow).getByText('nanSendvalu/glm5.3')).toBeTruthy();
    // Unset reserved rows read "runtime default".
    expect(
      within(
        within(matrixTable()).getByRole('row', { name: 'sdd-spec' }),
      ).getAllByText('runtime default').length,
    ).toBe(2); // base + cheap cells
  });

  it('a user-owned row keeps its working picker → setModel → PUT (S11)', async () => {
    const { calls } = scriptApi({
      gets: [
        fixture(sampleAgents({ 'my-helper': { description: 'standalone' } })),
      ],
      puts: [okWrite('echo-owned')],
    });
    await rendered();
    setModel('my-helper', 'nan/qwen3.6');
    expect(screen.getByText('1 change')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Restart OpenCode to apply');
    const put = writes(calls)[0];
    expect(put.url).toBe('/api/agents/my-helper/model');
    expect(put.body).toEqual({ hash: 'hash-base-0001', model: 'nan/qwen3.6' });
    expect(picker('my-helper').value).toBe('nan/qwen3.6');
  });
});

describe('client-ownership — parity with the server authority (AP-6/AC-3)', () => {
  it('the web predicate copy lists exactly the same reserved surface', () => {
    expect([...CLIENT_PREFIXES].sort()).toEqual([...RESERVED_PREFIXES].sort());
    expect([...CLIENT_EXACT].sort()).toEqual([...RESERVED_EXACT].sort());
  });
});

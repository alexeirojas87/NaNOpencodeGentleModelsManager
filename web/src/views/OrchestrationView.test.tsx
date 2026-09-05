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
  } = {},
) {
  const calls: Call[] = [];
  const gets = [...(opts.gets ?? [fixture(sampleAgents())])];
  const puts = [...(opts.puts ?? [])];
  const syncs = [...(opts.syncs ?? [])];
  const templates = [...(opts.templates ?? [TEMPLATES_REPLY])];
  const prompts = [...(opts.prompts ?? [])];
  const creates = [...(opts.creates ?? [])];
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
  it('renders the base/-cheap/-deep matrix as exactly 30 cells', async () => {
    scriptApi();
    await rendered();
    const matrix = within(matrixTable());
    // 10 families × 3 columns = 30 pickers; header + 10 rows.
    expect(matrix.getAllByRole('combobox').length).toBe(30);
    expect(matrix.getAllByRole('row').length).toBe(11);
    const specRow = matrix.getByRole('row', { name: 'sdd-spec' });
    expect(
      within(specRow).getByRole('combobox', { name: 'sdd-spec-cheap model' }),
    ).toBeTruthy();
    expect(
      within(specRow).getByRole('combobox', { name: 'sdd-spec-deep model' }),
    ).toBeTruthy();
  });

  it('lists the 14 non-phase agents, including orphan -cheap/-deep variants', async () => {
    scriptApi();
    await rendered();
    const others = within(otherTable());
    // header + 14 rows; every row is an agent, every agent gets a picker.
    expect(others.getAllByRole('row').length).toBe(15);
    expect(others.getAllByRole('combobox').length).toBe(14);
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
    expect(picker('review-doc-integrity')).toBeTruthy();
    // Still 30 matrix cells — the lone agent cannot form a family row.
    expect(within(matrixTable()).getAllByRole('combobox').length).toBe(30);
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
    // base + cheap cells are pickers; the -deep cell has no agent behind it.
    expect(matrix.getAllByRole('combobox').length).toBe(32);
    const row = matrix.getByRole('row', { name: 'quantum-phase' });
    expect(within(row).getByText('agent absent')).toBeTruthy();
    expect(
      screen.queryByRole('combobox', { name: 'quantum-phase-deep model' }),
    ).toBeNull();
  });

  it('shows "runtime default" for unset agents and the pair for the 4 explicit ones', async () => {
    scriptApi();
    await rendered();
    expect(picker('sdd-spec').value).toBe('');
    expect(selectedText(picker('sdd-spec'))).toBe('runtime default');
    expect(picker('sdd-spec-deep').value).toBe('nan/qwen3.8-flash');
    expect(picker('sdd-tasks-deep').value).toBe('nan/qwen3.8-flash');
    expect(picker('sdd-orchestrator-cheap').value).toBe('nan/qwen3.8-flash');
    expect(picker('sdd-orchestrator-deep').value).toBe('nanSendvalu/glm5.3');
    // Exactly the 4 fixture agents are explicit; all 40 others default.
    const all = screen.getAllByRole('combobox');
    expect(
      all.filter((p) => (p as HTMLSelectElement).value !== '').length,
    ).toBe(4);
  });
});

describe('Orchestration — pickers are limited to the installed catalog (OA-2)', () => {
  it('offers only provider/model pairs present in the config response', async () => {
    scriptApi();
    await rendered();
    for (const name of ['sdd-spec', 'sdd-apply-cheap', 'gentle-orchestrator']) {
      expect(optionValues(picker(name))).toEqual(['', ...INSTALLED_PAIRS]);
    }
    // headroom declares ZERO models → no headroom option anywhere;
    // uninstalled pairs are simply not offered.
    for (const p of screen.getAllByRole('combobox')) {
      const values = optionValues(p as HTMLSelectElement);
      expect(values.some((v) => v.startsWith('headroom/'))).toBe(false);
      expect(values).not.toContain('nan/not-installed');
    }
  });

  it('keeps a declared model that is no longer installed visible', async () => {
    scriptApi({
      gets: [
        fixture(
          sampleAgents({
            'sdd-propose-deep': { model: 'ghostly/missing-1' },
          }),
        ),
      ],
    });
    await rendered();
    const stale = picker('sdd-propose-deep');
    expect(stale.value).toBe('ghostly/missing-1');
    // It is displayed for THIS agent without leaking into other pickers.
    expect(optionValues(stale)).toEqual([
      '',
      'ghostly/missing-1',
      ...INSTALLED_PAIRS,
    ]);
    expect(optionValues(picker('sdd-spec'))).toEqual(['', ...INSTALLED_PAIRS]);
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
    // Every picker is still a model combobox; the table itself has no editors.
    expect(screen.queryAllByRole('textbox').length).toBe(0);
    expect(document.querySelectorAll('textarea').length).toBe(0);
    for (const p of screen.getAllByRole('combobox')) {
      expect(String(p.getAttribute('aria-label'))).toMatch(/ model$/);
    }
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
    const { calls } = scriptApi({
      puts: [okWrite('echo-A'), okWrite('echo-B')],
    });
    await rendered();
    setModel('sdd-spec', 'nan/qwen3.6');
    setModel('gentle-orchestrator', 'nan/mimo-v2.5');
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
  it('sets a model, chains the echoed hash, and advises running gentle-ai sync', async () => {
    const { calls } = scriptApi({ puts: [okWrite('echo-A')] });
    await rendered();
    setModel('sdd-spec', 'nan/qwen3.6');
    expect(screen.getByText('1 change')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // CX-3 restart notice + the OA-3 advisory (text only — sync ships WU9).
    await screen.findByText('Restart OpenCode to apply');
    expect(
      screen.getByText(/run gentle-ai sync to refresh prompt table/),
    ).toBeTruthy();
    const put = writes(calls)[0];
    expect(put.url).toBe('/api/agents/sdd-spec/model');
    expect(put.body).toEqual({ hash: 'hash-base-0001', model: 'nan/qwen3.6' });
    expect(picker('sdd-spec').value).toBe('nan/qwen3.6');
    expect(screen.getByText('No changes')).toBeTruthy();
  });

  it('clearing an assignment PUTs null and the row falls back to runtime default', async () => {
    const { calls } = scriptApi({ puts: [okWrite('echo-X')] });
    await rendered();
    expect(picker('sdd-spec-deep').value).toBe('nan/qwen3.8-flash');
    setModel('sdd-spec-deep', '');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Restart OpenCode to apply');
    expect(writes(calls)[0].body).toEqual({
      hash: 'hash-base-0001',
      model: null,
    });
    expect(picker('sdd-spec-deep').value).toBe('');
    expect(selectedText(picker('sdd-spec-deep'))).toBe('runtime default');
  });

  it('flushes multiple agent edits sequentially, chaining every echoed hash', async () => {
    const { calls } = scriptApi({
      puts: [okWrite('echo-A'), okWrite('echo-B')],
    });
    await rendered();
    setModel('sdd-spec', 'nan/mimo-v2.5');
    setModel('general', 'nan/qwen3.6');
    expect(screen.getByText('2 changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Restart OpenCode to apply');
    const w = writes(calls);
    expect(w.length).toBe(2);
    expect(w[0].url).toBe('/api/agents/sdd-spec/model');
    expect(w[0].body).toEqual({
      hash: 'hash-base-0001',
      model: 'nan/mimo-v2.5',
    });
    expect(w[1].url).toBe('/api/agents/general/model');
    expect(w[1].body).toEqual({ hash: 'echo-A', model: 'nan/qwen3.6' });
    expect(picker('general').value).toBe('nan/qwen3.6');
  });

  it('discarding pending picker changes restores the loaded values', async () => {
    const { calls } = scriptApi();
    await rendered();
    setModel('sdd-spec', 'nan/qwen3.6');
    setModel('sdd-spec-deep', '');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByText('No changes')).toBeTruthy();
    expect(picker('sdd-spec').value).toBe('');
    expect(picker('sdd-spec-deep').value).toBe('nan/qwen3.8-flash');
    expect(writes(calls).length).toBe(0);
  });
});

describe('Orchestration — conflict and validation reuse the established flows (SCW-2, SCW-3)', () => {
  it('409 opens the conflict diff; Reload fresh keeps the edit re-appliable on the new hash', async () => {
    const fresh = fixture(
      sampleAgents({
        'sdd-spec': { description: 'synthetic', model: 'nan/qwen3.8-flash' },
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
      gets: [fixture(sampleAgents()), fresh],
      puts: [stale, okWrite('echo-F')],
    });
    await rendered();
    setModel('sdd-spec', 'nan/qwen3.6');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Config conflict',
    });
    expect(within(dialog).getByText('agent.sdd-spec.model')).toBeTruthy();
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
    const fresh = fixture(sampleAgents());
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
      gets: [fixture(sampleAgents()), fresh],
      puts: [stale, okWrite('echo-W')],
    });
    await rendered();
    setModel('sdd-verify-cheap', 'nan/qwen3.6');
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
    expect(picker('sdd-verify-cheap').value).toBe('nan/qwen3.6');
  });

  it('400 renders per-path issues in the save bar and keeps pending edits', async () => {
    const { calls } = scriptApi({
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
                  path: 'agent.sdd-spec.model',
                  message: 'expected a "provider/model" string',
                },
              ],
            },
          },
        },
      ],
    });
    await rendered();
    setModel('sdd-spec', 'nan/qwen3.6');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/agent\.sdd-spec\.model: expected a/),
    ).toBeTruthy();
    // Pending edits survive; no success state, no advisory.
    expect(picker('sdd-spec').value).toBe('nan/qwen3.6');
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
    expect(within(matrixTable()).getAllByRole('combobox').length).toBe(30);
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
    // re-read CONFIG: GET /api/config ran exactly twice.
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
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
    // Still the single initial GET — nothing re-baselined on failure.
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
  });

  it('a successful sync clears the OA-3 "run gentle-ai sync" advisory it answers', async () => {
    const { calls } = scriptApi({
      puts: [okWrite('echo-A')],
      syncs: [syncReply(0, { hash: 'echo-A' })],
    });
    await rendered();
    // A saved model edit raises the advisory (WU8 flow, intact).
    setModel('sdd-spec', 'nan/qwen3.6');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Restart OpenCode to apply');
    expect(
      screen.getByText('run gentle-ai sync to refresh prompt table'),
    ).toBeTruthy();

    // Running the sync from the panel IS that advice; it clears once done.
    fireEvent.click(screen.getByRole('button', { name: 'Run sync' }));
    expect(await screen.findByText('exit 0')).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.queryByText('run gentle-ai sync to refresh prompt table'),
      ).toBeNull(),
    );
    // And the list refresh re-anchored the view on the fresh CONFIG (2 GETs).
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });
});

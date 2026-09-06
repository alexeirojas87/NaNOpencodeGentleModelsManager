// WU-3 (RED) — component tests for the AssignmentsPanel + CapabilityChip
// (spec #548 capabilities native-model-assignment / sync-result-surfacing /
// capability-warnings; design #549 §Testing Strategy "scriptApi + syncs
// queue" pattern). Scripted fetch only — no live network, no real
// gentle-ai. The panel contract:
//   grid     14 catalog phases × {cheap, deep} installed-pairs selects,
//            catalog-bound (unknown slugs render read-only fallback rows),
//            set-only (no clear/un-assign anywhere), knowledge columns via
//            knowledgeFor, advisory capability chips that never block;
//   apply    diffs selections vs declared agent.*.model → composeAssignmentArgs
//            → ONE POST /api/sync (D5 batch verdict) with EXACT repeated
//            --profile-phase / --profile args, no secrets in the body;
//   outcome  success ONLY on exit 0 (chip + onSynced once); non-zero exit
//            renders stdout/stderr as <pre> TEXT children (XSS-safe) with a
//            failure chip and NO reload; a 400 sync_bad_args envelope
//            renders its message with NO reload; busy disables ALL controls.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConfigResponse } from '../../../../shared/types';
import { AssignmentsPanel } from './AssignmentsPanel';
import { capabilityWarning } from './CapabilityChip';
import { PHASE_IDS } from './phaseKnowledge';

/** Installed catalog = provider ids × declared model ids (the ONLY source). */
const PAIRS = [
  'nan/qwen3.8-flash',
  'nan/qwen3.6',
  'nan/mimo-v2.5',
  'nan/vision-only',
  'nanSendvalu/glm5.3',
];

function panelAgents(extra?: Record<string, { model?: string }>) {
  return {
    'sdd-spec': { description: 'd' },
    'sdd-spec-deep': { model: 'nan/qwen3.6' }, // declared text-only → chip on load (3.4)
    'sdd-orchestrator-cheap': { model: 'nan/qwen3.6' },
    'sdd-orchestrator-deep': { model: 'nanSendvalu/glm5.3' },
    ...extra,
  };
}

function panelBase(extra?: Record<string, { model?: string }>): ConfigResponse {
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
            reasoning: true,
            tool_call: true,
          },
          'qwen3.6': {
            name: 'Qwen 3.6',
            contextWindow: 262144,
            reasoning: false,
            tool_call: false,
          },
          'mimo-v2.5': { name: 'MiMo v2.5' }, // capability flags absent (D10)
          'vision-only': {
            name: 'Vision Only',
            modalities: { input: ['image'] }, // C1: declared modalities lack text
          },
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
        models: {
          'glm5.3': {
            name: 'GLM 5.3',
            contextWindow: 1000000,
            reasoning: true,
            tool_call: true,
          },
        },
      },
    },
    agents: panelAgents(extra) as ConfigResponse['agents'],
    authJson: { exists: [] },
    snapshotAsOf: '2026-09-05',
  };
}

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/** Scripted fetch: POST /api/sync consumes the queue (fails loud when dry). */
function scriptApi(
  opts: {
    syncs?: { status: number; body: unknown }[];
    gate?: Promise<void>;
  } = {},
) {
  const calls: Call[] = [];
  const syncs = [...(opts.syncs ?? [])];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({
        method,
        url,
        body: init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : undefined,
      });
      if (method === 'POST' && url === '/api/sync') {
        if (opts.gate) await opts.gate;
        const reply = syncs.shift();
        if (!reply) throw new Error('sync script exhausted');
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

function renderPanel(base = panelBase()) {
  const onSynced = vi.fn();
  render(<AssignmentsPanel base={base} onSynced={onSynced} />);
  return { onSynced };
}

function cell(phase: string, profile: string): HTMLSelectElement {
  return screen.getByLabelText(
    `assign ${phase} (${profile})`,
  ) as HTMLSelectElement;
}

function choose(phase: string, profile: string, value: string) {
  fireEvent.change(cell(phase, profile), { target: { value } });
}

function applyButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Apply assignments' });
}

function cellContainer(select: HTMLSelectElement): HTMLElement {
  const container = select.closest('td');
  if (!container) throw new Error('select is not inside a cell');
  return container;
}

function optionValues(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((o) => o.value);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AssignmentsPanel — grid rules (S4, S7, S18, S19, S1/S2 render)', () => {
  it('renders exactly the 14 catalog phase rows with knowledge columns', () => {
    renderPanel();
    const grid = screen.getByRole('table', { name: 'Assignments grid' });
    const rows = within(grid).getAllByRole('row');
    expect(rows).toHaveLength(15); // header + 14 catalog phases
    for (const slug of PHASE_IDS) {
      expect(within(grid).getByRole('row', { name: slug })).toBeTruthy();
    }
    // Knowledge columns render via knowledgeFor: purpose, load, needs chips.
    const design = within(grid).getByRole('row', { name: 'sdd-design' });
    expect(
      within(design).getByText(/technical design and threat matrix/),
    ).toBeTruthy();
    expect(within(design).getByText('high')).toBeTruthy();
    expect(within(design).getByText('reasoning')).toBeTruthy();
    expect(within(design).getByText('tools')).toBeTruthy();
  });

  it('every cell offers ONLY installed pairs (S7) — uninstalled ids are not offered', () => {
    renderPanel();
    expect(optionValues(cell('sdd-apply', 'deep'))).toEqual(['', ...PAIRS]);
    expect(optionValues(cell('jd-judge-a', 'cheap'))).toEqual(['', ...PAIRS]);
    for (const select of screen.getAllByRole('combobox')) {
      expect(optionValues(select as HTMLSelectElement)).not.toContain(
        'headroom/anything',
      );
      expect(optionValues(select as HTMLSelectElement)).not.toContain(
        'nan/not-installed',
      );
    }
  });

  it('is set-only: assigned cells have no un-assign option and no clear control exists (S18)', () => {
    renderPanel();
    // Declared cell: the "not assigned" placeholder is gone — no way back.
    expect(optionValues(cell('sdd-spec', 'deep'))).toEqual(PAIRS);
    expect(
      screen
        .getAllByRole('option')
        .some(
          (o) =>
            o.textContent === 'not assigned' &&
            (o as HTMLOptionElement).value === '',
        ),
    ).toBe(true); // exists only on UNASSIGNED cells
    expect(
      screen
        .getAllByRole('option')
        .filter((o) => (o as HTMLOptionElement).value === '')
        .every((o) => o.textContent === 'not assigned'),
    ).toBe(true);
    // No clear/un-assign action anywhere in the panel.
    expect(screen.queryByText(/clear/i)).toBeNull();
    expect(screen.queryByText(/unassign/i)).toBeNull();
  });

  it('unknown slugs get a read-only fallback row with NO assignment control (S19, S2)', () => {
    renderPanel(
      panelBase({ 'sdd-custom-thing-deep': { model: 'nan/qwen3.6' } }),
    );
    const grid = screen.getByRole('table', { name: 'Assignments grid' });
    expect(within(grid).getAllByRole('row')).toHaveLength(16); // header + 14 + fallback
    const row = within(grid).getByRole('row', { name: 'custom-thing' });
    expect(
      within(row).getByText(/Uncatalogued phase — no validated knowledge/),
    ).toBeTruthy();
    expect(within(row).getByText(/read-only/)).toBeTruthy();
    expect(screen.queryByLabelText('assign custom-thing (deep)')).toBeNull();
  });

  it('orchestrator rows compose via --profile and show their declared model', () => {
    renderPanel();
    expect(cell('sdd-orchestrator', 'deep').value).toBe('nanSendvalu/glm5.3');
    expect(cell('sdd-orchestrator', 'cheap').value).toBe('nan/qwen3.6');
  });
});

describe('AssignmentsPanel — batch apply (S5, S6, S8)', () => {
  it('three changed pairs → ONE POST whose body.args EXACTLY match the composer (S8)', async () => {
    const { calls } = scriptApi({ syncs: [syncOk(0)] });
    const { onSynced } = renderPanel();
    choose('sdd-tasks', 'deep', 'nan/qwen3.8-flash');
    choose('jd-judge-a', 'deep', 'nanSendvalu/glm5.3');
    choose('sdd-apply', 'cheap', 'nan/qwen3.6');
    fireEvent.click(applyButton());
    expect(await screen.findByText('exit 0')).toBeTruthy();

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('/api/sync');
    expect(calls[0].body).toEqual({
      args: [
        '--profile-phase',
        'deep:sdd-tasks:nan/qwen3.8-flash',
        '--profile-phase',
        'deep:jd-judge-a:nanSendvalu/glm5.3',
        '--profile-phase',
        'cheap:sdd-apply:nan/qwen3.6',
      ],
    });
    // No secrets or hashes ride the body — args are provider/model pairs only.
    expect(JSON.stringify(calls[0].body)).not.toContain('apiKey');
    expect(JSON.stringify(calls[0].body)).not.toContain('hash');
    expect(onSynced).toHaveBeenCalledTimes(1);
  });

  it('an orchestrator change composes the --profile flag (S5)', async () => {
    const { calls } = scriptApi({ syncs: [syncOk(0)] });
    renderPanel();
    choose('sdd-orchestrator', 'deep', 'nan/qwen3.8-flash');
    fireEvent.click(applyButton());
    expect(await screen.findByText('exit 0')).toBeTruthy();
    expect(calls[0].body).toEqual({
      args: ['--profile', 'deep:nan/qwen3.8-flash'],
    });
  });

  it('declared-but-unchanged cells emit nothing; no changes keeps Apply disabled (S8 diff)', () => {
    const { calls } = scriptApi({ syncs: [] });
    renderPanel();
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(applyButton());
    expect(calls).toHaveLength(0);
  });
});

describe('AssignmentsPanel — outcome semantics (S12, S13, S14, S15)', () => {
  it('exit 0 → success chip + note, onSynced exactly once (S12)', async () => {
    scriptApi({ syncs: [syncOk(0)] });
    const { onSynced } = renderPanel();
    choose('sdd-spec', 'deep', 'nan/qwen3.8-flash');
    fireEvent.click(applyButton());
    expect(await screen.findByText('exit 0')).toBeTruthy();
    expect(
      screen.getByText(/Assignments applied — CONFIG reloaded/),
    ).toBeTruthy();
    expect(onSynced).toHaveBeenCalledTimes(1);
  });

  it('non-zero exit → failure chip + stdout/stderr as <pre> text, NO reload (S13)', async () => {
    scriptApi({
      syncs: [
        syncOk(4, {
          stdout: 'gentle-ai sync: starting\n',
          stderr: 'gentle-ai sync: profile store locked\n',
        }),
      ],
    });
    const { onSynced } = renderPanel();
    choose('sdd-spec', 'deep', 'nan/qwen3.8-flash');
    fireEvent.click(applyButton());
    expect(await screen.findByText('exit 4')).toBeTruthy();
    expect(screen.getByText(/profile store locked/)).toBeTruthy();
    expect(screen.getByText(/gentle-ai sync: starting/)).toBeTruthy();
    const preText = [...document.querySelectorAll('pre')]
      .map((p) => p.textContent)
      .join('\n');
    expect(preText).toContain('profile store locked');
    expect(screen.queryByText(/Assignments applied/)).toBeNull();
    expect(onSynced).not.toHaveBeenCalled();
  });

  it('stdout carrying markup renders as inert text — XSS-safe (threat row)', async () => {
    const evil = `<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">`;
    scriptApi({ syncs: [syncOk(1, { stdout: evil })] });
    renderPanel();
    choose('sdd-spec', 'deep', 'nan/qwen3.8-flash');
    fireEvent.click(applyButton());
    expect(await screen.findByText('exit 1')).toBeTruthy();
    // The payload is visible as literal text…
    expect(screen.getByText(evil)).toBeTruthy();
    // …and NOTHING executed: zero script/img nodes, window untouched.
    expect(document.querySelectorAll('script').length).toBe(0);
    expect(document.querySelectorAll('img').length).toBe(0);
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('a 400 sync_bad_args envelope renders its message and never reloads (S14)', async () => {
    scriptApi({
      syncs: [
        {
          status: 400,
          body: {
            ok: false,
            error: {
              code: 'sync_bad_args',
              message: 'Value for --profile-phase must match name:phase:model.',
            },
          },
        },
      ],
    });
    const { onSynced } = renderPanel();
    choose('sdd-spec', 'deep', 'nan/qwen3.8-flash');
    fireEvent.click(applyButton());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('sync_bad_args');
    expect(alert.textContent).toContain('must match name:phase:model');
    expect(screen.queryByText(/^exit /)).toBeNull();
    expect(onSynced).not.toHaveBeenCalled();
  });

  it('busy disables ALL controls until completion, then re-enables (S15)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    scriptApi({ syncs: [syncOk(0)], gate });
    renderPanel();
    choose('sdd-spec', 'deep', 'nan/qwen3.8-flash');
    fireEvent.click(applyButton());
    // While the sync runs: every select and the Apply button are disabled.
    for (const select of screen.getAllByRole('combobox')) {
      expect((select as HTMLSelectElement).disabled).toBe(true);
    }
    expect(applyButton().disabled).toBe(true);
    release();
    expect(await screen.findByText('exit 0')).toBeTruthy();
    for (const select of screen.getAllByRole('combobox')) {
      expect((select as HTMLSelectElement).disabled).toBe(false);
    }
  });
});

describe('AssignmentsPanel — advisory capability chips (S16, S17; C1 modalities)', () => {
  it('a text-only model on a tool-needing phase shows a chip; Apply stays enabled (S16)', () => {
    renderPanel();
    choose('sdd-apply', 'deep', 'nan/qwen3.6'); // tool_call: false
    const chip = within(cellContainer(cell('sdd-apply', 'deep'))).getByText(
      /no tool support/,
    );
    expect(chip).toBeTruthy();
    expect(applyButton().disabled).toBe(false);
  });

  it('a tool-capable model on a tool-needing phase shows no chip (S17)', () => {
    renderPanel();
    choose('sdd-apply', 'deep', 'nan/qwen3.8-flash');
    expect(
      within(cellContainer(cell('sdd-apply', 'deep'))).queryByText(
        /no tool support/,
      ),
    ).toBeNull();
  });

  it('missing capability flags yield no chip (D10)', () => {
    renderPanel();
    choose('sdd-verify', 'deep', 'nan/mimo-v2.5'); // flags absent
    expect(
      within(cellContainer(cell('sdd-verify', 'deep'))).queryByText(
        /no tool support/,
      ),
    ).toBeNull();
  });

  it('a DECLARED mismatching model is warned without any selection (S16 on load)', () => {
    renderPanel(); // sdd-spec-deep declares nan/qwen3.6 (tool_call: false)
    expect(
      within(cellContainer(cell('sdd-spec', 'deep'))).getByText(
        /no tool support/,
      ),
    ).toBeTruthy();
  });

  it('declared modalities lacking text warn on any assignment (C1)', () => {
    renderPanel();
    choose('sdd-init', 'cheap', 'nan/vision-only'); // modalities.input = ['image']
    expect(
      within(cellContainer(cell('sdd-init', 'cheap'))).getByText(
        /no text input modality/,
      ),
    ).toBeTruthy();
  });

  it('big-context phases warn on a small declared context window', () => {
    renderPanel();
    choose('sdd-explore', 'deep', 'nan/qwen3.6'); // 262144 < 1M big-context bar
    expect(
      within(cellContainer(cell('sdd-explore', 'deep'))).getByText(
        /small context window/,
      ),
    ).toBeTruthy();
    choose('sdd-explore', 'deep', 'nan/qwen3.8-flash'); // 1M
    expect(
      within(cellContainer(cell('sdd-explore', 'deep'))).queryByText(
        /small context window/,
      ),
    ).toBeNull();
  });
});

describe('capabilityWarning — pure helper (unit layer)', () => {
  const toolPhase = ['tools'] as const;

  it('returns null when the model config is absent (missing flags → no chip)', () => {
    expect(capabilityWarning(undefined, [...toolPhase])).toBeNull();
  });

  it('flags tool_call:false against a tools phase', () => {
    expect(capabilityWarning({ tool_call: false }, [...toolPhase])).toContain(
      'no tool support',
    );
  });

  it('returns null for a compatible model', () => {
    expect(capabilityWarning({ tool_call: true }, [...toolPhase])).toBeNull();
  });

  it('combines multiple mismatches into one advisory string', () => {
    expect(
      capabilityWarning({ reasoning: false, tool_call: false }, [
        'reasoning',
        'tools',
      ]),
    ).toContain('no reasoning');
  });

  it('declared modalities lacking text always warn, needs or not', () => {
    expect(
      capabilityWarning({ modalities: { input: ['image'] } }, []),
    ).toContain('no text input modality');
  });
});

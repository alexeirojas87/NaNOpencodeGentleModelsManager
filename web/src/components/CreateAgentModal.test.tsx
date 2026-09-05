// orchestration-v2 WU-B 2.1 (RED) — component tests for the New agent modal
// (spec AC-9, AT-2/AT-3, design D5/D9/D10; threat RED: stored XSS).
// Binding surface: template picker + clone materialization prefill the D5
// read-only preview (no prompt textarea, ever); 400s route to the offending
// field (D9: name/prompt/model); 409 rides the established ConflictModal with
// exactly one `(new agent)` diff row; the XSS prompt renders as a text node
// with zero executed nodes. Every fetch is scripted (WU6–WU10 pattern).
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
import { CreateAgentModal } from './CreateAgentModal';

/** The exact attack payload (threat matrix: stored XSS, reader/preview). */
const XSS = `<script>alert('xss')</script>`;

const SCRIPT_TEXT = { name: 'evil-xss', source: 'inline', prompt: XSS };

function agents(
  extra?: Record<string, AgentConfigEntry>,
): Record<string, AgentConfigEntry> {
  return {
    'sdd-spec': {
      description: 'd',
      prompt: '{file:./prompts/sdd/sdd-spec.md}',
    },
    explore: { description: 'd', prompt: 'Explore prompt body — synthetic.' },
    'evil-xss': { prompt: XSS },
    'ghost-model': { model: 'ghostly/missing-1', prompt: 'Ghost holder.' },
    huge: { description: 'd', prompt: '{file:./prompts/huge.md}' },
    'no-prompt': { description: 'd' },
    ...extra,
  };
}

function fixture(over?: Partial<ConfigResponse>): ConfigResponse {
  return {
    hash: 'hash-base-0001',
    mtime: 1756000000000,
    providers: {
      nan: { name: 'NaN', models: { 'qwen3.8-flash': {}, 'qwen3.6': {} } },
      headroom: { name: 'Headroom', models: {} },
    },
    agents: agents(),
    authJson: { exists: [] },
    snapshotAsOf: '2026-09-04',
    ...over,
  };
}

/** The AT-1 shape: exactly the 4 bundled presets (server asset tested WU-A). */
const TEMPLATES = {
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
};

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}
type Reply = { status: number; body: unknown };

/**
 * Scripted fetch: queues per endpoint, fail-loud when exhausted so a stray
 * request can never pass unnoticed (sticky-last for GET /api/config).
 */
function scriptApi(
  opts: {
    gets?: ConfigResponse[];
    templates?: Reply[];
    prompts?: Reply[];
    creates?: Reply[];
  } = {},
) {
  const calls: Call[] = [];
  const gets = [...(opts.gets ?? [fixture()])];
  const templates = [...(opts.templates ?? [{ status: 200, body: TEMPLATES }])];
  const prompts = [...(opts.prompts ?? [])];
  const creates = [...(opts.creates ?? [])];
  vi.stubGlobal(
    'alert',
    vi.fn(() => true),
  );
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
      if (method === 'GET' && url === '/api/templates') {
        const reply = templates.shift();
        if (!reply) throw new Error('GET /api/templates script exhausted');
        return json(200, reply.body);
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
      throw new Error(`unexpected ${method} ${url}`);
    }),
  );
  return { calls };
}

const okCreate = (hash: string): Reply => ({
  status: 200,
  body: { ok: true, hash },
});
const err400 = (code: string, message: string): Reply => ({
  status: 400,
  body: { ok: false, error: { code, message } },
});

function renderModal(
  props: Partial<Parameters<typeof CreateAgentModal>[0]> = {},
) {
  const onCreated = vi.fn();
  const onAdoptFresh = vi.fn();
  const onClose = vi.fn();
  render(
    <CreateAgentModal
      base={fixture()}
      onClose={onClose}
      onCreated={onCreated}
      onAdoptFresh={onAdoptFresh}
      {...props}
    />,
  );
  return { onCreated, onAdoptFresh, onClose };
}

async function opened(
  props: Partial<Parameters<typeof CreateAgentModal>[0]> = {},
) {
  const api = renderModal(props);
  const dlg = await screen.findByRole('dialog', { name: 'New agent' });
  // Presets arrived (AT-1) before any selection is scripted.
  await within(dlg).findByText('Reviewer');
  return { ...api, dlg };
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'New agent' });
}
function sourceSelect(): HTMLSelectElement {
  return within(dialog()).getByLabelText('Prompt source') as HTMLSelectElement;
}
function modelSelect(): HTMLSelectElement {
  return within(dialog()).getByLabelText('Model') as HTMLSelectElement;
}
function setName(value: string) {
  fireEvent.change(within(dialog()).getByLabelText('Name'), {
    target: { value },
  });
}
function pickTemplate(id: string) {
  fireEvent.change(sourceSelect(), { target: { value: `template:${id}` } });
}
function pickClone(name: string) {
  fireEvent.change(sourceSelect(), { target: { value: `clone:${name}` } });
}
function submit() {
  fireEvent.click(within(dialog()).getByRole('button', { name: 'Create' }));
}
/** The `.field` wrapper a D9-routed error must live inside. */
function fieldOf(label: string): HTMLElement {
  const input = within(dialog()).getByLabelText(label);
  return (input.closest('.field') ?? dialog()) as HTMLElement;
}
function promptArea(): HTMLElement {
  return within(dialog()).getByLabelText('Prompt preview');
}
const creates = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CreateAgentModal — form shape (AC-9, D5)', () => {
  it('renders name/description/model/source + read-only preview, no textarea', async () => {
    scriptApi();
    await opened();
    for (const label of ['Name', 'Description', 'Model', 'Prompt source']) {
      expect(within(dialog()).getByLabelText(label)).toBeTruthy();
    }
    // D5: the preview is a labeled read-only region; the form ships no editor.
    expect(promptArea()).toBeTruthy();
    expect(within(dialog()).getByText(/not editable/i)).toBeTruthy();
    expect(document.querySelectorAll('textarea').length).toBe(0);
    // Source options: the 4 templates (AT-1) + one clone entry per agent.
    const values = Array.from(sourceSelect().options).map((o) => o.value);
    expect(values).toEqual([
      '',
      'template:reviewer',
      'template:executor',
      'template:orchestrator',
      'template:blank',
      ...Object.keys(agents()).map((name) => `clone:${name}`),
    ]);
    // Create stays disabled until name + prompt exist.
    expect(submitButton().disabled).toBe(true);
  });
});

function submitButton(): HTMLButtonElement {
  return within(dialog()).getByRole('button', {
    name: 'Create',
  }) as HTMLButtonElement;
}

describe('CreateAgentModal — template prefill and clone materialization (AT-1/AT-2)', () => {
  it('a template selection prefills the read-only preview with the preset body', async () => {
    scriptApi();
    await opened();
    pickTemplate('reviewer');
    expect(
      within(promptArea()).getByText(
        'You review code changes for correctness first.',
        { exact: false },
      ),
    ).toBeTruthy();
  });

  it('cloning a {file:} agent materializes the text and POSTs it inline (AT-2)', async () => {
    const materialized = '# Spec\nMATERIALIZED SPEC TEXT\nsecond line';
    const { calls } = scriptApi({
      prompts: [
        {
          status: 200,
          body: {
            name: 'sdd-spec',
            source: 'file',
            ref: './prompts/sdd/sdd-spec.md',
            prompt: materialized,
          },
        },
      ],
      creates: [okCreate('echo-9')],
    });
    const { onCreated } = await opened();
    pickClone('sdd-spec');
    await within(promptArea()).findByText(/MATERIALIZED SPEC TEXT/);
    setName('my-spec-derivative');
    fireEvent.change(within(dialog()).getByLabelText('Description'), {
      target: { value: 'a derivative' },
    });
    submit();
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('echo-9'));
    const post = creates(calls)[0];
    expect(post.body).toEqual({
      hash: 'hash-base-0001',
      name: 'my-spec-derivative',
      agent: { description: 'a derivative', prompt: materialized },
    });
    // The create body carries only materialized literal text (AT-2).
    expect(JSON.stringify(post.body)).not.toContain('{file:');
    expect(onCreated).toHaveBeenCalledWith('echo-9');
  });
});

describe('CreateAgentModal — stored XSS threat RED (design threat matrix)', () => {
  it('an evil prompt renders as a text node; zero script nodes, zero executed', async () => {
    scriptApi({ prompts: [{ status: 200, body: SCRIPT_TEXT }] });
    await opened();
    pickClone('evil-xss');
    await waitFor(() =>
      expect(within(promptArea()).getByText(XSS)).toBeTruthy(),
    );
    // Nothing in the document is an actual <script> node and alert never ran.
    expect(document.querySelectorAll('script').length).toBe(0);
    expect(promptArea().textContent).toContain(XSS);
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
  });
});

describe('CreateAgentModal — D9 400-field routing', () => {
  it('reserved_name lands on the Name field with the form data kept', async () => {
    scriptApi({
      creates: [
        err400(
          'reserved_name',
          'Agent name "sdd-mine" is owned by gentle-ai sync — a next sync would silently deep-merge over it.',
        ),
      ],
    });
    await opened();
    setName('sdd-mine');
    pickTemplate('executor');
    submit();
    expect(
      await within(fieldOf('Name')).findByText(/owned by gentle-ai sync/),
    ).toBeTruthy();
    // Modal stays open, inputs retained, nothing leaked into other fields.
    expect(
      (within(dialog()).getByLabelText('Name') as HTMLInputElement).value,
    ).toBe('sdd-mine');
    expect(within(fieldOf('Model')).queryAllByRole('alert').length).toBe(0);
    expect(submitButton().disabled).toBe(false);
  });

  it('a ghost clone model + model_unknown lands on the Model field (D10/D9)', async () => {
    scriptApi({
      prompts: [
        {
          status: 200,
          body: {
            name: 'ghost-model',
            source: 'inline',
            prompt: 'Ghost holder.',
          },
        },
      ],
      creates: [
        err400(
          'model_unknown',
          'model "ghostly/missing-1" is not a "<provider>/<model-id>" pair installed in CONFIG — omit the field to use the runtime default.',
        ),
      ],
    });
    await opened();
    pickClone('ghost-model');
    // D10 ghost rule: the prefilled-but-uninstalled pair stays selectable.
    await waitFor(() => expect(modelSelect().value).toBe('ghostly/missing-1'));
    expect(Array.from(modelSelect().options).map((o) => o.value)).toEqual([
      '',
      'ghostly/missing-1',
      'nan/qwen3.8-flash',
      'nan/qwen3.6',
    ]);
    setName('keeps-ghost');
    submit();
    expect(
      await within(fieldOf('Model')).findByText(
        /is not a "<provider>\/<model-id>" pair/,
      ),
    ).toBeTruthy();
    expect(modelSelect().value).toBe('ghostly/missing-1');
  });

  it('prompt_too_large from a clone resolve lands in the preview area (AT-3)', async () => {
    scriptApi({
      prompts: [
        err400('prompt_too_large', 'Referenced prompt exceeds the 64 KiB cap.'),
      ],
    });
    await opened();
    setName('too-big');
    pickClone('huge');
    expect(
      await within(promptArea()).findByText(/exceeds the 64 KiB cap/),
    ).toBeTruthy();
    // With no materialized prompt, create remains blocked (D5 preview is the
    // only prompt source — there is nothing to type into).
    expect(submitButton().disabled).toBe(true);
  });
});

describe('CreateAgentModal — 409 rides the established ConflictModal (D9)', () => {
  const stale: Reply = {
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

  it('one (new agent) diff row; Overwrite retries the create on the fresh hash', async () => {
    const fresh = fixture({ hash: 'hash-external-9' });
    const { calls } = scriptApi({
      gets: [fresh],
      creates: [stale, okCreate('echo-W')],
    });
    const { onCreated } = await opened();
    setName('my-helper');
    pickTemplate('blank');
    submit();
    const conflict = await screen.findByRole('dialog', {
      name: 'Config conflict',
    });
    expect(within(conflict).getByText('agent.my-helper')).toBeTruthy();
    expect(within(conflict).getByText('(new agent)')).toBeTruthy();
    expect(within(conflict).getByText('— absent')).toBeTruthy();
    // The create form is retained underneath (AC-7: pending form data kept).
    expect(
      (within(dialog()).getByLabelText('Name') as HTMLInputElement).value,
    ).toBe('my-helper');
    fireEvent.click(
      within(conflict).getByRole('button', { name: 'Overwrite' }),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('echo-W'));
    const w = creates(calls);
    expect(w.length).toBe(2);
    expect(w[1].body?.hash).toBe('hash-external-9');
  });

  it('Reload fresh adopts the reloaded base and keeps the form open', async () => {
    const fresh = fixture({ hash: 'hash-external-9' });
    const { calls } = scriptApi({
      gets: [fresh],
      creates: [stale],
    });
    const { onAdoptFresh } = await opened();
    setName('my-helper');
    pickTemplate('blank');
    submit();
    const conflict = await screen.findByRole('dialog', {
      name: 'Config conflict',
    });
    fireEvent.click(
      within(conflict).getByRole('button', { name: 'Reload fresh' }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Config conflict' }),
      ).toBeNull(),
    );
    expect(onAdoptFresh).toHaveBeenCalledWith(
      expect.objectContaining({ hash: 'hash-external-9' }),
    );
    // No second POST happened; the form survived and is re-submittable.
    expect(creates(calls).length).toBe(1);
    expect(
      (within(dialog()).getByLabelText('Name') as HTMLInputElement).value,
    ).toBe('my-helper');
  });
});

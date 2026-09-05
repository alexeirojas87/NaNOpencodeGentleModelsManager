// agent-pipelines WU-3a task 3a.1 (RED) — pipeline builder modal tests
// (spec AP-9, AP-3 preview parity, AC-9', AC-6; design §Web UI). Headline
// threat RED: builder free-text editor → persisted string → every render is
// an inert text node — `<script>` executes nothing, mid-string `{file:` is
// cosmetic text (anchored gate). Binding submit contract: exactly one
// {hash, pipeline} POST — mode/hidden/permission appear NOWHERE in the input
// (AC-4'). The preview must be BYTE-IDENTICAL to the server's generated
// orchestrator prompt and task map (shared/pipeline-prompt.ts is the single
// source). Every fetch is scripted (WU6/WU-B pattern).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentTemplate,
  ConfigResponse,
  PipelineDefinition,
} from '../../../shared/types';
import {
  buildOrchestratorPrompt,
  buildTaskPermissionMap,
} from '../../../shared/pipeline-prompt';
import { CreateAgentModal } from './CreateAgentModal';
import { PipelineBuilderModal } from './PipelineBuilderModal';

/** The exact attack payload (threat matrix: stored XSS, editor→persist→preview). */
const XSS = `<script>alert('xss')</script>`;
/** Mid-string ref text — the ANCHORED gate keeps this legal, inert content. */
const MID_REF = `Read notes at {file:./x.md} then ${XSS} work carefully.`;

const TEMPLATES: { templates: AgentTemplate[] } = {
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

function baseFixture(over?: Partial<ConfigResponse>): ConfigResponse {
  return {
    hash: 'hash-base-0001',
    mtime: 1756000000000,
    providers: {
      nan: { name: 'NaN', models: { 'qwen3.8-flash': {}, 'qwen3.6': {} } },
      headroom: { name: 'Headroom', models: {} },
    },
    agents: {
      'sdd-spec': {
        description: 'd',
        prompt: '{file:./prompts/sdd/sdd-spec.md}',
      },
      'my-helper': { description: 'd', prompt: 'Helper prompt.' },
      'evil-src': { description: 'd', prompt: XSS },
      'ghost-model': { model: 'ghostly/missing-1', prompt: 'Ghost holder.' },
      ...over?.agents,
    },
    defaultAgent: 'gentle-orchestrator',
    authJson: { exists: [] },
    snapshotAsOf: '2026-09-04',
    ...over,
  };
}

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}
type Reply = { status: number; body: unknown };

/** Scripted fetch with fail-loud queues per lane. */
function scriptApi(
  opts: {
    templates?: Reply[];
    prompts?: Reply[];
    /** POST/PUT lanes for /api/agent-pipelines[/name]. */
    saves?: Reply[];
    gets?: ConfigResponse[];
  } = {},
) {
  const calls: Call[] = [];
  const templates = [...(opts.templates ?? [{ status: 200, body: TEMPLATES }])];
  const prompts = [...(opts.prompts ?? [])];
  const saves = [...(opts.saves ?? [])];
  const gets = [...(opts.gets ?? [baseFixture()])];
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
      if (method === 'GET' && url === '/api/templates') {
        const reply = templates.length > 1 ? templates.shift() : templates[0];
        if (!reply) throw new Error('GET /api/templates exhausted');
        return json(reply.status, reply.body);
      }
      if (method === 'GET' && /^\/api\/agents\/[^/]+\/prompt$/.test(url)) {
        const reply = prompts.shift();
        if (!reply) throw new Error(`GET prompt exhausted at ${url}`);
        return json(reply.status, reply.body);
      }
      if (method === 'GET' && url === '/api/config') {
        const next = gets.length > 1 ? gets.shift() : gets[0];
        return json(200, next);
      }
      if (
        (method === 'POST' && url === '/api/agent-pipelines') ||
        (method === 'PUT' && /^\/api\/agent-pipelines\//.test(url))
      ) {
        const reply = saves.shift();
        if (!reply) throw new Error(`${method} ${url} script exhausted`);
        return json(reply.status, reply.body);
      }
      throw new Error(`unexpected ${method} ${url}`);
    }),
  );
  return { calls };
}

const okSave = (hash: string): Reply => ({
  status: 200,
  body: { ok: true, hash },
});
const err400 = (code: string, message: string): Reply => ({
  status: 400,
  body: { ok: false, error: { code, message } },
});

function renderBuilder(
  props: Partial<Parameters<typeof PipelineBuilderModal>[0]> = {},
) {
  const onSaved = vi.fn();
  const onAdoptFresh = vi.fn();
  const onClose = vi.fn();
  render(
    <PipelineBuilderModal
      base={baseFixture()}
      onClose={onClose}
      onSaved={onSaved}
      onAdoptFresh={onAdoptFresh}
      {...props}
    />,
  );
  return { onSaved, onAdoptFresh, onClose };
}

async function opened(
  props: Partial<Parameters<typeof PipelineBuilderModal>[0]> = {},
  // Edit prefills may carry NO template-mode card — the presets wait is only
  // meaningful while a Template select is on screen.
  waitTemplates = true,
) {
  const api = renderBuilder(props);
  const dlg = await screen.findByRole('dialog', { name: 'Pipeline builder' });
  if (waitTemplates) await within(dlg).findByText('Reviewer'); // AT-1 landed
  return { ...api, dlg };
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Pipeline builder' });
}
function card(i: number): HTMLElement {
  return within(dialog()).getByLabelText(`Role ${i}`);
}
function setField(scope: HTMLElement, label: string, value: string) {
  fireEvent.change(within(scope).getByLabelText(label), {
    target: { value },
  });
}
function pickSource(i: number, source: 'template' | 'clone' | 'free-text') {
  fireEvent.click(within(card(i)).getByRole('radio', { name: source }));
}
function roleModel(i: number): HTMLSelectElement {
  return within(card(i)).getByLabelText(`Role ${i} model`) as HTMLSelectElement;
}
function preview(): HTMLElement {
  return within(dialog()).getByLabelText('Orchestrator prompt preview');
}
function taskMap(): HTMLElement {
  return within(dialog()).getByLabelText('Delegation task map');
}
function submitBtn(): HTMLButtonElement {
  return within(dialog()).getByRole('button', {
    name: /Create pipeline|Save pipeline/,
  }) as HTMLButtonElement;
}
function fillsTheFirstRole(i = 1) {
  setField(card(i), `Role ${i} name`, `mypl-${i === 1 ? 'build' : 'review'}`);
  setField(
    card(i),
    `Role ${i} description`,
    i === 1 ? 'builds the code' : 'reviews the code',
  );
}
const saves = (calls: Call[]) =>
  calls.filter(
    (c) =>
      (c.method === 'POST' && c.url === '/api/agent-pipelines') ||
      (c.method === 'PUT' && c.url.startsWith('/api/agent-pipelines/')),
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PipelineBuilderModal — form shape (AP-9)', () => {
  it('name, one role card, orchestrator fields, preview regions, add-role control', async () => {
    scriptApi();
    await opened();
    expect(within(dialog()).getByLabelText('Pipeline name')).toBeTruthy();
    expect(card(1)).toBeTruthy();
    expect(
      within(dialog()).getByRole('button', { name: 'Add role' }),
    ).toBeTruthy();
    expect(
      within(dialog()).getByLabelText('Orchestrator description'),
    ).toBeTruthy();
    expect(within(dialog()).getByLabelText('Orchestrator model')).toBeTruthy();
    expect(preview()).toBeTruthy();
    expect(taskMap()).toBeTruthy();
    // AP-9: the builder is the only edit path — the submit never touches a table cell.
    expect(submitBtn().disabled).toBe(true); // empty name → blocked
  });

  it('Add role appends cards addressed by index; Remove role drops them (0..N)', async () => {
    scriptApi();
    await opened();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add role' }));
    expect(card(2)).toBeTruthy();
    fireEvent.click(
      within(card(2)).getByRole('button', { name: 'Remove role' }),
    );
    expect(within(dialog()).queryByLabelText('Role 2')).toBeNull();
  });

  it('model pickers are limited to installed pairs (AC-6)', async () => {
    scriptApi();
    await opened();
    const values = Array.from(roleModel(1).options).map((o) => o.value);
    expect(values).toEqual(['', 'nan/qwen3.8-flash', 'nan/qwen3.6']);
    const orch = within(dialog()).getByLabelText(
      'Orchestrator model',
    ) as HTMLSelectElement;
    expect(Array.from(orch.options).map((o) => o.value)).toEqual(values);
    // headroom declares zero models → never offered anywhere.
    expect(values.some((v) => v.startsWith('headroom/'))).toBe(false);
  });

  it('prompt source radio set is exactly template | clone | free-text (AP-9)', async () => {
    scriptApi();
    await opened();
    const radios = within(card(1)).getAllByRole('radio');
    expect(radios.map((r) => String(r.getAttribute('value'))).sort()).toEqual([
      'clone',
      'free-text',
      'template',
    ]);
    // free-text brings the editor; the prompt is what persists.
    pickSource(1, 'free-text');
    const editor = within(card(1)).getByLabelText('Role 1 prompt');
    expect(editor.tagName).toBe('TEXTAREA');
    fireEvent.change(editor, { target: { value: 'typed text' } });
    expect((editor as HTMLTextAreaElement).value).toBe('typed text');
  });

  it('helper picker adds/removes by exact name from existing agents', async () => {
    scriptApi();
    await opened();
    const helper = within(dialog()).getByLabelText(
      'Helper to add',
    ) as HTMLSelectElement;
    // Delegation candidates are the CONFIG agents (members of THIS def excluded).
    expect(Array.from(helper.options).map((o) => o.value)).toEqual([
      '',
      'sdd-spec',
      'my-helper',
      'evil-src',
      'ghost-model',
    ]);
    fireEvent.change(helper, { target: { value: 'my-helper' } });
    fireEvent.click(
      within(dialog()).getByRole('button', { name: 'Add helper' }),
    );
    expect(
      within(dialog()).getByRole('button', { name: 'Remove helper my-helper' }),
    ).toBeTruthy();
    fireEvent.click(
      within(dialog()).getByRole('button', { name: 'Remove helper my-helper' }),
    );
    expect(
      within(dialog()).queryByRole('button', {
        name: 'Remove helper my-helper',
      }),
    ).toBeNull();
  });
});

describe('PipelineBuilderModal — preview is byte-identical to the generator (AP-3 parity)', () => {
  it('prompt text and task map equal the shared generator outputs exactly', async () => {
    scriptApi();
    await opened();
    setField(dialog(), 'Pipeline name', 'mypl');
    setField(dialog(), 'Orchestrator description', 'coordinate mypl');
    fillsTheFirstRole(1);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Add role' }));
    fillsTheFirstRole(2);
    pickSource(1, 'free-text');
    fireEvent.change(within(card(1)).getByLabelText('Role 1 prompt'), {
      target: { value: 'Build prompt.' },
    });
    pickSource(2, 'free-text');
    fireEvent.change(within(card(2)).getByLabelText('Role 2 prompt'), {
      target: { value: 'Review prompt.' },
    });
    const helper = within(dialog()).getByLabelText(
      'Helper to add',
    ) as HTMLSelectElement;
    fireEvent.change(helper, { target: { value: 'my-helper' } });
    fireEvent.click(
      within(dialog()).getByRole('button', { name: 'Add helper' }),
    );

    const roles = [
      { name: 'mypl-build', description: 'builds the code' },
      { name: 'mypl-review', description: 'reviews the code' },
    ];
    expect(preview().textContent).toBe(
      buildOrchestratorPrompt({
        pipeline: 'mypl',
        roles,
        helpers: ['my-helper'],
      }),
    );
    expect(taskMap().textContent).toBe(
      JSON.stringify(
        buildTaskPermissionMap(['mypl-build', 'mypl-review'], ['my-helper']),
        null,
        2,
      ),
    );
    // Deny-star first is load-bearing (C-R1f) — the preview pins it visibly.
    expect(taskMap().textContent).toMatch(/^\{\n {2}"\*": "deny"/);
  });
});

describe("PipelineBuilderModal — submit contract (AC-4', AC-9')", () => {
  it('a valid batch posts EXACTLY ONE {hash,pipeline} — no generated fields anywhere', async () => {
    const { calls } = scriptApi({ saves: [okSave('echo-1')] });
    const { onSaved } = await opened();
    setField(dialog(), 'Pipeline name', 'mypl');
    setField(dialog(), 'Orchestrator description', 'coordinate mypl');
    setField(dialog(), 'Orchestrator model', 'nan/qwen3.6');
    fillsTheFirstRole(1);
    fireEvent.change(roleModel(1), { target: { value: 'nan/qwen3.8-flash' } });
    pickSource(1, 'free-text');
    fireEvent.change(within(card(1)).getByLabelText('Role 1 prompt'), {
      target: { value: 'Build prompt.' },
    });
    submit();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('echo-1'));
    const posts = saves(calls);
    expect(posts.length).toBe(1);
    expect(posts[0].method).toBe('POST');
    expect(posts[0].url).toBe('/api/agent-pipelines');
    expect(posts[0].body).toEqual({
      hash: 'hash-base-0001',
      pipeline: {
        name: 'mypl',
        orchestrator: { model: 'nan/qwen3.6', description: 'coordinate mypl' },
        roles: [
          {
            name: 'mypl-build',
            model: 'nan/qwen3.8-flash',
            description: 'builds the code',
            promptSource: 'free-text',
            prompt: 'Build prompt.',
          },
        ],
      },
    });
    // AC-4': the input NEVER carries the generated trio (threat: def-bypass).
    const wire = JSON.stringify(posts[0].body);
    for (const banned of [
      'mode',
      'hidden',
      'permission',
      'temperature',
      'variant',
    ]) {
      expect(wire).not.toContain(`"${banned}"`);
    }
  });

  it('template source persists the preset text with promptSource=template; empty helpers omit the key', async () => {
    const { calls } = scriptApi({ saves: [okSave('echo-2')] });
    await opened();
    setField(dialog(), 'Pipeline name', 'mypl');
    setField(dialog(), 'Orchestrator description', 'coordinate mypl');
    fillsTheFirstRole(1);
    // Default source is template — pick a preset (AT-1 pool shared with create).
    fireEvent.change(within(card(1)).getByLabelText('Template'), {
      target: { value: 'reviewer' },
    });
    submit();
    await waitFor(() => expect(saves(calls).length).toBe(1));
    const body = saves(calls)[0].body as {
      pipeline: { roles: Record<string, unknown>[]; helpers?: unknown };
    };
    expect(body.pipeline.roles[0]).toEqual({
      name: 'mypl-build',
      description: 'builds the code',
      promptSource: 'template',
      prompt: TEMPLATES.templates[0].prompt,
    });
    expect('helpers' in body.pipeline).toBe(false);
  });

  it('clone source materializes the source prompt text into the persisted value (AT-2/AT-3)', async () => {
    const { calls } = scriptApi({
      prompts: [
        {
          status: 200,
          body: {
            name: 'sdd-spec',
            source: 'file',
            ref: './prompts/sdd/sdd-spec.md',
            prompt: '# MATERIALIZED',
          },
        },
      ],
      saves: [okSave('echo-3')],
    });
    await opened();
    setField(dialog(), 'Pipeline name', 'mypl');
    setField(dialog(), 'Orchestrator description', 'coordinate mypl');
    fillsTheFirstRole(1);
    pickSource(1, 'clone');
    fireEvent.change(within(card(1)).getByLabelText('Clone source'), {
      target: { value: 'sdd-spec' },
    });
    await waitFor(() =>
      expect(
        (within(card(1)).getByLabelText('Role 1 prompt') as HTMLTextAreaElement)
          .value,
      ).toBe('# MATERIALIZED'),
    );
    submit();
    await waitFor(() => expect(saves(calls).length).toBe(1));
    const role = (
      saves(calls)[0].body as {
        pipeline: { roles: Record<string, unknown>[] };
      }
    ).pipeline.roles[0];
    expect(role['promptSource']).toBe('clone');
    expect(role['prompt']).toBe('# MATERIALIZED'); // resolved literal text (AP-1)
  });

  it('an unresolvable clone source surfaces in-form and blocks nothing silently (AT-3)', async () => {
    scriptApi({
      prompts: [
        {
          status: 404,
          body: {
            ok: false,
            error: {
              code: 'prompt_unavailable',
              message: 'no viewable prompt content',
            },
          },
        },
      ],
    });
    await opened();
    setField(dialog(), 'Pipeline name', 'mypl');
    setField(dialog(), 'Orchestrator description', 'coordinate mypl');
    fillsTheFirstRole(1);
    pickSource(1, 'clone');
    fireEvent.change(within(card(1)).getByLabelText('Clone source'), {
      target: { value: 'sdd-spec' },
    });
    expect(
      await within(card(1)).findByText(/no viewable prompt content/),
    ).toBeTruthy();
    expect(submitBtn().disabled).toBe(true); // no prompt → nothing to persist
  });

  function submit() {
    fireEvent.click(submitBtn());
  }
});

describe('PipelineBuilderModal — XSS threat RED (headline round trip)', () => {
  it('prompt+description payloads persist verbatim and render ONLY as inert text nodes', async () => {
    const { calls } = scriptApi({ saves: [okSave('echo-x')] });
    await opened();
    setField(dialog(), 'Pipeline name', 'mypl');
    setField(dialog(), 'Orchestrator description', 'coordinate mypl');
    setField(card(1), 'Role 1 name', 'mypl-build');
    setField(card(1), 'Role 1 description', XSS); // description rides the preview
    pickSource(1, 'free-text');
    const editor = within(card(1)).getByLabelText(
      'Role 1 prompt',
    ) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: MID_REF } });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(saves(calls).length).toBe(1));

    // (1) persisted string: the POST carries the payload VERBATIM — the
    // anchored gate keeps mid-string {file: as inert content, never rejected.
    const role = (
      saves(calls)[0].body as {
        pipeline: { roles: Record<string, unknown>[] };
      }
    ).pipeline.roles[0];
    expect(role['prompt']).toBe(MID_REF);
    expect(role['description']).toBe(XSS);

    // (2) rendered as inert text: the preview embeds the description payload
    // as a TEXT node; nothing executed anywhere in the document.
    const previewText = within(preview()).getByText(XSS, { exact: false });
    expect(previewText.tagName).toBe('PRE');
    expect(previewText.querySelectorAll('*').length).toBe(0); // pure text child
    expect(document.querySelectorAll('script').length).toBe(0);
    expect(document.querySelectorAll('iframe, object, embed').length).toBe(0);
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
    // The textarea keeps the value as data, never as rendered markup.
    expect(editor.value).toBe(MID_REF);
  });
});

describe("CreateAgentModal — AC-9' single|pipeline toggle (task 3a.4)", () => {
  async function openCreateWithToggle() {
    render(
      <CreateAgentModal
        base={baseFixture()}
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onAdoptFresh={vi.fn()}
      />,
    );
    return await screen.findByRole('dialog', { name: 'New agent' });
  }

  it('defaults to the single-agent shape — the D5 read-only form, zero textareas', async () => {
    scriptApi();
    const dlg = await openCreateWithToggle();
    expect(within(dlg).getByLabelText('Name')).toBeTruthy();
    expect(within(dlg).getByLabelText('Prompt source')).toBeTruthy();
    expect(within(dlg).queryByLabelText('Pipeline name')).toBeNull();
    expect(document.querySelectorAll('textarea').length).toBe(0);
    expect(within(dlg).getByRole('button', { name: 'Create' })).toBeTruthy();
  });

  it('switching to pipeline renders the builder inside the same flow', async () => {
    scriptApi();
    const dlg = await openCreateWithToggle();
    fireEvent.click(within(dlg).getByRole('radio', { name: 'Pipeline' }));
    expect(
      await screen.findByRole('dialog', { name: 'Pipeline builder' }),
    ).toBeTruthy();
    expect(
      within(
        screen.getByRole('dialog', { name: 'Pipeline builder' }),
      ).getByLabelText('Pipeline name'),
    ).toBeTruthy();
    // Still a single dialog on screen — the builder replaces, never stacks.
    expect(screen.getAllByRole('dialog').length).toBe(1);
  });

  it('switching back keeps the single-agent form as the default shape', async () => {
    scriptApi();
    const dlg = await openCreateWithToggle();
    fireEvent.click(within(dlg).getByRole('radio', { name: 'Pipeline' }));
    await screen.findByRole('dialog', { name: 'Pipeline builder' });
    fireEvent.click(
      within(
        screen.getByRole('dialog', { name: 'Pipeline builder' }),
      ).getByRole('radio', { name: 'Single agent' }),
    );
    const back = await screen.findByRole('dialog', { name: 'New agent' });
    expect(within(back).getByLabelText('Name')).toBeTruthy();
    expect(document.querySelectorAll('textarea').length).toBe(0);
  });
});

// --- WU-3b: edit prefill from the definition read surface + AC-9' matrix ----

function storedDef(): PipelineDefinition {
  return {
    roles: [
      {
        name: 'mypl-build',
        model: 'nan/qwen3.8-flash',
        description: 'builds the code',
        promptSource: 'free-text',
        prompt: 'Build prompt.',
      },
      {
        name: 'mypl-review',
        description: 'reviews the code',
        promptSource: 'clone',
        prompt: 'Review prompt.',
      },
    ],
    orchestrator: {
      model: 'ghostly/missing-1',
      description: 'coordinate mypl',
    },
    helpers: ['my-helper'],
  };
}

describe('PipelineBuilderModal — edit prefill from definition (3b.1, AP-4 edit path)', () => {
  it('prefills every card/orchestrator/helper field; name locked; ghost pair visible', async () => {
    scriptApi();
    await opened({ editing: { name: 'mypl', definition: storedDef() } }, false);
    const nameInput = within(dialog()).getByLabelText(
      'Pipeline name',
    ) as HTMLInputElement;
    expect(nameInput.value).toBe('mypl');
    expect(nameInput.disabled).toBe(true); // orchestrator ≡ key (AP-6)
    expect(
      (within(card(1)).getByLabelText('Role 1 name') as HTMLInputElement).value,
    ).toBe('mypl-build');
    expect(
      (within(card(1)).getByLabelText('Role 1 model') as HTMLSelectElement)
        .value,
    ).toBe('nan/qwen3.8-flash');
    expect(
      (within(card(1)).getByLabelText('Role 1 prompt') as HTMLTextAreaElement)
        .value,
    ).toBe('Build prompt.');
    expect(
      (
        within(card(1)).getByRole('radio', {
          name: 'free-text',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        within(card(2)).getByRole('radio', {
          name: 'clone',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (within(card(2)).getByLabelText('Role 2 prompt') as HTMLTextAreaElement)
        .value,
    ).toBe('Review prompt.');
    // Ghost rule (D10): a stored-but-uninstalled pair stays visible in edit.
    const orch = within(dialog()).getByLabelText(
      'Orchestrator model',
    ) as HTMLSelectElement;
    expect(orch.value).toBe('ghostly/missing-1');
    expect(Array.from(orch.options).map((o) => o.value)).toEqual([
      '',
      'ghostly/missing-1',
      'nan/qwen3.8-flash',
      'nan/qwen3.6',
    ]);
    expect(
      within(dialog()).getByRole('button', { name: 'Remove helper my-helper' }),
    ).toBeTruthy();
    expect(
      within(dialog()).getByRole('button', { name: 'Save pipeline' }),
    ).toBeTruthy();
  });

  it('edit submit PUTs the SAME shape to /api/agent-pipelines/mypl — one call', async () => {
    const { calls } = scriptApi({ saves: [okSave('echo-edit')] });
    const { onSaved } = await opened(
      { editing: { name: 'mypl', definition: storedDef() } },
      false,
    );
    // Drop role 2, retype role 1 prompt — the regenerated preview follows.
    fireEvent.click(
      within(card(2)).getByRole('button', { name: 'Remove role' }),
    );
    fireEvent.change(within(card(1)).getByLabelText('Role 1 prompt'), {
      target: { value: 'Updated build prompt.' },
    });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('echo-edit'));
    const s = saves(calls);
    expect(s.length).toBe(1);
    expect(s[0].method).toBe('PUT');
    expect(s[0].url).toBe('/api/agent-pipelines/mypl');
    expect(s[0].body).toEqual({
      hash: 'hash-base-0001',
      pipeline: {
        name: 'mypl',
        orchestrator: {
          model: 'ghostly/missing-1',
          description: 'coordinate mypl',
        },
        roles: [
          {
            name: 'mypl-build',
            model: 'nan/qwen3.8-flash',
            description: 'builds the code',
            promptSource: 'free-text',
            prompt: 'Updated build prompt.',
          },
        ],
        helpers: ['my-helper'],
      },
    });
    const wire = JSON.stringify(s[0].body);
    for (const banned of ['mode', 'hidden', 'permission'])
      expect(wire).not.toContain(`"${banned}"`);
  });

  it('clone-mode cards keep the materialized text editable (prompt stays literal)', async () => {
    scriptApi();
    await opened({ editing: { name: 'mypl', definition: storedDef() } }, false);
    // role 2 is promptSource=clone with stored text — editing it keeps provenance.
    const editor = within(card(2)).getByLabelText(
      'Role 2 prompt',
    ) as HTMLTextAreaElement;
    expect(editor.value).toBe('Review prompt.');
    fireEvent.change(editor, { target: { value: 'Tweaked review.' } });
    expect(editor.value).toBe('Tweaked review.');
  });
});

describe('PipelineBuilderModal — AC-9’ 400 matrix renders field errors, CONFIG untouched (3b.1)', () => {
  async function filledCreate(replies: Reply[]) {
    const api = scriptApi({ saves: replies });
    const { onSaved } = await opened();
    setField(dialog(), 'Pipeline name', 'mypl');
    setField(dialog(), 'Orchestrator description', 'coordinate mypl');
    fillsTheFirstRole(1);
    pickSource(1, 'free-text');
    fireEvent.change(within(card(1)).getByLabelText('Role 1 prompt'), {
      target: { value: 'Build prompt.' },
    });
    fireEvent.click(submitBtn());
    await waitFor(() => expect(saves(api.calls).length).toBe(1));
    return { ...api, onSaved };
  }

  it('reserved_name on a role lands on that card’s name field; modal stays open', async () => {
    const { calls, onSaved } = await filledCreate([
      err400(
        'reserved_name',
        'Agent name "mypl-build" is owned by gentle-ai sync — a pipeline may not claim it.',
      ),
    ]);
    expect(
      await within(card(1)).findByText(/owned by gentle-ai sync/),
    ).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect(saves(calls).length).toBe(1); // exactly one attempt; nothing persisted
  });

  it('agent_exists on a role lands on the card; duplicate_name too', async () => {
    const { calls, onSaved } = await filledCreate([
      err400(
        'agent_exists',
        'Agent "mypl-build" already exists outside this pipeline — choose a different member name.',
      ),
    ]);
    expect(
      await within(card(1)).findByText(/already exists outside this pipeline/),
    ).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect(saves(calls).length).toBe(1);
  });

  it('pipeline_exists answers on the pipeline name field', async () => {
    const { calls, onSaved } = await filledCreate([
      err400(
        'pipeline_exists',
        'Pipeline "mypl" already exists — edit it (PUT) or delete it first.',
      ),
    ]);
    expect(
      await within(dialog()).findByText(/already exists — edit it/),
    ).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect(saves(calls).length).toBe(1);
  });

  it('invalid_shape surfaces the per-path detail generally', async () => {
    const { onSaved } = await filledCreate([
      {
        status: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_shape',
            message: 'Pipeline definition rejected.',
            detail:
              'agent-pipelines.mypl.roles.0.prompt: a {file:…} reference prompt is never persisted — inline the text',
          },
        },
      },
    ]);
    expect(
      await within(dialog()).findByText(/roles\.0\.prompt.*never persisted/),
    ).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('model_unknown on a role lands on that card’s model field', async () => {
    const { onSaved } = await filledCreate([
      err400(
        'model_unknown',
        'pipeline.roles[0].model "nan/gone-9" is not a "<provider>/<model-id>" pair installed in CONFIG — omit it to inherit the invoker model.',
      ),
    ]);
    expect(
      await within(card(1)).findByText(/not a "<provider>\/<model-id>" pair/),
    ).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('409 opens the established conflict flow; Overwrite re-posts on the fresh hash', async () => {
    const fresh = baseFixture({ hash: 'hash-external-9' });
    const { calls } = scriptApi({
      // The builder receives `base` as a prop — the ONLY config GET is the
      // conflict reload, so the queue holds exactly the fresh copy.
      gets: [fresh],
      saves: [
        {
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
        },
        okSave('echo-9'),
      ],
    });
    const { onSaved } = await opened();
    setField(dialog(), 'Pipeline name', 'mypl');
    setField(dialog(), 'Orchestrator description', 'coordinate mypl');
    fillsTheFirstRole(1);
    pickSource(1, 'free-text');
    fireEvent.change(within(card(1)).getByLabelText('Role 1 prompt'), {
      target: { value: 'Build prompt.' },
    });
    fireEvent.click(submitBtn());
    const conflict = await screen.findByRole('dialog', {
      name: 'Config conflict',
    });
    expect(within(conflict).getByText('agent-pipelines.mypl')).toBeTruthy();
    expect(within(conflict).getByText('(pipeline batch)')).toBeTruthy();
    // Form data survives underneath the conflict overlay (AC-7 posture).
    expect(
      (within(dialog()).getByLabelText('Pipeline name') as HTMLInputElement)
        .value,
    ).toBe('mypl');
    fireEvent.click(
      within(conflict).getByRole('button', { name: 'Overwrite' }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('echo-9'));
    const s = saves(calls);
    expect(s.length).toBe(2);
    expect(s[1].body?.hash).toBe('hash-external-9');
  });
});

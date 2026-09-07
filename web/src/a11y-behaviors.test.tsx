// dashboard-ui-redesign WU4 (RED-first) — the two HIGH a11y gap surgeries as
// behavior tests (spec a11y-gaps; design D-F/D-S contracts, tasks 4.1–4.4):
//   1. Focusable error summaries in CreateAgentModal and PipelineBuilderModal:
//      a failed submit renders a top-of-form summary that RECEIVES FOCUS, its
//      entries are named by FIELD LABEL ONLY (never the error message — that
//      stays in the inline .field-error, so no text duplication) and each
//      entry moves focus to its invalid field. The summary itself carries NO
//      role="alert" (scoped alert queries elsewhere stay intact).
//   2. CapabilityChip full-value disclosure: the advisory chip is a real
//      BUTTON (keyboard-reachable — Enter/Space operate it by platform
//      default), carries aria-expanded, and activating it reveals the full
//      value WITHOUT pointer hover (the .chip-open unwrap).
// RED protocol: this file was written and watched failing BEFORE the
// error-summary/chip-button implementations landed (strict TDD).
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
  ModelConfig,
} from '../../shared/types';
import { CreateAgentModal } from './components/CreateAgentModal';
import { PipelineBuilderModal } from './components/PipelineBuilderModal';
import { CapabilityChip } from './components/assignments/CapabilityChip';
import type { PhaseNeed } from './components/assignments/phaseKnowledge';

const TEMPLATES: { templates: AgentTemplate[] } = {
  templates: [
    {
      id: 'executor',
      label: 'Executor',
      description: 'Task delivery',
      prompt:
        '# Executor\nYou implement exactly the assigned task and nothing else.',
    },
    {
      id: 'blank',
      label: 'Blank',
      description: 'Stub',
      prompt: '# New agent\nThis agent has no custom instructions yet.',
    },
  ],
};

function baseFixture(): ConfigResponse {
  return {
    hash: 'hash-base-0001',
    mtime: 1756000000000,
    providers: {
      nan: { name: 'NaN', models: { 'qwen3.8-flash': {}, 'qwen3.6': {} } },
    },
    agents: {
      'sdd-spec': {
        description: 'd',
        prompt: '{file:./prompts/sdd/sdd-spec.md}',
      },
    },
    authJson: { exists: [] },
    snapshotAsOf: '2026-09-04',
  };
}

interface Call {
  method: string;
  url: string;
}
type Reply = { status: number; body: unknown };

/** Scripted fetch with fail-loud queues per lane (WU6/WU-B test pattern). */
function scriptApi(opts: { templates?: Reply[]; posts?: Reply[] } = {}) {
  const calls: Call[] = [];
  const templates = [...(opts.templates ?? [{ status: 200, body: TEMPLATES }])];
  const posts = [...(opts.posts ?? [])];
  vi.stubGlobal(
    'alert',
    vi.fn(() => true),
  );
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
      if (method === 'GET' && url === '/api/templates') {
        const reply = templates.length > 1 ? templates.shift() : templates[0];
        if (!reply) throw new Error('GET /api/templates exhausted');
        return json(reply.status, reply.body);
      }
      if (
        method === 'POST' &&
        (url === '/api/agents' || url === '/api/agent-pipelines')
      ) {
        const reply = posts.shift();
        if (!reply) throw new Error(`POST ${url} script exhausted`);
        return json(reply.status, reply.body);
      }
      throw new Error(`unexpected ${method} ${url}`);
    }),
  );
  return { calls };
}

const err400 = (
  code: string,
  message: string,
  detail: unknown = {},
): Reply => ({
  status: 400,
  body: { ok: false, error: { code, message, detail } },
});

function summary(): HTMLElement {
  return document.querySelector('.error-summary') as HTMLElement;
}

async function waitForSummaryFocused(): Promise<HTMLElement> {
  await waitFor(() => {
    const el = summary();
    if (!el) throw new Error('error summary did not render');
    if (document.activeElement !== el) {
      throw new Error('error summary did not receive focus');
    }
    return el;
  });
  return summary();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CreateAgentModal — focusable error summary (HIGH, WU4.1)', () => {
  it('failed submit focuses the top-of-form summary; its Name entry moves focus to #create-name; inline error retained', async () => {
    scriptApi({
      posts: [
        err400(
          'reserved_name',
          'Agent name "dup" is owned by gentle-ai sync — a next sync would silently deep-merge over it.',
        ),
      ],
    });
    render(
      <CreateAgentModal
        base={baseFixture()}
        onClose={() => undefined}
        onCreated={() => undefined}
        onAdoptFresh={() => undefined}
      />,
    );
    const dlg = await screen.findByRole('dialog', { name: 'New agent' });
    await within(dlg).findByText('Executor'); // presets landed (AT-1)
    fireEvent.change(within(dlg).getByLabelText('Name'), {
      target: { value: 'dup' },
    });
    fireEvent.change(within(dlg).getByLabelText('Prompt source'), {
      target: { value: 'template:executor' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Create' }));

    const el = await waitForSummaryFocused();
    // The summary is NOT an alert — scoped role=alert queries stay intact.
    expect(el.getAttribute('role')).toBeNull();
    // The entry is named by the FIELD LABEL only (no message duplication).
    const entry = within(el).getByRole('button', { name: 'Name' });
    expect(entry.textContent).not.toContain('gentle-ai sync');
    fireEvent.click(entry);
    expect(document.activeElement).toBe(dlg.querySelector('#create-name'));
    // The inline .field-error stays visible inside its field wrapper.
    const field = (
      within(dlg).getByLabelText('Name') as HTMLInputElement
    ).closest('.field') as HTMLElement;
    expect(within(field).getByText(/owned by gentle-ai sync/)).toBeTruthy();
  });
});

describe('PipelineBuilderModal — focusable error summary (HIGH, WU4.2)', () => {
  async function filledBuilder(posts: Reply[]) {
    scriptApi({ posts });
    render(
      <PipelineBuilderModal
        base={baseFixture()}
        onClose={() => undefined}
        onSaved={() => undefined}
        onAdoptFresh={() => undefined}
      />,
    );
    const dlg = await screen.findByRole('dialog', { name: 'Pipeline builder' });
    await within(dlg).findByText('Executor'); // presets landed
    fireEvent.change(within(dlg).getByLabelText('Pipeline name'), {
      target: { value: 'mypl' },
    });
    fireEvent.change(within(dlg).getByLabelText('Role 1 name'), {
      target: { value: 'mypl-build' },
    });
    fireEvent.click(within(dlg).getByRole('radio', { name: 'free-text' }));
    fireEvent.change(within(dlg).getByLabelText('Role 1 prompt'), {
      target: { value: 'Build prompt.' },
    });
    fireEvent.click(
      within(dlg).getByRole('button', { name: 'Create pipeline' }),
    );
    return dlg;
  }

  it('failed submit focuses the summary; the Pipeline name entry moves focus to #pipeline-name; inline error retained', async () => {
    const dlg = await filledBuilder([
      err400(
        'pipeline_exists',
        'Pipeline "mypl" already exists — edit it (PUT) or delete it first.',
      ),
    ]);
    const el = await waitForSummaryFocused();
    expect(el.getAttribute('role')).toBeNull();
    const entry = within(el).getByRole('button', { name: 'Pipeline name' });
    expect(entry.textContent).not.toContain('already exists');
    fireEvent.click(entry);
    expect(document.activeElement).toBe(dlg.querySelector('#pipeline-name'));
    expect(
      await within(dlg).findByText(/already exists — edit it/),
    ).toBeTruthy();
  });

  it('generalError surfaces as a NON-LINKED summary text entry; the message renders exactly once (no duplication)', async () => {
    const dlg = await filledBuilder([
      err400(
        'invalid_shape',
        'Pipeline definition rejected.',
        'agent-pipelines.mypl.roles.0.prompt: a {file:…} reference prompt is never persisted — inline the text',
      ),
    ]);
    await waitForSummaryFocused();
    // Non-linked entry: present as text, absent as a button/link control.
    expect(within(summary()).getByText('General error')).toBeTruthy();
    expect(
      within(summary()).queryByRole('button', { name: /General error/i }),
    ).toBeNull();
    // No error-text duplication: the message exists exactly once in the form.
    const matches = within(dlg).getAllByText(/never persisted/);
    expect(matches.length).toBe(1);
  });
});

describe('CapabilityChip — keyboard-operable full-value disclosure (HIGH, WU4.3)', () => {
  const model: ModelConfig = { tool_call: false };
  const needs: PhaseNeed[] = ['tools'];

  it('the advisory chip is a button with aria-expanded; activation reveals the full value without pointer hover', () => {
    render(<CapabilityChip model={model} needs={needs} />);
    // Keyboard reachability: a real button — Enter/Space operate it natively.
    const chip = screen.getByRole('button', { name: /no tool support/ });
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    // The full value is the chip's own text node (getByText-safe by design).
    expect(chip.textContent).toContain('no tool support');
    // Disclosure WITHOUT pointer hover: plain activation (keyboard-equivalent)
    // unwraps the value and keeps it visible.
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    expect(chip.className).toContain('chip-open');
    expect(chip.textContent).toContain('no tool support');
    // Toggling back collapses the chip again.
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(chip.className).not.toContain('chip-open');
  });
});

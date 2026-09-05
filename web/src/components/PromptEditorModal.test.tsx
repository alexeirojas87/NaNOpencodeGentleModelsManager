// agent-pipelines WU-4 task 4.2 (RED) — PromptEditorModal (OA-4', SCW-7' c).
// Headline round trip: type `<script>…</script>` + mid-string `{file:` in the
// editor → the PUT carries it VERBATIM (persisted string) → re-fetched into
// the read-only reader it renders as an inert text node: zero executed nodes,
// alert never called, the anchored gate never trips mid-string. A stale hash
// answers 409 with bytes unchanged and the form data retained (AC-7 posture).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PromptEditorModal } from './PromptEditorModal';
import { PromptReaderModal } from './PromptReaderModal';

const XSS = `<script>alert('xss')</script>`;
const MID_REF = `Consult {file:./notes.md} then ${XSS} ship it.`;

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}
type Reply = { status: number; body: unknown };

function scriptApi(
  opts: {
    /** GET /api/agents/:name/prompt queue (prefetch on open). */
    loads?: Reply[];
    /** PUT /api/agents/:name/prompt queue. */
    saves?: Reply[];
    /** GET /api/config queue (conflict reload; sticky last). */
    gets?: unknown[];
    /** second reader GET after the save (round-trip leg). */
    reads?: Reply[];
  } = {},
) {
  const calls: Call[] = [];
  const loads = [...(opts.loads ?? [])];
  const saves = [...(opts.saves ?? [])];
  const reads = [...(opts.reads ?? [])];
  const gets = [...(opts.gets ?? [])];
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
      if (method === 'GET' && /^\/api\/agents\/[^/]+\/prompt$/.test(url)) {
        const reply = loads.length > 0 ? loads.shift() : reads.shift();
        if (!reply) throw new Error(`GET prompt script exhausted at ${url}`);
        return json(reply.status, reply.body);
      }
      if (method === 'PUT' && /^\/api\/agents\/[^/]+\/prompt$/.test(url)) {
        const reply = saves.shift();
        if (!reply) throw new Error(`PUT prompt script exhausted at ${url}`);
        return json(reply.status, reply.body);
      }
      if (method === 'GET' && url === '/api/config') {
        const next = gets.length > 1 ? gets.shift() : gets[0];
        return json(200, next);
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

function renderEditor(
  props: Partial<Parameters<typeof PromptEditorModal>[0]> = {},
) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const onAdoptFresh = vi.fn();
  render(
    <PromptEditorModal
      agentName="my-helper"
      hash="hash-base-0001"
      onClose={onClose}
      onSaved={onSaved}
      onAdoptFresh={onAdoptFresh}
      {...props}
    />,
  );
  return { onSaved, onClose, onAdoptFresh };
}

type EditorProps = Parameters<typeof PromptEditorModal>[0];

async function opened(props: Partial<EditorProps> = {}) {
  const api = renderEditor(props);
  const dlg = await screen.findByRole('dialog', {
    name: `${props.agentName ?? 'my-helper'} prompt editor`,
  });
  return { ...api, dlg };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PromptEditorModal — editor surface (OA-4’)', () => {
  it('prefills the CURRENT prompt text into one editable textarea', async () => {
    scriptApi({
      loads: [
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
    const { dlg } = await opened();
    const editor = within(dlg).getByLabelText('Prompt') as HTMLTextAreaElement;
    expect(editor.value).toBe('Helper prompt.');
    expect(
      within(dlg).getByRole('button', { name: 'Save prompt' }),
    ).toBeTruthy();
  });

  it('an empty prompt blocks submit (server gate mirrored in-form)', async () => {
    scriptApi({
      loads: [
        {
          status: 200,
          body: { name: 'my-helper', source: 'inline', prompt: 'x' },
        },
      ],
    });
    const { dlg } = await opened();
    fireEvent.change(within(dlg).getByLabelText('Prompt'), {
      target: { value: '' },
    });
    expect(
      (
        within(dlg).getByRole('button', {
          name: 'Save prompt',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe('PromptEditorModal — editor→reader XSS round trip (headline threat)', () => {
  it('payload persists verbatim in the PUT and renders inert in the reader', async () => {
    const { calls } = scriptApi({
      loads: [
        {
          status: 200,
          body: {
            name: 'my-helper',
            source: 'inline',
            prompt: 'Helper prompt.',
          },
        },
      ],
      saves: [okSave('echo-r1')],
      // The reader leg: the server persisted the string AS TYPED (round trip).
      reads: [
        {
          status: 200,
          body: { name: 'my-helper', source: 'inline', prompt: MID_REF },
        },
      ],
    });
    const { onSaved, dlg } = await opened();
    fireEvent.change(within(dlg).getByLabelText('Prompt'), {
      target: { value: MID_REF },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save prompt' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('echo-r1'));
    const put = calls.find(
      (c) => c.method === 'PUT' && /\/prompt$/.test(c.url),
    );
    expect(put?.body).toEqual({ hash: 'hash-base-0001', prompt: MID_REF });

    // Reader leg — the persisted string renders as an inert TEXT NODE.
    render(<PromptReaderModal agentName="my-helper" onClose={vi.fn()} />);
    const reader = await screen.findByRole('dialog', {
      name: 'my-helper prompt',
    });
    const shown = within(reader).getByText(XSS, { exact: false });
    expect(shown.tagName).toBe('PRE');
    expect(shown.querySelectorAll('*').length).toBe(0);
    expect(document.querySelectorAll('script').length).toBe(0);
    expect(vi.mocked(alert)).not.toHaveBeenCalled();
  });

  it("a whole-string {file:} ref answers the server's anchored 400 in-form", async () => {
    scriptApi({
      loads: [
        {
          status: 200,
          body: { name: 'my-helper', source: 'inline', prompt: 'x' },
        },
      ],
      saves: [
        {
          status: 400,
          body: {
            ok: false,
            error: {
              code: 'file_ref_rejected',
              message:
                'A {file:…} reference prompt is never persisted — inline the text.',
            },
          },
        },
      ],
    });
    const { onSaved, dlg } = await opened();
    fireEvent.change(within(dlg).getByLabelText('Prompt'), {
      target: { value: '{file:./x.md}' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save prompt' }));
    expect(
      await within(dlg).findByText(/never persisted — inline the text/),
    ).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled(); // bytes unchanged, form retained
    expect(
      (within(dlg).getByLabelText('Prompt') as HTMLTextAreaElement).value,
    ).toBe('{file:./x.md}');
  });

  it('a pipeline-role save rides the lockstep endpoint — one PUT, success re-baselines', async () => {
    scriptApi({
      loads: [
        {
          status: 200,
          body: {
            name: 'mypl-build',
            source: 'inline',
            prompt: 'Build prompt.',
          },
        },
      ],
      saves: [okSave('echo-lock')],
    });
    const { onSaved, dlg } = await opened({ agentName: 'mypl-build' });
    fireEvent.change(within(dlg).getByLabelText('Prompt'), {
      target: { value: 'Updated build prompt.' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save prompt' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('echo-lock'));
    // The def side is server-composed (AP-4); the client sends one PUT body.
  });

  it('stale hash → 409 conflict; bytes unchanged, form data retained, Overwrite retries fresh', async () => {
    const fresh = { hash: 'hash-external-9' };
    const { calls } = scriptApi({
      loads: [
        {
          status: 200,
          body: { name: 'my-helper', source: 'inline', prompt: 'x' },
        },
      ],
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
    const { onSaved, dlg } = await opened();
    fireEvent.change(within(dlg).getByLabelText('Prompt'), {
      target: { value: 'Edited while stale.' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save prompt' }));
    const conflict = await screen.findByRole('dialog', {
      name: 'Config conflict',
    });
    expect(within(conflict).getByText('agent.my-helper.prompt')).toBeTruthy();
    // No second write until the user decides; the editor keeps the text.
    expect(calls.filter((c) => c.method === 'PUT').length).toBe(1);
    expect(
      (within(dlg).getByLabelText('Prompt') as HTMLTextAreaElement).value,
    ).toBe('Edited while stale.');
    fireEvent.click(
      within(conflict).getByRole('button', { name: 'Overwrite' }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('echo-9'));
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.length).toBe(2);
    expect(puts[1].body).toEqual({
      hash: 'hash-external-9',
      prompt: 'Edited while stale.',
    });
  });
});

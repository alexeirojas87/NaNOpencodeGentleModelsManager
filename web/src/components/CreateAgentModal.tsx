// orchestration-v2 WU-B 2.3 — the "New agent" create modal (spec AC-9).
// Prompt content enters ONLY through the AT-1 presets (GET /api/templates)
// or an AT-2 clone (GET /api/agents/:name/prompt materializes `{file:…}`
// refs server-side); the preview below is READ-ONLY — the form deliberately
// ships no prompt editor (design D5), which also removes the free-text XSS
// surface entirely: every prompt string renders as a React text node, never
// dangerouslySetInnerHTML. The model picker follows D10: installed pairs +
// runtime default, with the ghost option for a clone-prefilled pair the
// server will independently re-check (AC-6). 400s route by gate code to the
// offending field (D9); a 409 rides the established ConflictModal with one
// `(new agent)` diff row (AC-7: form data survives, Overwrite retries the
// create against the fresh hash).
import { useEffect, useRef, useState } from 'react';

import type {
  AgentTemplate,
  ConfigResponse,
  CreateAgentRequest,
  MaskedProvider,
} from '../../../shared/types';
import {
  ApiError,
  createAgent,
  getAgentPrompt,
  getConfig,
  getTemplates,
} from '../api';
import { IconClose, IconPlus } from '../icons';
import { ConflictModal, type ConflictInfo } from './ConflictModal';
import { PipelineBuilderModal } from './PipelineBuilderModal';

export interface CreateAgentModalProps {
  base: ConfigResponse;
  onClose: () => void;
  /** Success: the parent closes the modal, re-reads CONFIG and shows CX-3. */
  onCreated: (freshHash: string) => void;
  /** Conflict "Reload fresh": the parent adopts the reloaded base. */
  onAdoptFresh: (fresh: ConfigResponse) => void;
}

/** D9 field routing over the POST /api/agents gate codes (design D2). */
const NAME_CODES = new Set(['name_invalid', 'reserved_name', 'agent_exists']);
const PROMPT_CODES = new Set([
  'prompt_required',
  'prompt_invalid',
  'file_ref_rejected',
  'prompt_too_large',
]);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** D10/OA-2 installed pairs — provider ids × declared model ids. */
function installedPairs(providers: Record<string, MaskedProvider>): string[] {
  const pairs: string[] = [];
  for (const [id, entry] of Object.entries(providers)) {
    for (const modelId of Object.keys(entry.models ?? {})) {
      pairs.push(`${id}/${modelId}`);
    }
  }
  return pairs;
}

export function CreateAgentModal({
  base,
  onClose,
  onCreated,
  onAdoptFresh,
}: CreateAgentModalProps) {
  // AC-9' (agent-pipelines WU-3a task 3a.4): the modal offers both shapes.
  // SINGLE is the default — the whole pre-pipeline surface (D5 read-only
  // preview, zero textareas, one presets fetch) renders unchanged beneath it.
  const [mode, setMode] = useState<'single' | 'pipeline'>('single');
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [promptError, setPromptError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  // Clone materialization is async; a newer selection must win the race.
  const cloneSeq = useRef(0);
  const pairs = installedPairs(base.providers);

  useEffect(() => {
    let active = true;
    getTemplates()
      .then((res) => {
        if (active) setTemplates(res.templates);
      })
      .catch((err) => {
        if (active) setTemplateError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, []);

  function chooseSource(next: string) {
    setSource(next);
    setPrompt('');
    setPromptError(null);
    const seq = ++cloneSeq.current;
    if (next.startsWith('template:')) {
      const picked = templates.find((t) => `template:${t.id}` === next);
      setPrompt(picked?.prompt ?? '');
      return;
    }
    if (!next.startsWith('clone:')) return;
    const src = next.slice('clone:'.length);
    // D10: a clone prefills the source's model; an uninstalled pair stays
    // visible via the ghost rule and the server re-checks it (AC-6).
    const declared = base.agents[src]?.model;
    setModel(typeof declared === 'string' ? declared : '');
    getAgentPrompt(src)
      .then((res) => {
        if (seq === cloneSeq.current) setPrompt(res.prompt);
      })
      .catch((err) => {
        // AT-3/AT-2 fail-closed: an unresolvable/oversized source blocks
        // the create — the reason surfaces in the preview area.
        if (seq === cloneSeq.current) setPromptError(errorMessage(err));
      });
  }

  async function submit(hash: string) {
    setBusy(true);
    setNameError(null);
    setModelError(null);
    setPromptError(null);
    setGeneralError(null);
    const entry: CreateAgentRequest['agent'] = { prompt };
    if (model !== '') entry.model = model;
    if (description.trim() !== '') entry.description = description.trim();
    try {
      const res = await createAgent({ hash, name: name.trim(), agent: entry });
      onCreated(res.hash); // AC-7: the echoed fresh hash re-baselines the view
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // D9: the established conflict flow, create-shaped diff row below.
        let fresh: ConfigResponse | null = null;
        try {
          fresh = await getConfig();
        } catch {
          // The diff degrades to "no fresh copy" if the reload fails too.
        }
        setConflict({
          message: err.message,
          expected:
            typeof err.detail.expected === 'string'
              ? err.detail.expected
              : hash,
          actual:
            typeof err.detail.actual === 'string' ? err.detail.actual : '',
          fresh,
        });
      } else if (err instanceof ApiError) {
        if (NAME_CODES.has(err.code)) setNameError(err.message);
        else if (err.code === 'model_unknown') setModelError(err.message);
        else if (PROMPT_CODES.has(err.code)) setPromptError(err.message);
        else setGeneralError(err.message); // unknown_field, bad_request, …
      } else {
        setGeneralError('The create request failed unexpectedly.');
      }
    } finally {
      setBusy(false);
    }
  }

  // AC-9': pipeline shape — the builder replaces this dialog body entirely
  // (one dialog on screen; the builder's own toggle switches back).
  if (mode === 'pipeline') {
    return (
      <PipelineBuilderModal
        base={base}
        onClose={onClose}
        onSaved={onCreated}
        onAdoptFresh={onAdoptFresh}
        onSwitchToSingle={() => setMode('single')}
      />
    );
  }

  return (
    <div className="overlay">
      <form
        className="modal create-form"
        role="dialog"
        aria-label="New agent"
        aria-modal="true"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(base.hash);
        }}
      >
        <h2>New agent</h2>
        <div className="field" role="radiogroup" aria-label="Create as">
          <label>
            <input
              type="radio"
              name="create-mode"
              value="single"
              defaultChecked
              readOnly
            />
            Single agent
          </label>
          <label>
            <input
              type="radio"
              name="create-mode"
              value="pipeline"
              onChange={() => setMode('pipeline')}
            />
            Pipeline
          </label>
        </div>
        <p className="modal-note">
          Prompts are fixed at creation and never rewritten here (OA-4): pick a
          template or clone an existing agent to set the preview below.
        </p>
        <div className="field">
          <label htmlFor="create-name">Name</label>
          <input
            id="create-name"
            className="mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {nameError && (
            <p className="field-error" role="alert">
              {nameError}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="create-description">Description</label>
          <input
            id="create-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="create-model">Model</label>
          <select
            id="create-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">runtime default</option>
            {model !== '' && !pairs.includes(model) && (
              <option value={model}>{model}</option>
            )}
            {pairs.map((pair) => (
              <option key={pair} value={pair}>
                {pair}
              </option>
            ))}
          </select>
          {modelError && (
            <p className="field-error" role="alert">
              {modelError}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="create-source">Prompt source</label>
          <select
            id="create-source"
            value={source}
            onChange={(e) => chooseSource(e.target.value)}
          >
            <option value="">— choose a template or an agent to clone —</option>
            <optgroup label="Templates">
              {templates.map((t) => (
                <option key={t.id} value={`template:${t.id}`}>
                  {t.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Clone from existing">
              {Object.keys(base.agents).map((agentName) => (
                <option key={agentName} value={`clone:${agentName}`}>
                  {agentName}
                </option>
              ))}
            </optgroup>
          </select>
          {templateError && (
            <p className="field-error" role="alert">
              {templateError}
            </p>
          )}
        </div>
        <div className="field">
          <label>Prompt preview</label>
          <section className="prompt-area" aria-label="Prompt preview">
            {prompt === '' ? (
              <p className="muted">
                Nothing selected yet — this read-only preview is not editable;
                the prompt can only come from a template or a clone.
              </p>
            ) : (
              /* Text child only: prompt content is data, never markup (XSS). */
              <pre className="prompt-preview">{prompt}</pre>
            )}
            {promptError && (
              <p className="field-error" role="alert">
                {promptError}
              </p>
            )}
          </section>
        </div>
        {generalError && (
          <p className="field-error" role="alert">
            {generalError}
          </p>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
          >
            <IconClose /> Close
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={
              busy || conflict !== null || name.trim() === '' || prompt === ''
            }
          >
            <IconPlus /> Create
          </button>
        </div>
      </form>
      {conflict && (
        <ConflictModal
          info={conflict}
          rows={[
            {
              path: `agent.${name.trim()}`,
              pending: '(new agent)',
              current: '— absent',
            },
          ]}
          busy={busy}
          onReload={() => {
            if (conflict.fresh) onAdoptFresh(conflict.fresh);
            setConflict(null);
          }}
          onOverwrite={() => {
            const target = conflict.fresh;
            setConflict(null);
            void submit(target ? target.hash : base.hash);
          }}
        />
      )}
    </div>
  );
}

// agent-pipelines WU-3a/3b (AP-9, design §Web UI) — the pipeline builder.
// One component for CREATE and EDIT: the view passes `editing` (name + the
// definition from GET /api/agent-pipelines, the read surface chosen in
// apply-progress 479-deviation-1) and the same card model prefills. Submit
// posts exactly one {hash, pipeline} batch (AC-9') — mode/hidden/permission
// are NEVER client input (AC-4', server-generated per AP-2).
//
// XSS posture (threat matrix "XSS — inert"): every user string lands in a
// controlled input value or a React TEXT CHILD (the preview <pre> nodes) —
// dangerouslySetInnerHTML appears nowhere, so `<script>` payloads are data
// end to end: editor → persisted string → preview/reader text node. The
// preview renders from shared/pipeline-prompt.ts — the SAME generator the
// server materializes with — so what is previewed is byte-identical to what
// is stored (AP-3 parity).
//
// 400 routing (D9 generalized, AC-9'): gate codes carrying a `roles[i]` path
// or a quoted member name land on that card's field; a 409 rides the
// established ConflictModal; the modal only closes on success.
import { useEffect, useRef, useState } from 'react';

import type {
  AgentTemplate,
  ConfigResponse,
  PipelineDefinition,
  PipelineOrchestratorDef,
  PipelineRoleDef,
  PipelineSubmitRequest,
} from '../../../shared/types';
import {
  buildOrchestratorPrompt,
  buildTaskPermissionMap,
} from '../../../shared/pipeline-prompt';
import {
  ApiError,
  createPipeline,
  getAgentPrompt,
  getConfig,
  getTemplates,
  updatePipeline,
} from '../api';
import { IconClose, IconPlus } from '../icons';
import { ConflictModal, type ConflictInfo } from './ConflictModal';

/** AC-9' create|edit toggle host wiring: render the mode radios when given. */
export interface PipelineBuilderModalProps {
  base: ConfigResponse;
  /** Edit mode: prefill from this stored definition (AP-4 edit path). */
  editing?: { name: string; definition: PipelineDefinition } | null;
  onClose: () => void;
  /** Success: parent closes, re-reads CONFIG + definitions, shows CX-3 once. */
  onSaved: (freshHash: string) => void;
  /** Conflict "Reload fresh": the parent adopts the reloaded base. */
  onAdoptFresh: (fresh: ConfigResponse) => void;
  /** Create-flow toggle (CreateAgentModal only): switch back to single shape. */
  onSwitchToSingle?: () => void;
}

/** Draft card state — the builder's working copy of one role. */
interface RoleDraft {
  name: string;
  model: string; // '' = absent (invoker inheritance, C-R1e)
  description: string;
  promptSource: PipelineRoleDef['promptSource'];
  prompt: string;
  /** Clone/template materialization note surfaced in-card (AT-3). */
  resolveError: string | null;
}

const emptyRole = (): RoleDraft => ({
  name: '',
  model: '',
  description: '',
  promptSource: 'template',
  prompt: '',
  resolveError: null,
});

function roleFromDef(r: PipelineRoleDef): RoleDraft {
  return {
    name: r.name,
    model: typeof r.model === 'string' ? r.model : '',
    description: r.description ?? '',
    promptSource: r.promptSource,
    prompt: r.prompt,
    resolveError: null,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function installedPairs(base: ConfigResponse): string[] {
  const pairs: string[] = [];
  for (const [id, entry] of Object.entries(base.providers)) {
    for (const modelId of Object.keys(entry.models ?? {})) {
      pairs.push(`${id}/${modelId}`);
    }
  }
  return pairs;
}

export function PipelineBuilderModal({
  base,
  editing = null,
  onClose,
  onSaved,
  onAdoptFresh,
  onSwitchToSingle,
}: PipelineBuilderModalProps) {
  const [name, setName] = useState(editing?.name ?? '');
  const [roles, setRoles] = useState<RoleDraft[]>(
    editing ? editing.definition.roles.map(roleFromDef) : [emptyRole()],
  );
  const [orchDescription, setOrchDescription] = useState(
    editing?.definition.orchestrator.description ?? '',
  );
  const [orchModel, setOrchModel] = useState(
    typeof editing?.definition.orchestrator.model === 'string'
      ? (editing?.definition.orchestrator.model as string)
      : '',
  );
  const [helpers, setHelpers] = useState<string[]>(
    editing?.definition.helpers ?? [],
  );
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [helperChoice, setHelperChoice] = useState('');
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  // Per-card error slots keyed by card index (recomputed each submit).
  const [cardErrors, setCardErrors] = useState<
    Record<number, { name?: string; model?: string }>
  >({});
  const cloneSeq = useRef(0);
  const pairs = installedPairs(base);
  const memberNames = new Set(roles.map((r) => r.name).filter(Boolean));
  const helperCandidates = Object.keys(base.agents).filter(
    (agent) =>
      agent !== name && !memberNames.has(agent) && !helpers.includes(agent),
  );

  useEffect(() => {
    let active = true;
    getTemplates()
      .then((res) => {
        if (active) setTemplates(res.templates);
      })
      .catch(() => {
        // Template picker degrades to empty; free-text/clone still work.
      });
    return () => {
      active = false;
    };
  }, []);

  function patchRole(i: number, patch: Partial<RoleDraft>) {
    setRoles((prev) => prev.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  }

  /** AT-2: a clone selection materializes the SOURCE prompt text into the
   * card's editor — the persisted def value is always resolved literal text. */
  function chooseClone(i: number, source: string) {
    patchRole(i, { promptSource: 'clone', resolveError: null });
    if (source === '') return;
    const seq = ++cloneSeq.current;
    const owner = i;
    getAgentPrompt(source)
      .then((res) => {
        if (cloneSeq.current !== seq) return;
        setRoles((prev) =>
          prev.map((r, k) =>
            k === owner
              ? {
                  ...r,
                  prompt: res.prompt,
                  resolveError: null,
                  name: r.name || `${source}`,
                }
              : r,
          ),
        );
      })
      .catch((err) => {
        if (cloneSeq.current !== seq) return;
        patchRole(owner, { resolveError: errorMessage(err) });
      });
  }

  function chooseTemplate(i: number, templateId: string) {
    const picked = templates.find((t) => t.id === templateId);
    patchRole(i, {
      promptSource: 'template',
      prompt: picked?.prompt ?? '',
      resolveError: null,
    });
  }

  const generated = {
    prompt: buildOrchestratorPrompt({
      pipeline: name === '' ? '(pipeline)' : name,
      roles: roles.map((r) => ({
        name: r.name,
        description: r.description,
        ...(r.model !== '' ? { model: r.model } : {}),
      })),
      helpers,
    }),
    taskMap: buildTaskPermissionMap(
      roles.map((r) => r.name).filter(Boolean),
      helpers,
    ),
  };

  const canSubmit =
    name.trim() !== '' &&
    roles.length > 0 &&
    roles.every((r) => r.name.trim() !== '' && r.prompt !== '');

  /** AC-9' D9 routing: a `roles[i]` path marker or a quoted member name that
   * matches exactly one card lands there; everything else is general/name. */
  function route400(err: ApiError) {
    const haystack = `${err.message} ${JSON.stringify(err.detail)}`;
    const pathHit = /roles[.[](\d+)[.\]]/.exec(haystack);
    const quoted = /"([^"]+)"/.exec(err.message);
    const cardIndex = (() => {
      if (pathHit !== null) return Number(pathHit[1]);
      if (quoted !== null) {
        const i = roles.findIndex((r) => r.name === quoted[1]);
        if (i >= 0) return i;
      }
      return null;
    })();
    const setCard = (i: number, slot: 'name' | 'model', msg: string) =>
      setCardErrors((p) => ({ ...p, [i]: { ...p[i], [slot]: msg } }));
    switch (err.code) {
      case 'model_unknown':
        if (cardIndex !== null) setCard(cardIndex, 'model', err.message);
        else setGeneralError(err.message);
        return;
      case 'pipeline_exists':
        setNameError(err.message);
        return;
      case 'name_invalid':
      case 'reserved_name':
      case 'agent_exists':
      case 'duplicate_name':
      case 'pipeline_owned':
        if (cardIndex !== null) setCard(cardIndex, 'name', err.message);
        else setNameError(err.message);
        return;
      case 'invalid_shape':
      case 'invalid': {
        const detail =
          typeof err.detail.detail === 'string' ? err.detail.detail : '';
        const issues = Array.isArray(err.detail.issues)
          ? (err.detail.issues as { path?: unknown; message?: unknown }[])
              .map((i) => `${String(i.path ?? '')}: ${String(i.message ?? '')}`)
              .join(' · ')
          : '';
        const extra = detail || issues;
        setGeneralError(extra ? `${err.message} ${extra}` : err.message);
        return;
      }
      default:
        setGeneralError(err.message); // unknown_field, bad_request, …
    }
  }

  async function submit(hash: string) {
    setBusy(true);
    setGeneralError(null);
    setNameError(null);
    setCardErrors({});
    const pipeline: PipelineSubmitRequest['pipeline'] = {
      name: name.trim(),
      orchestrator: {
        ...(orchModel !== '' ? { model: orchModel } : {}),
        description: orchDescription,
      } as PipelineOrchestratorDef,
      roles: roles.map((r) => ({
        name: r.name.trim(),
        ...(r.model !== '' ? { model: r.model } : {}),
        description: r.description,
        promptSource: r.promptSource,
        prompt: r.prompt,
      })),
    };
    if (helpers.length > 0) pipeline.helpers = helpers;
    try {
      const res = editing
        ? await updatePipeline(editing.name, { hash, pipeline })
        : await createPipeline({ hash, pipeline });
      onSaved(res.hash); // success closes; the parent reloads and shows CX-3
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        let fresh: ConfigResponse | null = null;
        try {
          fresh = await getConfig();
        } catch {
          // The diff degrades to "no fresh copy" when the reload fails too.
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
        route400(err); // modal stays open, form data retained (AC-9')
      } else {
        setGeneralError('The pipeline save failed unexpectedly.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay">
      <form
        className="modal create-form pipeline-builder"
        role="dialog"
        aria-label="Pipeline builder"
        aria-modal="true"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(base.hash);
        }}
      >
        <h2>
          {editing ? `Edit pipeline ${editing.name}` : 'Pipeline builder'}
        </h2>
        <p className="modal-note">
          Rows materialize atomically in ONE save (AP-2): the orchestrator and
          every role row generate their <code className="mono">mode</code>,{' '}
          <code className="mono">hidden</code> and delegation map server-side —
          this form never sends them (AC-4').
        </p>
        {onSwitchToSingle !== undefined && (
          <div className="field" role="radiogroup" aria-label="Create as">
            <label>
              <input
                type="radio"
                name="create-mode"
                value="single"
                onChange={() => onSwitchToSingle?.()}
              />
              Single agent
            </label>
            <label>
              <input
                type="radio"
                name="create-mode"
                value="pipeline"
                defaultChecked
                readOnly
              />
              Pipeline
            </label>
          </div>
        )}
        <div className="field">
          <label htmlFor="pipeline-name">Pipeline name</label>
          <input
            id="pipeline-name"
            className="mono"
            value={name}
            disabled={editing !== null}
            onChange={(e) => setName(e.target.value)}
          />
          {nameError && (
            <p className="field-error" role="alert">
              {nameError}
            </p>
          )}
          {editing !== null && (
            <p className="muted">
              The orchestrator row is named by the pipeline key — rename means
              create + delete.
            </p>
          )}
        </div>
        {roles.map((role, i) => (
          <fieldset
            key={i}
            aria-label={`Role ${i + 1}`}
            className="field role-card"
          >
            <legend className="mono">Role {i + 1}</legend>
            <div className="field">
              <label htmlFor={`role-${i}-name`}>Role {i + 1} name</label>
              <input
                id={`role-${i}-name`}
                className="mono"
                value={role.name}
                onChange={(e) => patchRole(i, { name: e.target.value })}
              />
              {cardErrors[i]?.name && (
                <p className="field-error" role="alert">
                  {cardErrors[i]?.name}
                </p>
              )}
            </div>
            <div className="field">
              <label htmlFor={`role-${i}-desc`}>Role {i + 1} description</label>
              <input
                id={`role-${i}-desc`}
                value={role.description}
                onChange={(e) => patchRole(i, { description: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={`role-${i}-model`}>Role {i + 1} model</label>
              <select
                id={`role-${i}-model`}
                value={role.model}
                onChange={(e) => patchRole(i, { model: e.target.value })}
              >
                <option value="">runtime default</option>
                {role.model !== '' && !pairs.includes(role.model) && (
                  <option value={role.model}>{role.model}</option>
                )}
                {pairs.map((pair) => (
                  <option key={pair} value={pair}>
                    {pair}
                  </option>
                ))}
              </select>
              {cardErrors[i]?.model && (
                <p className="field-error" role="alert">
                  {cardErrors[i]?.model}
                </p>
              )}
            </div>
            <div
              className="field"
              role="radiogroup"
              aria-label={`Role ${i + 1} prompt source`}
            >
              {(
                [
                  ['template', 'template'],
                  ['clone', 'clone'],
                  ['free-text', 'free-text'],
                ] as const
              ).map(([value, text]) => (
                <label key={value}>
                  <input
                    type="radio"
                    name={`role-${i}-source`}
                    value={value}
                    checked={role.promptSource === value}
                    onChange={() => {
                      if (value === 'free-text')
                        patchRole(i, {
                          promptSource: 'free-text',
                          resolveError: null,
                        });
                      else if (value === 'template')
                        patchRole(i, {
                          promptSource: 'template',
                          resolveError: null,
                        });
                      else
                        patchRole(i, {
                          promptSource: 'clone',
                          resolveError: null,
                        });
                    }}
                  />
                  {text}
                </label>
              ))}
            </div>
            {role.promptSource === 'template' && (
              <div className="field">
                <label htmlFor={`role-${i}-template`}>Template</label>
                <select
                  id={`role-${i}-template`}
                  value={
                    templates.some((t) => t.prompt === role.prompt)
                      ? (templates.find((t) => t.prompt === role.prompt)?.id ??
                        '')
                      : ''
                  }
                  onChange={(e) => chooseTemplate(i, e.target.value)}
                >
                  <option value="">— choose a template —</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {role.promptSource === 'clone' && (
              <div className="field">
                <label htmlFor={`role-${i}-clone`}>Clone source</label>
                <select
                  id={`role-${i}-clone`}
                  value=""
                  onChange={(e) => chooseClone(i, e.target.value)}
                >
                  <option value="">— choose an agent to clone —</option>
                  {Object.keys(base.agents).map((agentName) => (
                    <option key={agentName} value={agentName}>
                      {agentName}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor={`role-${i}-prompt`}>Role {i + 1} prompt</label>
              {/* Controlled textarea: the value is data, never markup. */}
              <textarea
                id={`role-${i}-prompt`}
                rows={4}
                value={role.prompt}
                onChange={(e) => patchRole(i, { prompt: e.target.value })}
              />
              {role.resolveError && (
                <p className="field-error" role="alert">
                  {role.resolveError}
                </p>
              )}
            </div>
            {roles.length > 1 && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setRoles((prev) => prev.filter((_, k) => k !== i))
                }
              >
                Remove role
              </button>
            )}
          </fieldset>
        ))}
        <div className="modal-actions">
          <button
            type="button"
            className="btn"
            onClick={() => setRoles((prev) => [...prev, emptyRole()])}
          >
            <IconPlus /> Add role
          </button>
        </div>
        <div className="field">
          <label htmlFor="orch-desc">Orchestrator description</label>
          <input
            id="orch-desc"
            value={orchDescription}
            onChange={(e) => setOrchDescription(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="orch-model">Orchestrator model</label>
          <select
            id="orch-model"
            value={orchModel}
            onChange={(e) => setOrchModel(e.target.value)}
          >
            <option value="">runtime default</option>
            {orchModel !== '' && !pairs.includes(orchModel) && (
              <option value={orchModel}>{orchModel}</option>
            )}
            {pairs.map((pair) => (
              <option key={pair} value={pair}>
                {pair}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="helper-add">Helper to add</label>
          <select
            id="helper-add"
            value={helperChoice}
            onChange={(e) => setHelperChoice(e.target.value)}
          >
            <option value="">— choose an existing agent —</option>
            {helperCandidates.map((agentName) => (
              <option key={agentName} value={agentName}>
                {agentName}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={helperChoice === ''}
            onClick={() => {
              if (helperChoice !== '' && !helpers.includes(helperChoice))
                setHelpers((prev) => [...prev, helperChoice]);
              setHelperChoice('');
            }}
          >
            Add helper
          </button>
          {helpers.map((helper) => (
            <span key={helper} className="chip">
              <span className="mono">{helper}</span>{' '}
              <button
                type="button"
                className="btn"
                onClick={() =>
                  setHelpers((prev) => prev.filter((h) => h !== helper))
                }
              >
                Remove helper {helper}
              </button>
            </span>
          ))}
        </div>
        <div className="field">
          <label>Generated orchestrator prompt</label>
          <section
            className="prompt-area"
            aria-label="Orchestrator prompt preview"
          >
            {/* Text child only — prompt content is data, never markup (XSS). */}
            <pre className="prompt-preview">{generated.prompt}</pre>
          </section>
          <label>Generated delegation map</label>
          <section className="prompt-area" aria-label="Delegation task map">
            {/* Deny-star first is load-bearing under C-R1f — preview pins it. */}
            <pre className="prompt-preview">
              {JSON.stringify(generated.taskMap, null, 2)}
            </pre>
          </section>
          <p className="muted">
            Preview is generated by the same shared module the server saves with
            — byte-identical to the stored orchestrator row (AP-3).
          </p>
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
            disabled={busy || conflict !== null || !canSubmit}
          >
            <IconPlus /> {editing ? 'Save pipeline' : 'Create pipeline'}
          </button>
        </div>
      </form>
      {conflict && (
        <ConflictModal
          info={conflict}
          rows={[
            {
              path: `agent-pipelines.${name.trim()}`,
              pending: '(pipeline batch)',
              current: editing ? '(stored definition)' : '— absent',
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

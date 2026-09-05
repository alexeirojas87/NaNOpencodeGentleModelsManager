// WU8.2 — the Orchestration view (design §UI). Two generic renderings of
// CONFIG's `agent.*` set, both derived from the GET /api/config response
// keys (0..N — never a hardcoded name list, OA-1/PC-4):
//   1. a phase matrix: families whose base agent exists alongside a
//      -cheap/-deep variant get one row with base/-cheap/-deep cells;
//   2. everything else (non-sdd agents and orphan -cheap/-deep variants
//      without a base) renders as list rows.
// Each cell/row edits ONLY `agent.<name>.model` through
// PUT /api/agents/:name/model (set = "provider/model", clear = null →
// "runtime default"), the picker offers only the installed
// provider/model pairs present in the response (OA-2), and prompt bodies
// plus gentle-ai:* markers render read-only (OA-4). Saves chain echoed
// hashes and surface 409/400 exactly like the Providers/Models views
// (SCW-2/SCW-3); success shows the CX-3 restart notice plus the OA-3
// advisory to run gentle-ai sync (the endpoint itself ships with WU9).
import { useCallback, useEffect, useState } from 'react';

import type {
  AgentConfigEntry,
  ConfigResponse,
  MaskedProvider,
  PipelineDefinition,
} from '../../../shared/types';
import {
  ApiError,
  deleteAgent,
  deletePipeline,
  getConfig,
  getPipelines,
  putAgentModel,
  setDefaultAgent,
} from '../api';
import { isUserOwned } from '../client-ownership';
import { IconFileText, IconList, IconPlus } from '../icons';
import {
  ConflictModal,
  type ConflictInfo,
  type ConflictRow,
} from '../components/ConflictModal';
import { CreateAgentModal } from '../components/CreateAgentModal';
import { PipelineBuilderModal } from '../components/PipelineBuilderModal';
import { PromptEditorModal } from '../components/PromptEditorModal';
import { PromptReaderModal } from '../components/PromptReaderModal';
import { SaveBar } from '../components/SaveBar';
import { SyncPanel } from '../components/SyncPanel';

/** Pending user choice per agent: string = set, null = clear, absent = untouched. */
type Edits = Record<string, string | null>;

type Column = 'base' | 'cheap' | 'deep';
const COLUMNS: Column[] = ['base', 'cheap', 'deep'];
const VARIANT_SUFFIXES: Array<[string, Column]> = [
  ['-cheap', 'cheap'],
  ['-deep', 'deep'],
];

/** Purely structural name split — no agent names are known to this module. */
function splitVariant(name: string): { family: string; column: Column } {
  for (const [suffix, column] of VARIANT_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return { family: name.slice(0, -suffix.length), column };
    }
  }
  return { family: name, column: 'base' };
}

interface FamilyRow {
  family: string;
  cells: Partial<Record<Column, string>>;
}

/**
 * Group agent names: a family forms a matrix row only when its base agent
 * exists AND carries at least one -cheap/-deep sibling; every other agent
 * (solo bases, orphan variants) lands in the plain list. Encounter order
 * of the config response is preserved (0..N, nothing curated).
 */
function groupAgents(names: string[]): { rows: FamilyRow[]; others: string[] } {
  const families = new Map<string, Partial<Record<Column, string>>>();
  for (const name of names) {
    const { family, column } = splitVariant(name);
    const cells = families.get(family) ?? {};
    if (!cells[column]) cells[column] = name;
    families.set(family, cells);
  }
  const rows: FamilyRow[] = [];
  const others: string[] = [];
  for (const [family, cells] of families) {
    if (cells.base && (cells.cheap || cells.deep)) {
      rows.push({ family, cells });
    } else {
      for (const column of COLUMNS) {
        const name = cells[column];
        if (name) others.push(name);
      }
    }
  }
  return { rows, others };
}

/** `<provider>/<model-id>` pairs declared in the SAME config response (OA-2). */
function installedPairs(providers: Record<string, MaskedProvider>): string[] {
  const pairs: string[] = [];
  for (const [id, entry] of Object.entries(providers)) {
    for (const modelId of Object.keys(entry.models ?? {})) {
      pairs.push(`${id}/${modelId}`);
    }
  }
  return pairs;
}

function declaredModel(entry: AgentConfigEntry | undefined): string | null {
  return typeof entry?.model === 'string' ? entry.model : null;
}

/** Dirty set: edits that actually differ from the current base (per agent). */
function pendingWrites(
  base: ConfigResponse,
  edits: Edits,
): Record<string, string | null> {
  const pending: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(edits)) {
    const entry = base.agents[name];
    if (!entry) continue; // agent vanished from the base — nothing to address
    if (value !== declaredModel(entry)) pending[name] = value;
  }
  return pending;
}

/** Optimistically fold a committed model write into the local masked copy. */
function applyWrite(
  base: ConfigResponse,
  name: string,
  value: string | null,
  nextHash: string,
): ConfigResponse {
  const entry = { ...base.agents[name] };
  if (value === null) delete entry.model;
  else entry.model = value;
  return {
    ...base,
    hash: nextHash,
    agents: { ...base.agents, [name]: entry },
  };
}

/** Diff rows for the conflict modal: pending model edits vs the fresh copy. */
function conflictRows(fresh: ConfigResponse, edits: Edits): ConflictRow[] {
  const rows: ConflictRow[] = [];
  for (const [name, value] of Object.entries(pendingWrites(fresh, edits))) {
    const current = declaredModel(fresh.agents[name]);
    rows.push({
      path: `agent.${name}.model`,
      pending: value ?? '(clear → runtime default)',
      current: current ?? 'runtime default',
    });
  }
  return rows;
}

type SaveOutcome =
  | { kind: 'ok'; base: ConfigResponse }
  | { kind: 'invalid'; base: ConfigResponse; message: string }
  | { kind: 'stale'; base: ConfigResponse; conflict: ConflictInfo };

/**
 * Sequentially PUT the pending model edits against `startBase`, adopting
 * every echoed hash (SCW-2). A 409 aborts the chain, reloads for the
 * conflict diff and keeps the remaining edits pending; a 400 surfaces its
 * per-path issues without discarding anything.
 */
async function runSave(
  startBase: ConfigResponse,
  edits: Edits,
): Promise<SaveOutcome> {
  let work = startBase;
  for (const [name, value] of Object.entries(pendingWrites(work, edits))) {
    try {
      const result = await putAgentModel(name, work.hash, value);
      work = applyWrite(work, name, value, result.hash);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        let fresh: ConfigResponse | null = null;
        try {
          fresh = await getConfig();
        } catch {
          // Diff columns degrade to "unavailable" when the reload fails too.
        }
        return {
          kind: 'stale',
          base: work,
          conflict: {
            message: err.message,
            expected:
              typeof err.detail.expected === 'string'
                ? err.detail.expected
                : work.hash,
            actual:
              typeof err.detail.actual === 'string' ? err.detail.actual : '',
            fresh,
          },
        };
      }
      if (err instanceof ApiError) {
        const issues = Array.isArray(err.detail.issues)
          ? err.detail.issues
          : [];
        const detail = issues
          .filter(
            (issue): issue is { path?: unknown; message?: unknown } =>
              typeof issue === 'object' && issue !== null,
          )
          .map((issue) => `${String(issue.path)}: ${String(issue.message)}`)
          .join(' · ');
        return {
          kind: 'invalid',
          base: work,
          message: detail ? `${err.message} ${detail}` : err.message,
        };
      }
      return {
        kind: 'invalid',
        base: work,
        message: 'The save request failed unexpectedly.',
      };
    }
  }
  return { kind: 'ok', base: work };
}

/** Model picker: runtime default + installed pairs (+ ghost for stale values). */
function ModelPicker({
  agentName,
  value,
  pairs,
  onChange,
  disabled = false,
}: {
  agentName: string;
  value: string;
  pairs: string[];
  onChange: (value: string) => void;
  /** AP-4: pipeline members are edited in the builder — cells disabled. */
  disabled?: boolean;
}) {
  const ghost = value !== '' && !pairs.includes(value);
  return (
    <select
      aria-label={`${agentName} model`}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">runtime default</option>
      {ghost && <option value={value}>{value}</option>}
      {pairs.map((pair) => (
        <option key={pair} value={pair}>
          {pair}
        </option>
      ))}
    </select>
  );
}

/**
 * Cell surface (OA-4, design D8 — WU-B): picker-only cell plus a
 * "view prompt" trigger and gentle-ai:* marker chips. The prompt body NEVER
 * renders inside the cell (the full text lives in the read-only
 * PromptReaderModal, fetched fresh from the server — inline or {file:}
 * materialized), and markers show their key name as a labeled read-only
 * chip only — values never enter the DOM. No write ever carries either.
 */
function PromptCell({
  agentName,
  entry,
  onRead,
  onEdit,
  deletable,
  onDelete,
}: {
  agentName: string;
  entry: AgentConfigEntry;
  onRead: (name: string) => void;
  /** OA-4': user-owned names also get the editor (undefined ⇒ never). */
  onEdit?: (name: string) => void;
  /** SCW-7' d / AP-6: danger delete only on user-owned standalone rows. */
  deletable?: boolean;
  onDelete?: (name: string) => void;
}) {
  const hasPrompt = typeof entry.prompt === 'string' && entry.prompt.length > 0;
  const markers = Object.keys(entry).filter((key) =>
    key.startsWith('gentle-ai:'),
  );
  if (!hasPrompt && markers.length === 0 && !deletable) return null;
  return (
    <div className="ro-extras">
      {hasPrompt && (
        <button type="button" className="btn" onClick={() => onRead(agentName)}>
          <IconFileText /> view prompt
        </button>
      )}
      {hasPrompt && onEdit && (
        <button type="button" className="btn" onClick={() => onEdit(agentName)}>
          <IconFileText /> edit prompt
        </button>
      )}
      {markers.map((key) => (
        <span key={key} className="chip">
          <span className="mono">{key}</span>{' '}
          <span className="ro-flag">read-only</span>
        </span>
      ))}
      {deletable && onDelete && (
        <button
          type="button"
          className="btn"
          onClick={() => onDelete(agentName)}
        >
          delete
        </button>
      )}
    </div>
  );
}

export default function OrchestrationView() {
  const [base, setBase] = useState<ConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Edits>({});
  const [busy, setBusy] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [syncAdvisory, setSyncAdvisory] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  // orchestration-v2 WU-B: the two read/write surfaces this view hosts.
  const [createOpen, setCreateOpen] = useState(false);
  const [reader, setReader] = useState<string | null>(null);
  // agent-pipelines WU-4: definitions (grouping/badge truth), the builder in
  // edit mode, the two delete confirms and the user-owned prompt editor.
  const [defs, setDefs] = useState<Record<string, PipelineDefinition>>({});
  const [builder, setBuilder] = useState<{ name: string } | null>(null);
  const [pipelineConfirm, setPipelineConfirm] = useState<string | null>(null);
  const [agentConfirm, setAgentConfirm] = useState<string | null>(null);
  const [promptEdit, setPromptEdit] = useState<string | null>(null);
  const [defaultBusy, setDefaultBusy] = useState(false);
  const [defaultError, setDefaultError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setBase(await getConfig());
      setLoadError(null);
    } catch (err) {
      // PC-1: error state only — the dashboard never creates or repairs.
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // The definitions lane is a parallel read (GET /api/agent-pipelines — the
  // read surface of apply-progress 479-deviation-1). A failure (or a server
  // predating the route) degrades to "no pipelines", never blocks the view.
  const refreshDefs = useCallback(async () => {
    try {
      setDefs((await getPipelines()).pipelines ?? {});
    } catch {
      setDefs({});
    }
  }, []);

  useEffect(() => {
    void reload();
    void refreshDefs();
  }, [reload, refreshDefs]);

  function setModel(name: string, value: string) {
    setEdits((prev) => ({ ...prev, [name]: value === '' ? null : value }));
  }

  async function commit(baseArg: ConfigResponse) {
    setBusy(true);
    setValidationError(null);
    const outcome = await runSave(baseArg, edits);
    setBase(outcome.base);
    if (outcome.kind === 'ok') {
      setEdits({});
      setRestartRequired(true);
      setSyncAdvisory(true);
    } else if (outcome.kind === 'stale') {
      setConflict(outcome.conflict);
    } else {
      setValidationError(outcome.message);
    }
    setBusy(false);
  }

  if (loadError) {
    return (
      <div role="alert" className="panel error-panel">
        <h2>Configuration unavailable</h2>
        <p>{loadError}</p>
        <button type="button" className="btn" onClick={() => void reload()}>
          Retry
        </button>
      </div>
    );
  }
  if (!base) {
    return <p className="muted">Loading configuration…</p>;
  }

  // Shared create-success handling: close, re-read CONFIG + definitions
  // (AC-9) and raise the CX-3 restart notice. The generic derivation places
  // the new agent; a pipeline create additionally gains its group.
  const agentCreated = () => {
    setCreateOpen(false);
    setRestartRequired(true);
    void reload();
    void refreshDefs();
  };
  const createModal = createOpen && (
    <CreateAgentModal
      base={base}
      onClose={() => setCreateOpen(false)}
      onCreated={agentCreated}
      onAdoptFresh={(fresh) => setBase(fresh)}
    />
  );

  const allAgentNames = Object.keys(base.agents);
  if (allAgentNames.length === 0) {
    return (
      <div className="panel">
        <div className="card-header">
          <h2>
            <span className="tile tile-green">
              <IconList />
            </span>
            Orchestration
          </h2>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setCreateOpen(true)}
          >
            <IconPlus /> Create agent
          </button>
        </div>
        <p className="muted">No agents declared</p>
        <p className="muted">
          Agent assignments appear here as soon as CONFIG declares them under
          <code> agent.*</code> — or create the first one.
        </p>
        {createModal}
      </div>
    );
  }

  // AP-9 grouping truth comes from the definitions (tolerant read — rows
  // exist even when a def carries an externally-authored shape).
  const defEntries = Object.entries(defs);
  /** Member row names per definition: orchestrator (≡ key) + roles (AP-6). */
  const membersOf = (def: PipelineDefinition): string[] => [
    ...(def && Array.isArray(def.roles) ? def.roles.map((r) => r.name) : []),
  ];
  const pipelineMembers = new Set<string>([
    ...defEntries.flatMap(([key, def]) => [key, ...membersOf(def)]),
  ]);
  /** Rows a pipeline delete will remove: orchestrator first, then roles. */
  const memberListFor = (key: string): string[] => {
    const def = defs[key];
    return def ? [key, ...membersOf(def)] : [key];
  };

  // The matrix/list render the NON-member agents only; groupAgents and
  // splitVariant stay untouched (the AP-9 pattern: a pre-filter, never a fork).
  const agentNames = allAgentNames.filter((name) => !pipelineMembers.has(name));
  const { rows, others } = groupAgents(agentNames);
  const pairs = installedPairs(base.providers);
  const changeCount = Object.keys(pendingWrites(base, edits)).length;
  const conflictTarget = conflict?.fresh ?? base;
  // AP-7 picker surface: visible primaries only — mirrors the loader's throw
  // set client-side (mode subagent / hidden; C-R1d); the server re-gates.
  const visiblePrimaries = allAgentNames.filter((name) => {
    const entry = base.agents[name];
    return entry.mode !== 'subagent' && entry.hidden !== true;
  });

  /** AP-7: action select — the placeholder never binds a pending state. */
  const applyDefaultAgent = async (value: string) => {
    if (value === '') return;
    setDefaultBusy(true);
    setDefaultError(null);
    try {
      const res = await setDefaultAgent({
        hash: base.hash,
        agent: value === '__clear__' ? null : value,
      });
      setBase((prev) =>
        prev
          ? {
              ...prev,
              hash: res.hash,
              defaultAgent: value === '__clear__' ? undefined : value,
            }
          : prev,
      );
      setRestartRequired(true); // CX-3: selection is loader-time state
    } catch (err) {
      setDefaultError(
        err instanceof ApiError
          ? err.message
          : 'The default-agent update failed unexpectedly.',
      );
    } finally {
      setDefaultBusy(false);
    }
  };

  const confirmPipelineDelete = async (key: string) => {
    setPipelineConfirm(null);
    try {
      const res = await deletePipeline(key, base.hash);
      setBase((prev) => (prev ? { ...prev, hash: res.hash } : prev));
      setRestartRequired(true);
      void reload();
      void refreshDefs();
    } catch (err) {
      setValidationError(
        err instanceof ApiError
          ? err.message
          : 'The pipeline delete request failed unexpectedly.',
      );
    }
  };

  const confirmAgentDelete = async (name: string) => {
    setAgentConfirm(null);
    try {
      const res = await deleteAgent(name, base.hash);
      setBase((prev) => (prev ? { ...prev, hash: res.hash } : prev));
      setRestartRequired(true);
      void reload();
    } catch (err) {
      setValidationError(
        err instanceof ApiError
          ? err.message
          : 'The agent delete request failed unexpectedly.',
      );
    }
  };

  const pickerNode = (agentName: string) => {
    // An explicit clear is edits[name] === null — existence, not ??, marks
    // the pending state (null is a legitimate pending value).
    const edit = agentName in edits ? (edits[agentName] ?? '') : undefined;
    const value =
      edit !== undefined ? edit : (declaredModel(base.agents[agentName]) ?? '');
    return (
      <ModelPicker
        agentName={agentName}
        value={value}
        pairs={pairs}
        onChange={(next) => setModel(agentName, next)}
      />
    );
  };

  return (
    <div className="view">
      <header className="view-header">
        <h2>
          <span className="tile tile-green">
            <IconList />
          </span>
          Orchestration
        </h2>
        <p className="muted">
          Model assignment per agent, derived from <code>agent.*</code> in
          CONFIG
          {base.defaultAgent ? (
            <>
              {' '}
              (default agent: <code className="mono">{base.defaultAgent}</code>)
            </>
          ) : null}
          . Pickers list only installed provider/model pairs; prompt bodies open
          in a read-only reader and <code className="mono">gentle-ai:*</code>{' '}
          markers stay read-only chips.
        </p>
        {/* AC-9: the create entry point — a modal, never a table mutation. */}
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setCreateOpen(true)}
        >
          <IconPlus /> Create agent
        </button>
        {/* AP-7 picker surface: offers ONLY visible primaries (+ clear).
            Action select — it returns to the placeholder after each apply. */}
        <div className="field">
          <label htmlFor="default-agent-select">Default agent</label>
          <select
            id="default-agent-select"
            aria-label="Default agent"
            value=""
            disabled={defaultBusy}
            onChange={(e) => void applyDefaultAgent(e.target.value)}
          >
            <option value="">set default agent…</option>
            <option value="__clear__">(no default — build-in fallback)</option>
            {visiblePrimaries.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {defaultError && (
            <p className="field-error" role="alert">
              {defaultError}
            </p>
          )}
        </div>
      </header>

      {restartRequired && (
        <div className="banner" role="status">
          <span>Restart OpenCode to apply</span>
          <button
            type="button"
            className="banner-dismiss"
            aria-label="Dismiss restart notice"
            onClick={() => setRestartRequired(false)}
          >
            Dismiss
          </button>
        </div>
      )}
      {syncAdvisory && (
        <div className="banner" role="status">
          <span>run gentle-ai sync to refresh prompt table</span>
          <button
            type="button"
            className="banner-dismiss"
            aria-label="Dismiss sync advisory"
            onClick={() => setSyncAdvisory(false)}
          >
            Dismiss
          </button>
        </div>
      )}

      <section className="orch-section">
        <h3>Phase matrix</h3>
        <table className="orch-table" aria-label="Phase model assignments">
          <thead>
            <tr>
              <th>Phase</th>
              {COLUMNS.map((column) => (
                <th key={column}>
                  {column === 'base' ? 'base' : `-${column}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.family} aria-label={row.family}>
                <th className="mono" scope="row">
                  {row.family}
                </th>
                {COLUMNS.map((column) => {
                  const name = row.cells[column];
                  return (
                    <td
                      key={column}
                      className={name ? undefined : 'cell-absent'}
                    >
                      {name ? (
                        <>
                          {pickerNode(name)}
                          <PromptCell
                            agentName={name}
                            entry={base.agents[name]}
                            onRead={setReader}
                            onEdit={
                              isUserOwned(name) ? setPromptEdit : undefined
                            }
                            deletable={isUserOwned(name)}
                            onDelete={setAgentConfirm}
                          />
                        </>
                      ) : (
                        <span>agent absent</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* agent-pipelines AP-9: members grouped under their definition key.
          Generic edit cells are DISABLED (AP-4 — the builder is the edit
          path); the badge marks pipeline membership (AP-6). */}
      {defEntries.length > 0 && (
        <section className="orch-section">
          <h3>Pipelines</h3>
          {defEntries.map(([key, def]) => {
            const memberRows = [key, ...membersOf(def)];
            return (
              <div key={key} className="panel">
                <div className="card-header">
                  <h4 className="mono">{key}</h4>
                  <span>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setBuilder({ name: key })}
                    >
                      Edit pipeline {key}
                    </button>{' '}
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setPipelineConfirm(key)}
                    >
                      Delete pipeline {key}
                    </button>
                  </span>
                </div>
                <table className="orch-table" aria-label={`Pipeline ${key}`}>
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Model</th>
                      <th>Prompt / markers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {memberRows.map((name) => (
                      <tr key={name} aria-label={name}>
                        <th className="mono" scope="row">
                          {name}
                        </th>
                        <td>
                          <ModelPicker
                            agentName={name}
                            value={declaredModel(base.agents[name]) ?? ''}
                            pairs={pairs}
                            onChange={() => undefined}
                            disabled
                          />
                          <div className="ro-extras">
                            <button
                              type="button"
                              className="btn"
                              onClick={() => setBuilder({ name: key })}
                            >
                              edit in builder
                            </button>{' '}
                            <span className="ro-flag">
                              generic edits rejected — pipeline-owned (AP-4)
                            </span>
                          </div>
                        </td>
                        <td>
                          <PromptCell
                            agentName={name}
                            entry={base.agents[name] ?? {}}
                            onRead={setReader}
                          />
                          <span className="badge">pipeline {key}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </section>
      )}

      <section className="orch-section">
        <h3>Other agents</h3>
        <table className="orch-table" aria-label="Other agents">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Model</th>
              <th>Prompt / markers</th>
            </tr>
          </thead>
          <tbody>
            {others.map((name) => (
              <tr key={name} aria-label={name}>
                <th className="mono" scope="row">
                  {name}
                </th>
                <td>{pickerNode(name)}</td>
                <td>
                  <PromptCell
                    agentName={name}
                    entry={base.agents[name]}
                    onRead={setReader}
                    onEdit={isUserOwned(name) ? setPromptEdit : undefined}
                    deletable={isUserOwned(name)}
                    onDelete={setAgentConfirm}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* WU9 (OA-3): the sync action the advisory above points at. A
          successful run reloads CONFIG through the generic reload path, so
          the matrix and list reflect whatever gentle-ai sync wrote. */}
      <section className="orch-section">
        <SyncPanel
          onSynced={() => {
            setSyncAdvisory(false);
            void reload();
          }}
        />
      </section>

      <SaveBar
        changeCount={changeCount}
        busy={busy}
        validationError={validationError}
        onSave={() => void commit(base)}
        onDiscard={() => {
          setEdits({});
          setValidationError(null);
        }}
      />

      {conflict && (
        <ConflictModal
          info={conflict}
          rows={conflictRows(conflictTarget, edits)}
          busy={busy}
          onReload={() => {
            if (conflict.fresh) setBase(conflict.fresh);
            setConflict(null);
          }}
          onOverwrite={() => {
            const target = conflict.fresh ?? base;
            setConflict(null);
            void commit(target);
          }}
        />
      )}

      {createModal}
      {reader && (
        <PromptReaderModal agentName={reader} onClose={() => setReader(null)} />
      )}

      {/* WU-3b edit path: the builder prefilled from the stored definition. */}
      {builder && defs[builder.name] && (
        <PipelineBuilderModal
          key={builder.name}
          base={base}
          editing={{ name: builder.name, definition: defs[builder.name] }}
          onClose={() => setBuilder(null)}
          onSaved={(freshHash) => {
            setBuilder(null);
            setBase((prev) => (prev ? { ...prev, hash: freshHash } : prev));
            setRestartRequired(true);
            void reload();
            void refreshDefs();
          }}
          onAdoptFresh={(fresh) => setBase(fresh)}
        />
      )}

      {/* WU-4 OA-4': user-owned prompt editor (roles ride the lockstep route). */}
      {promptEdit && (
        <PromptEditorModal
          key={promptEdit}
          agentName={promptEdit}
          hash={base.hash}
          onClose={() => setPromptEdit(null)}
          onSaved={(freshHash) => {
            setPromptEdit(null);
            setBase((prev) => (prev ? { ...prev, hash: freshHash } : prev));
            setRestartRequired(true);
            void reload();
            // A role edit rewrote the def in lockstep (AP-4) — re-read it.
            void refreshDefs();
          }}
          onAdoptFresh={(freshHash) =>
            setBase((prev) => (prev ? { ...prev, hash: freshHash } : prev))
          }
        />
      )}

      {/* AP-5: pipeline delete confirm lists every affected row (N+1). */}
      {pipelineConfirm && (
        <div
          className="overlay"
          role="alertdialog"
          aria-label={`Delete pipeline ${pipelineConfirm}?`}
          aria-modal="true"
        >
          <div className="modal">
            <h2>Delete pipeline {pipelineConfirm}?</h2>
            <p className="modal-note">
              This removes the definition and{' '}
              {memberListFor(pipelineConfirm).length} rows in one save (AP-5,
              SCW-4 backup first) — zero orphans:
            </p>
            <ul>
              {memberListFor(pipelineConfirm).map((name, i) => (
                <li key={name} className="mono">
                  {i === 0 ? `${name} (orchestrator)` : name}
                </li>
              ))}
            </ul>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void confirmPipelineDelete(pipelineConfirm)}
              >
                Confirm delete
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setPipelineConfirm(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SCW-7' d: standalone user-owned delete confirm (MC-4 pattern). */}
      {agentConfirm && (
        <div
          className="overlay"
          role="alertdialog"
          aria-label={`Delete ${agentConfirm}?`}
          aria-modal="true"
        >
          <div className="modal">
            <h2>Delete {agentConfirm}?</h2>
            <p className="modal-note">
              This removes only the{' '}
              <code className="mono">agent.{agentConfirm}</code> entry — a
              backup is written before the delete (SCW-4). Cancel sends no
              request.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void confirmAgentDelete(agentConfirm)}
              >
                Confirm delete
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setAgentConfirm(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

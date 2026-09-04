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
} from '../../../shared/types';
import { ApiError, getConfig, putAgentModel } from '../api';
import {
  ConflictModal,
  type ConflictInfo,
  type ConflictRow,
} from '../components/ConflictModal';
import { SaveBar } from '../components/SaveBar';

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
}: {
  agentName: string;
  value: string;
  pairs: string[];
  onChange: (value: string) => void;
}) {
  const ghost = value !== '' && !pairs.includes(value);
  return (
    <select
      aria-label={`${agentName} model`}
      value={value}
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
 * Read-only surface (OA-4): prompt bodies (which may embed
 * <gentle-ai:...> marker blocks) and structured `gentle-ai:*` keys are
 * displayed verbatim and labeled read-only — the view offers no control
 * over them and no write ever carries their content.
 */
function ReadOnlyExtras({ entry }: { entry: AgentConfigEntry }) {
  const prompt = typeof entry.prompt === 'string' ? entry.prompt : null;
  const markers = Object.keys(entry).filter((key) =>
    key.startsWith('gentle-ai:'),
  );
  if (prompt === null && markers.length === 0) return null;
  return (
    <div className="ro-extras">
      {prompt !== null && (
        <details className="ro-block">
          <summary>
            prompt · <span className="ro-flag">read-only</span>
          </summary>
          <pre className="mono">{prompt}</pre>
        </details>
      )}
      {markers.map((key) => (
        <div key={key} className="ro-block">
          <span className="mono">{key}</span>{' '}
          <span className="ro-flag">read-only</span>
          <pre className="mono">{JSON.stringify(entry[key], null, 2)}</pre>
        </div>
      ))}
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

  const reload = useCallback(async () => {
    try {
      setBase(await getConfig());
      setLoadError(null);
    } catch (err) {
      // PC-1: error state only — the dashboard never creates or repairs.
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

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

  const agentNames = Object.keys(base.agents);
  if (agentNames.length === 0) {
    return (
      <div className="panel">
        <h2>Orchestration</h2>
        <p className="muted">No agents declared</p>
        <p className="muted">
          Agent assignments appear here as soon as CONFIG declares them under
          <code> agent.*</code>.
        </p>
      </div>
    );
  }

  const { rows, others } = groupAgents(agentNames);
  const pairs = installedPairs(base.providers);
  const changeCount = Object.keys(pendingWrites(base, edits)).length;
  const conflictTarget = conflict?.fresh ?? base;

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
        <h2>Orchestration</h2>
        <p className="muted">
          Model assignment per agent, derived from <code>agent.*</code> in
          CONFIG
          {base.defaultAgent ? (
            <>
              {' '}
              (default agent: <code className="mono">{base.defaultAgent}</code>)
            </>
          ) : null}
          . Pickers list only installed provider/model pairs; prompt bodies and{' '}
          <code className="mono">gentle-ai:*</code> markers are read-only.
        </p>
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
                          <ReadOnlyExtras entry={base.agents[name]} />
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
                  <ReadOnlyExtras entry={base.agents[name]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
    </div>
  );
}

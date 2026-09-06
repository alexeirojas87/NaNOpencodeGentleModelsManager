// role-model-assignment WU-3 — the assignments panel (spec capabilities
// native-model-assignment + sync-result-surfacing; design §Technical
// Approach, Option 2). Mounted inside the Orchestration view's sync
// orch-section beside the (unchanged) SyncPanel. It renders:
//   • the fixed 14-phase knowledge grid × {cheap, deep} installed-pairs
//     selects (D3 — the catalog is the grid; config-derivation cannot cover
//     jd-*), plus --profile rows for the sdd-orchestrator variants;
//   • read-only fallback rows for config-declared phases outside the
//     catalog (S2/S19 — unknown slugs are never assignable);
//   • advisory capability chips (CapabilityChip — never blocking, D10).
// Apply diffs the selections against the DECLARED agent.*.model values and
// composes ONE runSync with repeated --profile-phase flags plus --profile
// flags (D5 probe verdict batch_supported=YES — the sequential queue was
// dropped by evidence; spec S9 is resolved-by-evidence). Outcome semantics
// mirror SyncPanel: success ONLY on exit 0 (then onSynced() so the parent
// reloads CONFIG); a non-zero exit renders stdout/stderr as <pre> TEXT
// children (no dangerouslySetInnerHTML — the threat-matrix XSS response)
// and never reloads; a 400 sync_bad_args envelope surfaces its message and
// never reloads; while a sync runs every control is disabled.
// SET-ONLY (D6): a cell with a declared model has no "not assigned"
// placeholder to fall back to, and no clear/un-assign action exists
// anywhere — the CLI rejects un-assign values pre-write (probe evidence).
import { useState } from 'react';

import type {
  AgentConfigEntry,
  ConfigResponse,
  MaskedProvider,
  ModelConfig,
  SyncResponse,
} from '../../../../shared/types';
import { ApiError, runSync } from '../../api';
import { IconAlert, IconCheck, IconSpinner, IconSync } from '../../icons';
import { CapabilityChip } from './CapabilityChip';
import { composeAssignmentArgsDetailed } from './composeArgs';
import {
  FALLBACK_KNOWLEDGE,
  knowledgeFor,
  PHASE_KNOWLEDGE,
  PHASE_IDS,
  type PhaseNeed,
} from './phaseKnowledge';

/** The two profile columns — the D3 constant (VARIANT_SUFFIXES truth). */
type Profile = 'cheap' | 'deep';

/** `<provider>/<model-id>` pairs declared in the SAME config response (OA-2/D4). */
function installedPairs(providers: Record<string, MaskedProvider>): string[] {
  const pairs: string[] = [];
  for (const [id, entry] of Object.entries(providers)) {
    for (const modelId of Object.keys(entry.models ?? {})) {
      pairs.push(`${id}/${modelId}`);
    }
  }
  return pairs;
}

/**
 * The agent a grid cell addresses. Catalog slugs ALREADY carry the `sdd-`
 * prefix (the CLI phase list is `sdd-spec`, `jd-judge-a`, …), so the phase
 * agent is `<slug>-<profile>`; the orchestrator variants are the orphan
 * `sdd-orchestrator-<profile>` keys.
 */
function variantAgentName(target: string, profile: Profile): string {
  return target === 'orchestrator'
    ? `sdd-orchestrator-${profile}`
    : `${target}-${profile}`;
}

function declaredModel(
  agents: Record<string, AgentConfigEntry>,
  target: string,
  profile: Profile,
): string | null {
  const entry = agents[variantAgentName(target, profile)];
  return typeof entry?.model === 'string' ? entry.model : null;
}

/**
 * Config-declared phases OUTSIDE the catalog (e.g. a hand-added
 * sdd-<slug>-deep family) — they render as read-only fallback rows via
 * knowledgeFor (S2) and never get a control (S19).
 */
function unknownPhaseSlugs(agents: Record<string, AgentConfigEntry>): string[] {
  const slugs = new Set<string>();
  for (const name of Object.keys(agents)) {
    if (!name.startsWith('sdd-')) continue;
    let family = name.slice('sdd-'.length);
    for (const suffix of ['-cheap', '-deep']) {
      if (family.endsWith(suffix)) {
        family = family.slice(0, -suffix.length);
        break;
      }
    }
    // The CLI slug for a config family "sdd-<family>[-variant]" is
    // "sdd-<family>" — that is the key the catalog knows.
    if (family === 'orchestrator' || `sdd-${family}` in PHASE_KNOWLEDGE) {
      continue;
    }
    slugs.add(family);
  }
  return [...slugs].sort();
}

/** Declared ModelConfig for a "provider/model" pair (chip source). */
function modelConfig(
  providers: Record<string, MaskedProvider>,
  pair: string | null | undefined,
): ModelConfig | undefined {
  if (!pair) return undefined;
  const slash = pair.indexOf('/');
  if (slash === -1) return undefined;
  return providers[pair.slice(0, slash)]?.models?.[pair.slice(slash + 1)];
}

export interface AssignmentsPanelProps {
  /** The loaded CONFIG snapshot — declared models + providers come from here. */
  base: ConfigResponse;
  /** Called after a SUCCESSFUL (exit-0) apply so the owner reloads CONFIG. */
  onSynced: () => void;
}

/** Pending user choice per assignment key "<profile>:<target>". */
type Selections = Record<string, string>;

export function AssignmentsPanel({ base, onSynced }: AssignmentsPanelProps) {
  const [selections, setSelections] = useState<Selections>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SyncResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState<
    { key: string; value: string; reason: string }[]
  >([]);

  const pairs = installedPairs(base.providers);
  const unknown = unknownPhaseSlugs(base.agents);

  /** Effective cell value: user selection, else the declared model, else ''. */
  const effectiveValue = (target: string, profile: Profile): string => {
    const key = `${profile}:${target}`;
    if (key in selections) return selections[key];
    return declaredModel(base.agents, target, profile) ?? '';
  };

  /** Diff vs declared — the changes Apply will compose (S8). */
  const pendingChanges = (): Record<string, string> => {
    const changes: Record<string, string> = {};
    for (const [key, value] of Object.entries(selections)) {
      if (!value) continue;
      const colon = key.indexOf(':');
      const profile = key.slice(0, colon) as Profile;
      const target = key.slice(colon + 1);
      if (value !== declaredModel(base.agents, target, profile)) {
        changes[key] = value;
      }
    }
    return changes;
  };
  const changeCount = Object.keys(pendingChanges()).length;

  async function apply() {
    const composed = composeAssignmentArgsDetailed(pendingChanges());
    setDropped(composed.dropped);
    if (composed.args.length === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await runSync(composed.args);
      setResult(response);
      if (response.exitCode === 0) {
        setSelections({}); // the reload re-anchors declared values
        onSynced();
      }
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message} (code ${err.code})`
          : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  const selectFor = (target: string, profile: Profile) => {
    const current = effectiveValue(target, profile);
    const declared = declaredModel(base.agents, target, profile);
    const ariaTarget = target === 'orchestrator' ? 'sdd-orchestrator' : target;
    return (
      <>
        <select
          aria-label={`assign ${ariaTarget} (${profile})`}
          value={current}
          disabled={busy}
          onChange={(e) =>
            setSelections((prev) => ({
              ...prev,
              [`${profile}:${target}`]: e.target.value,
            }))
          }
        >
          {/* Placeholder only while nothing is declared or picked — once a
              model is set there is no way back to unassigned (D6 set-only). */}
          {current === '' && <option value="">not assigned</option>}
          {declared !== null && !pairs.includes(declared) && (
            <option value={declared}>{declared}</option>
          )}
          {pairs.map((pair) => (
            <option key={pair} value={pair}>
              {pair}
            </option>
          ))}
        </select>
        <CapabilityChip
          model={modelConfig(base.providers, current === '' ? null : current)}
          needs={target === 'orchestrator' ? [] : knowledgeFor(target).needs}
        />
      </>
    );
  };

  const knowledgeCells = (knowledge: {
    purpose: string;
    load: string;
    needs: PhaseNeed[];
  }) => (
    <>
      <td>{knowledge.purpose}</td>
      <td>{knowledge.load}</td>
      <td>
        {knowledge.needs.length === 0
          ? '—'
          : knowledge.needs.map((need) => (
              <span key={need} className="chip">
                {need}
              </span>
            ))}
      </td>
    </>
  );

  return (
    <section
      className="panel assignments-panel"
      aria-label="gentle-ai model assignments"
    >
      <div className="sync-head">
        <h3>Model assignments</h3>
        {result && (
          <span
            className={
              result.exitCode === 0 ? 'chip-exit-ok' : 'chip-exit-fail'
            }
          >
            exit {result.exitCode}
          </span>
        )}
      </div>
      <p className="muted">
        Assign installed models to the SDD phases and orchestrators. Apply runs{' '}
        <code className="mono">gentle-ai sync</code> once with all changed
        assignments (native <code className="mono">--profile-phase</code> /
        <code className="mono">--profile</code> flags) and re-reads CONFIG on
        success. Assignments are set-only: to move a phase, pick another model.
      </p>
      <table className="orch-table" aria-label="Assignments grid">
        <thead>
          <tr>
            <th>Phase</th>
            <th>What it does</th>
            <th>Load</th>
            <th>Needs</th>
            <th>cheap</th>
            <th>deep</th>
          </tr>
        </thead>
        <tbody>
          {PHASE_IDS.map((slug) => (
            <tr key={slug} aria-label={slug}>
              <th className="mono" scope="row">
                {slug}
              </th>
              {knowledgeCells(knowledgeFor(slug))}
              <td>{selectFor(slug, 'cheap')}</td>
              <td>{selectFor(slug, 'deep')}</td>
            </tr>
          ))}
          {unknown.map((slug) => (
            <tr key={slug} aria-label={slug}>
              <th className="mono" scope="row">
                {slug}
              </th>
              {knowledgeCells(FALLBACK_KNOWLEDGE)}
              <td colSpan={2}>
                <span className="ro-flag">
                  read-only — not assignable via the CLI phase list
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="orch-table" aria-label="Orchestrator assignments">
        <thead>
          <tr>
            <th>Orchestrator</th>
            <th>What it does</th>
            <th>Load</th>
            <th>Needs</th>
            <th>cheap</th>
            <th>deep</th>
          </tr>
        </thead>
        <tbody>
          <tr aria-label="sdd-orchestrator">
            <th className="mono" scope="row">
              sdd-orchestrator
            </th>
            {knowledgeCells({
              purpose:
                'Coordinates SDD runs; model rides the --profile flag per variant',
              load: 'high',
              needs: [],
            })}
            <td>{selectFor('orchestrator', 'cheap')}</td>
            <td>{selectFor('orchestrator', 'deep')}</td>
          </tr>
        </tbody>
      </table>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || changeCount === 0}
        onClick={() => void apply()}
      >
        <IconSync /> Apply assignments
      </button>{' '}
      <span className="muted">
        {changeCount === 0
          ? 'No assignment changes'
          : `${changeCount} assignment change${changeCount === 1 ? '' : 's'} pending`}
      </span>
      {busy && (
        <p className="muted">
          <IconSpinner /> Applying assignments…
        </p>
      )}
      {dropped.length > 0 && (
        <div role="alert" className="sync-error">
          <IconAlert /> Skipped invalid assignments (never sent):{' '}
          {dropped.map((d) => `${d.key} → ${d.value} (${d.reason})`).join('; ')}
        </div>
      )}
      {error && (
        <div role="alert" className="sync-error">
          <IconAlert /> {error}
        </div>
      )}
      {result && (
        <div className="sync-out">
          {result.stdout !== '' && <pre className="mono">{result.stdout}</pre>}
          {result.stderr !== '' && (
            <>
              <p className="sync-stderr-label muted">stderr</p>
              <pre className="mono">{result.stderr}</pre>
            </>
          )}
        </div>
      )}
      {result && result.exitCode === 0 && (
        <p role="status">
          <IconCheck /> Assignments applied — CONFIG reloaded.
        </p>
      )}
    </section>
  );
}

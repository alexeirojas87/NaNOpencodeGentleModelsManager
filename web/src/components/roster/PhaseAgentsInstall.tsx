// phase-agents-v3 (design Decision 7) — the "Install 3.0 phase agents"
// action. ONE click issues EXACTLY 13 sequential POST /api/agents creates
// in roster order (shared/roster.ts is the single creation authority);
// there is deliberately NO batch endpoint and NO model field — model
// assignment is the separate picker flow (PR-3).
//
// Failure semantics are design Decision 1 (CONTINUE-ALL):
//   - each 200 create echoes the AC-7 post-write hash and the chain adopts
//     it; any 400/5xx leaves the chain hash UNCHANGED (every create gate is
//     pre-mutation — zero bytes, zero backups), so the chain stays valid
//     past failures;
//   - 400 `agent_exists` is the idempotency primitive → an
//     "already installed" row, zero mutation (re-running is always safe);
//   - a 409 stale refetches GET /api/config ONCE and retries THAT agent
//     once — a second 409 lands as a typed failed row and the run continues;
//   - every roster entry gets exactly one result row
//     (created | already-installed | failed<typedCode>), the run always
//     finishes with a terminal summary, and completion triggers `onComplete`
//     so the view reloads CONFIG + status (design D7 — rosterOwned refresh).
//
// Gating (design Decisions 3/4/7): the action renders ONLY when the
// StatusResponse.gentleAi block resolves mode '3.x'. Every other mode — and
// a missing/failed status read (a server predating the route) — renders the
// restart advisory instead: the stale-version mitigation is VISIBILITY, so
// the advisory always carries mode + source (+ typed detail on fallback)
// and the restart guidance.
import { useState } from 'react';

import type {
  ConfigResponse,
  StatusResponse,
} from '../../../../shared/types';
import {
  PHASE_AGENT_ROSTER,
  type PhaseAgentEntry,
  type RosterKind,
} from '../../../../shared/roster';
import { ApiError, createAgent, getConfig } from '../../api';
import { IconPlus } from '../../icons';

/** Per-agent result states (design D7): exactly one row per roster entry. */
type InstallRowStatus = 'created' | 'already-installed' | 'failed';

interface InstallRow {
  name: string;
  kind: RosterKind;
  status: InstallRowStatus;
  /** Typed error text (`code: message`) — present on failed rows only. */
  message?: string;
}

type RunPhase = 'idle' | 'running' | 'done';

/** The create body: {mode:'subagent', prompt, description} — NO model key. */
function installBody(entry: PhaseAgentEntry) {
  return {
    mode: 'subagent' as const,
    prompt: entry.prompt,
    description: entry.description,
  };
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  return 'The install request failed unexpectedly.';
}

type CreateOutcome =
  | { kind: 'ok'; row: 'created' | 'already-installed'; hash: string | null }
  | { kind: 'failed'; message: string; stale: boolean };

/**
 * ONE create attempt against the given chain hash. `agent_exists` maps to
 * the already-installed outcome (chain untouched — there is no echo); every
 * other failure carries whether it was a 409 stale (the single-refetch
 * retry trigger) plus its typed message.
 */
async function attemptCreate(
  entry: PhaseAgentEntry,
  hash: string,
): Promise<CreateOutcome> {
  try {
    const res = await createAgent({
      hash,
      name: entry.name,
      agent: installBody(entry),
    });
    return { kind: 'ok', row: 'created', hash: res.hash };
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.status === 400 &&
      err.code === 'agent_exists'
    ) {
      return { kind: 'ok', row: 'already-installed', hash: null };
    }
    return {
      kind: 'failed',
      stale: err instanceof ApiError && err.status === 409,
      message: describeError(err),
    };
  }
}

const STATUS_LABEL: Record<InstallRowStatus, string> = {
  created: 'created',
  'already-installed': 'already installed',
  failed: 'failed',
};

export function PhaseAgentsInstall({
  gentleAi,
  base,
  onComplete,
}: {
  /** The StatusResponse.gentleAi block; null when the status read failed. */
  gentleAi: StatusResponse['gentleAi'] | null;
  /** Loaded config — supplies the starting hash of the AC-7 chain. */
  base: ConfigResponse;
  /** Fired once when the run completes — the view reloads CONFIG + status. */
  onComplete: () => void;
}) {
  const [phase, setPhase] = useState<RunPhase>('idle');
  const [rows, setRows] = useState<InstallRow[]>([]);

  const runInstall = async () => {
    setPhase('running');
    setRows([]);
    let currentHash = base.hash;
    const collected: InstallRow[] = [];
    const pushRow = (row: InstallRow) => {
      collected.push(row);
      setRows([...collected]);
    };
    for (const entry of PHASE_AGENT_ROSTER) {
      let outcome = await attemptCreate(entry, currentHash);
      // 409 stale (design D1): refetch the config hash ONCE, retry THIS
      // agent ONCE. The refetched hash enters the chain (it is the server's
      // actual state); a second 409 is the final failed row.
      if (outcome.kind === 'failed' && outcome.stale) {
        try {
          currentHash = (await getConfig()).hash;
        } catch {
          // Refetch failed — the retry below runs against the stale hash,
          // fails, and lands as the typed failed row (still one retry).
        }
        outcome = await attemptCreate(entry, currentHash);
      }
      if (outcome.kind === 'ok') {
        // Only a 200 echo advances the chain; already-installed (a 400)
        // leaves the hash exactly where it was.
        if (outcome.hash) currentHash = outcome.hash;
        pushRow({ name: entry.name, kind: entry.kind, status: outcome.row });
      } else {
        pushRow({
          name: entry.name,
          kind: entry.kind,
          status: 'failed',
          message: outcome.message,
        });
      }
    }
    setPhase('done');
    onComplete();
  };

  // --- Gated-away surface: restart advisory (mode + source + detail) -------
  if (!gentleAi || gentleAi.mode !== '3.x') {
    return (
      <div className="field">
        <h3>3.0 phase agents</h3>
        {gentleAi ? (
          <p className="muted">
            Dashboard resolved gentle-ai as {gentleAi.mode} (source:{' '}
            {gentleAi.source}
            {gentleAi.detail ? ` — ${gentleAi.detail}` : ''}).
          </p>
        ) : (
          <p className="muted">
            The dashboard server status is unavailable (the server may predate
            this route), so the gentle-ai version is unknown.
          </p>
        )}
        <p className="muted">
          Restart the dashboard server after installing/upgrading gentle-ai.
        </p>
      </div>
    );
  }

  const created = rows.filter((r) => r.status === 'created').length;
  const already = rows.filter((r) => r.status === 'already-installed').length;
  const failed = rows.filter((r) => r.status === 'failed').length;

  return (
    <div className="field">
      <h3>3.0 phase agents</h3>
      <button
        type="button"
        className="btn btn-primary"
        disabled={phase === 'running'}
        onClick={() => void runInstall()}
      >
        <IconPlus /> Install 3.0 phase agents
      </button>
      {rows.length > 0 && (
        <div className="table-scroll">
          <table className="orch-table" aria-label="Install results">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Kind</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name} aria-label={row.name}>
                  <th className="mono" scope="row">
                    {row.name}
                  </th>
                  <td>{row.kind}</td>
                  <td>
                    <span className="badge">{STATUS_LABEL[row.status]}</span>
                    {row.message && (
                      <p className="field-error">{row.message}</p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {phase === 'done' && (
        <p role="status" className="muted">
          {created} created, {already} already installed, {failed} failed —
          safe to re-run
        </p>
      )}
    </div>
  );
}

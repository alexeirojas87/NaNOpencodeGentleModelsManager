// WU10.1 — the Status view (design §API-Surface "GET /api/status"; spec
// SCW-4 visible, MC-5 rollup, PC-1 error UX, CX-3 carrier). It is a pure
// READ surface: it consumes GET /api/status ONLY — the browser never
// touches the filesystem and this view issues no writes (api.ts is the
// only network layer). Everything displayed is server truth:
//   · identity: CONFIG path, sha256 content hash, mtime and snapshot asOf;
//   · drift: the DriftCell[] computed server-side (WU7) rendered verbatim —
//     the client never compares numbers and never filters cells (MC-5:
//     advisory only, the declared value always wins on save);
//   · backups: the dashboard-owned restore points, newest-first exactly as
//     the server lists them (SCW-4), plus a documented restore pointer that
//     distinguishes them from gentle-ai's own ~/.gentle-ai/backups;
//   · restartRequired: the process-local CX-3 carrier — shown as the
//     server's current answer, with no local dismiss (this is a status,
//     not an ephemeral toast; Refresh re-reads it).
// The load-error panel is the PC-1 parity pattern of the other views:
// a missing (404 config_missing) or unparseable (422 config_unparseable)
// CONFIG surfaces the server's honest message with a Retry — the
// dashboard never creates or repairs the file.
import { useCallback, useEffect, useState } from 'react';

import type { StatusResponse } from '../../../shared/types';
import { getStatus } from '../api';
import { IconPulse, IconRefresh, IconSpinner } from '../icons';

/** ISO 8601 (UTC) rendering of an epoch-ms stamp — deterministic, locale-free. */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export default function StatusView() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const reload = useCallback(async () => {
    setRefreshing(true);
    try {
      setStatus(await getStatus());
      setLoadError(null);
    } catch (err) {
      // PC-1: error state only — the dashboard never creates or repairs.
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

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
  if (!status) {
    return <p className="muted">Loading status…</p>;
  }

  const newest = status.backups[0] ?? null;

  return (
    <div className="view">
      <header className="view-header">
        <h2>
          <span className="tile tile-yellow">
            <IconPulse />
          </span>
          Status
        </h2>
        <p className="muted">
          Read-only view of what the server currently sees — the CONFIG
          identity, advisory drift, restore points and the restart flag.
        </p>
        <button
          type="button"
          className="btn"
          onClick={() => void reload()}
          disabled={refreshing}
        >
          {refreshing ? <IconSpinner /> : <IconRefresh />} Refresh
        </button>
      </header>

      {status.restartRequired ? (
        // CX-3: the server says a save happened in this process since it
        // started; a running OpenCode must restart to pick CONFIG up.
        <div className="banner" role="status">
          <span>Restart OpenCode to apply</span>
        </div>
      ) : (
        <p className="muted" role="status" aria-label="No restart pending">
          No restart pending — this server process has not written CONFIG since
          it started.
        </p>
      )}

      <section className="panel" aria-label="CONFIG identity">
        <h3>CONFIG identity</h3>
        <dl className="status-grid">
          <div>
            <dt>Path</dt>
            <dd className="mono">{status.path}</dd>
          </div>
          <div>
            <dt>Content hash (SHA-256)</dt>
            <dd className="mono">{status.hash}</dd>
          </div>
          <div>
            <dt>Last modified</dt>
            <dd className="mono" title={`epoch ms ${status.mtime}`}>
              {iso(status.mtime)}
            </dd>
          </div>
          <div>
            <dt>Snapshot as of</dt>
            <dd className="mono">{status.snapshotAsOf ?? 'unavailable'}</dd>
          </div>
        </dl>
      </section>

      <section className="status-section" aria-label="Drift">
        <h3>
          Drift{' '}
          <span className="chip">
            {status.drift.length} drift cell
            {status.drift.length === 1 ? '' : 's'}
          </span>
        </h3>
        {status.drift.length === 0 ? (
          <p className="muted">
            No drift reported — declared values match the bundled snapshot for
            every provider whose metadata matches it. Non-matching providers are
            never compared.
          </p>
        ) : (
          <>
            <div className="table-scroll">
              <table className="models-table" aria-label="Snapshot drift">
                <thead>
                  <tr>
                    <th>Provider / model</th>
                    <th>Field</th>
                    <th>Declared</th>
                    <th>Snapshot</th>
                    <th>Advisory</th>
                  </tr>
                </thead>
                <tbody>
                  {status.drift.map((cell) => (
                    <tr
                      key={`${cell.provider}|${cell.model}|${cell.field}`}
                      aria-label={`${cell.provider}/${cell.model}`}
                    >
                      <th className="mono" scope="row">
                        {cell.provider}/{cell.model}
                      </th>
                      <td className="mono">{cell.field}</td>
                      <td className="mono">{String(cell.declared)}</td>
                      <td className="mono">{String(cell.snapshot)}</td>
                      <td>
                        <span
                          className="chip chip-drift"
                          title="Advisory only — the declared value is saved verbatim (MC-5)"
                        >
                          drift
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted">
              Advisory only: the dashboard never auto-corrects a declared value,
              and drift never blocks a save (MC-5).
            </p>
          </>
        )}
      </section>

      <section className="status-section" aria-label="Backups">
        <h3>Backups</h3>
        {newest === null ? (
          <p className="muted">
            No backups yet — this CONFIG has never been saved from the
            dashboard. Every future save lists its restore point here (newest
            first, the latest 20 kept).
          </p>
        ) : (
          <>
            <p className="muted">
              Restore points written by the dashboard before each save (SCW-4),
              newest first. The dashboard never restores a backup — it is a
              deliberate manual step: stop OpenCode, copy a backup over CONFIG,
              restart.
            </p>
            <p className="restore-cmd">
              Newest, ready to copy:{' '}
              <code className="mono">{`cp "${newest}" "${status.path}"`}</code>
            </p>
            <ol className="backup-list" aria-label="Backup restore points">
              {status.backups.map((path, index) => (
                <li key={path}>
                  <span className="mono">{path}</span>
                  {index === 0 && <span className="chip">newest</span>}
                </li>
              ))}
            </ol>
            <p className="muted">
              These files live in the dashboard-owned{' '}
              <code className="mono">model-dashboard-backups</code> directory
              beside CONFIG. Changes made by{' '}
              <code className="mono">gentle-ai sync</code> are backed up
              separately under{' '}
              <code className="mono">~/.gentle-ai/backups</code> and are undone
              with <code className="mono">gentle-ai restore</code> — never with
              the files listed here.
            </p>
          </>
        )}
      </section>
    </div>
  );
}

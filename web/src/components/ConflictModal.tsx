// WU6 (SCW-2 UX, design §UI "Conflict (409)") — two-column key-path diff
// shown when a write is rejected as stale. Left column: the dashboard's
// pending copy; right column: the current file (from the reload the conflict
// flow performs). Actions: "Reload fresh" adopts the current copy while
// keeping the pending edits re-appliable; "Overwrite" retries the write
// against the new base hash.
import type { ConfigResponse } from '../../../shared/types';
import { IconAlert } from '../icons';

export interface ConflictRow {
  path: string;
  pending: string;
  current: string;
}

export interface ConflictInfo {
  message: string;
  /** Hash this client believed was current when the write was sent. */
  expected: string;
  /** Hash the server found on disk (the 409 body's `actual`). */
  actual: string;
  /** Fresh masked copy fetched for the diff; null if the reload failed. */
  fresh: ConfigResponse | null;
}

export interface ConflictModalProps {
  info: ConflictInfo;
  rows: ConflictRow[];
  busy: boolean;
  onReload: () => void;
  onOverwrite: () => void;
}

export function ConflictModal({
  info,
  rows,
  busy,
  onReload,
  onOverwrite,
}: ConflictModalProps) {
  return (
    <div className="overlay">
      <div role="dialog" aria-label="Config conflict" className="modal">
        <h2>
          <IconAlert /> Config changed externally — write rejected
        </h2>
        <p className="modal-note">{info.message}</p>
        <p className="modal-hashes">
          Your base <code>{info.expected}</code> · current file{' '}
          <code>{info.actual}</code>
        </p>
        <table className="diff">
          <thead>
            <tr>
              <th>Key path</th>
              <th>Dashboard (pending)</th>
              <th>Config file (current)</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="mono">—</td>
                <td colSpan={2}>no pending values differ from the file</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.path}>
                  <td className="mono">{row.path}</td>
                  <td className="diff-pending">{row.pending}</td>
                  <td className="diff-current">{row.current}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div className="modal-actions">
          <button
            type="button"
            className="btn"
            onClick={onReload}
            disabled={busy}
          >
            Reload fresh
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onOverwrite}
            disabled={busy}
          >
            Overwrite
          </button>
        </div>
      </div>
    </div>
  );
}

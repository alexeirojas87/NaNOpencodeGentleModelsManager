// WU9.3 — the sync panel (design §UI: "Sync panel streams output +
// exit-code chip"; spec OA-3). Mounted by the Orchestration view, it is the
// action the post-save advisory points at: POST /api/sync runs the
// gentle-ai sync CLI unchanged server-side (argv allowlist, execFile,
// timeout + output cap — server/src/sync.ts), and this panel surfaces the
// outcome: stdout/stderr text, an `exit N` chip, and — ONLY on exit 0 — the
// success note plus the onSynced() callback, which makes the parent re-GET
// /api/config so the matrix/list reflect the post-sync CONFIG. A non-zero
// exit surfaces its output and failure code with no success state (OA-3
// failure scenario). Honest note: the design's API shape is a single JSON
// response ({exitCode, stdout, stderr}), so output is shown complete-on-
// completion (the "streaming/surfacing" of OA-3 via its surfacing branch),
// not byte-streamed.
import { useState } from 'react';

import type { SyncResponse } from '../../../shared/types';
import { ApiError, runSync } from '../api';
import { IconAlert, IconCheck, IconSpinner, IconSync } from '../icons';

export interface SyncPanelProps {
  /** Called after a SUCCESSFUL sync so the owner can reload CONFIG (OA-3). */
  onSynced: () => void;
}

export function SyncPanel({ onSynced }: SyncPanelProps) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SyncResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      // Bare pass-through: no invented args — the unchanged `gentle-ai sync`.
      const response = await runSync();
      setResult(response);
      if (response.exitCode === 0) onSynced();
    } catch (err) {
      // Request-level failure (400 bad args should not happen from here,
      // 504 timeout, 500 spawn/limit): surface the envelope message.
      setError(
        err instanceof ApiError
          ? `${err.message} (code ${err.code})`
          : String(err),
      );
    } finally {
      setRunning(false);
    }
  }

  const succeeded = result !== null && result.exitCode === 0;

  return (
    <section className="panel sync-panel" aria-label="gentle-ai sync">
      <div className="sync-head">
        <h3>gentle-ai sync</h3>
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
        Runs the <code className="mono">gentle-ai sync</code> CLI unchanged and
        re-reads CONFIG afterward; prompt tables refresh from the reloaded file.
      </p>
      <button
        type="button"
        className="btn"
        disabled={running}
        onClick={() => void run()}
      >
        <IconSync /> Run sync
      </button>
      {running && (
        <p className="muted">
          <IconSpinner /> Running gentle-ai sync…
        </p>
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
      {succeeded && (
        <p role="status">
          <IconCheck /> Sync succeeded — CONFIG reloaded.
        </p>
      )}
    </section>
  );
}

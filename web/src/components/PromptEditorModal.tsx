// agent-pipelines WU-4 task 4.4 — the user-owned prompt editor (OA-4',
// SCW-7' c). Opens ONLY for user-owned names (the view gates the cell per
// AP-6); the current text is prefetched through the same read-only GET the
// reader uses, so `{file:…}`-backed entries arrive MATERIALIZED (the editor
// persists literal text, never refs). The textarea value is a controlled
// string end to end — script-looking input is data, and the reader keeps
// rendering it as an inert text node (round trip pinned in the test file).
// A pipeline ROLE answers server-side in lockstep (def + row, one save —
// AP-4); the orchestrator name answers 400 generator-owned (the view never
// offers this editor for it). Gates mirror the server (empty blocked); 409
// rides the established ConflictModal with the edited text retained.
import { useEffect, useState } from 'react';

import type { AgentPromptResponse } from '../../../shared/types';
import { ApiError, getConfig, getAgentPrompt, updateAgentPrompt } from '../api';
import { IconClose, IconCheck } from '../icons';
import { ConflictModal, type ConflictInfo } from './ConflictModal';

export interface PromptEditorModalProps {
  agentName: string;
  /** Current base hash (SCW-2 stale check). */
  hash: string;
  onClose: () => void;
  /** Success: the parent closes, adopts the echoed hash, reloads, shows CX-3. */
  onSaved: (freshHash: string) => void;
  /** Conflict "Reload fresh": the parent adopts the reloaded base hash. */
  onAdoptFresh: (freshHash: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function PromptEditorModal({
  agentName,
  hash,
  onClose,
  onSaved,
  onAdoptFresh,
}: PromptEditorModalProps) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);
  // A conflict reload hands the fresh hash to the parent AND adopts it
  // locally, so the Overwrite retry rides the new base even when the host
  // keeps a static prop (the view's parent re-baselines via the same echo).
  const [adoptedHash, setAdoptedHash] = useState<string | null>(null);
  const effectiveHash = adoptedHash ?? hash;

  useEffect(() => {
    let active = true;
    setPrompt(null);
    setLoadError(null);
    getAgentPrompt(agentName)
      .then((res: AgentPromptResponse) => {
        if (active) setPrompt(res.prompt);
      })
      .catch((err) => {
        if (active) setLoadError(errorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [agentName]);

  /** Stale check base: the prop hash, once no conflict has been adopted;
   * after a 409 reload the adopted fresh hash rides the retry instead. */
  async function submit(useHash: string) {
    if (prompt === null) return;
    setBusy(true);
    setSaveError(null);
    try {
      const res = await updateAgentPrompt(agentName, {
        hash: useHash,
        prompt,
      });
      onSaved(res.hash);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Established conflict flow; the edited text is retained (AC-7).
        // Reload for the fresh base: hand it to the parent AND adopt it
        // locally so the Overwrite retry rides the new base.
        let freshHash: string | null = null;
        try {
          freshHash = (await getConfig()).hash;
        } catch {
          // Degrade: retry falls back to the prop base hash.
        }
        if (freshHash !== null) {
          setAdoptedHash(freshHash);
          onAdoptFresh(freshHash);
        }
        setConflict({
          message: err.message,
          expected:
            typeof err.detail.expected === 'string'
              ? err.detail.expected
              : useHash,
          actual:
            typeof err.detail.actual === 'string' ? err.detail.actual : '',
          fresh: null,
        });
      } else if (err instanceof ApiError) {
        setSaveError(err.message); // file_ref_rejected, prompt_too_large, …
      } else {
        setSaveError('The prompt save failed unexpectedly.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay">
      <div
        className="modal"
        role="dialog"
        aria-label={`${agentName} prompt editor`}
        aria-modal="true"
      >
        <h2>
          {agentName} · prompt{' '}
          <span className="badge">user-owned — editable</span>
        </h2>
        <p className="modal-note">
          Only the prompt value moves (SCW-7&apos; c); a pipeline role saves in
          lockstep with its definition (AP-4). The text persists as a plain
          string — script-looking content stays inert in every reader.
        </p>
        {loadError ? (
          <p className="field-error" role="alert">
            {loadError}
          </p>
        ) : prompt === null ? (
          <p className="muted">Loading prompt…</p>
        ) : (
          <div className="field">
            <label htmlFor="prompt-editor">Prompt</label>
            <textarea
              id="prompt-editor"
              rows={12}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
        )}
        {saveError && (
          <p className="field-error" role="alert">
            {saveError}
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
            type="button"
            className="btn btn-primary"
            disabled={busy || prompt === null || prompt === '' || !!loadError}
            onClick={() => void submit(effectiveHash)}
          >
            <IconCheck /> Save prompt
          </button>
        </div>
      </div>
      {conflict && (
        <ConflictModal
          info={conflict}
          rows={[
            {
              path: `agent.${agentName}.prompt`,
              pending: '(edited prompt)',
              current: '(reloaded config)',
            },
          ]}
          busy={busy}
          onReload={() => {
            // The fresh base was already adopted during the 409 handling;
            // Reload just closes — the next Save rides the new hash.
            setConflict(null);
          }}
          onOverwrite={() => {
            setConflict(null);
            void submit(effectiveHash);
          }}
        />
      )}
    </div>
  );
}

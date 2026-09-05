// orchestration-v2 WU-B 2.3 — the read-only prompt reader (OA-4, design D8).
// The full prompt body lives HERE, never inside the table cell: the view
// fetches it through GET /api/agents/:name/prompt (D4) — inline prompts pass
// through verbatim and `{file:…}` refs are materialized server-side. The
// modal ships no editor of any kind (text children only), and the prompt is
// rendered as a React text node — never dangerouslySetInnerHTML — so a stored
// `<script>` payload shows as literal text and executes nothing.
import { useEffect, useState } from 'react';

import type { AgentPromptResponse } from '../../../shared/types';
import { getAgentPrompt } from '../api';
import { IconClose } from '../icons';

export function PromptReaderModal({
  agentName,
  onClose,
}: {
  agentName: string;
  onClose: () => void;
}) {
  const [resolved, setResolved] = useState<AgentPromptResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setResolved(null);
    setError(null);
    getAgentPrompt(agentName)
      .then((res) => {
        if (active) setResolved(res);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [agentName]);

  return (
    <div className="overlay">
      <div
        className="modal"
        role="dialog"
        aria-label={`${agentName} prompt`}
        aria-modal="true"
      >
        <h2>
          {agentName} · prompt <span className="ro-flag">read-only</span>
        </h2>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : resolved ? (
          <>
            <p className="modal-note">
              {resolved.source === 'file' ? (
                <>
                  Materialized from <code className="mono">{resolved.ref}</code>{' '}
                  — the dashboard shows prompts read-only and never rewrites
                  them (OA-4).
                </>
              ) : (
                <>
                  Inline prompt — shown verbatim; the dashboard shows prompts
                  read-only and never rewrites them (OA-4).
                </>
              )}
            </p>
            {/* Text child only: prompt content is data, never markup (XSS). */}
            <pre className="prompt-preview">{resolved.prompt}</pre>
          </>
        ) : (
          <p className="muted">Loading prompt…</p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            <IconClose /> Close
          </button>
        </div>
      </div>
    </div>
  );
}

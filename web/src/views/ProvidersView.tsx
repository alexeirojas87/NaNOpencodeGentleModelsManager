// WU6.3 — the Providers view. Lists every provider from GET /api/config
// (generic over 0..N — no hardcoded ids, PC-4), edits name/npm/baseURL
// inline, and treats apiKey as an opaque REPLACE-ONLY field (PC-3): the
// input starts empty, an empty input sends no apiKey op at all, and the
// masked {configured} shape is never echoed back as if it were a value
// (CX-2). Writes go through the WU5 REST API only; each successful
// WriteResponse {ok,hash} re-baselines the local hash (SCW-2 staleness
// flow), a 409 opens the two-column diff modal, and any completed save
// surfaces "Restart OpenCode to apply" (CX-3).
import { useCallback, useEffect, useState } from 'react';

import type { ConfigResponse, MaskedProvider } from '../../../shared/types';
import {
  ApiError,
  getConfig,
  isRecord,
  putProvider,
  type ProviderWrite,
} from '../api';
import { IconPlug } from '../icons';
import {
  ConflictModal,
  type ConflictInfo,
  type ConflictRow,
} from '../components/ConflictModal';
import { PresenceBadge } from '../components/PresenceBadge';
import { SaveBar } from '../components/SaveBar';

/** Pending user input for one provider; absent key = untouched field. */
interface ProviderEdits {
  name?: string;
  npm?: string;
  baseURL?: string;
  apiKey?: string;
}
type Edits = Record<string, ProviderEdits>;

const TEXT_FIELDS = ['name', 'npm', 'baseURL'] as const;

function providerField(
  entry: MaskedProvider | undefined,
  field: 'name' | 'npm' | 'baseURL',
): string {
  if (!entry) return '';
  if (field === 'baseURL') {
    const options = entry.options;
    return typeof options?.baseURL === 'string' ? options.baseURL : '';
  }
  return typeof entry[field] === 'string' ? (entry[field] as string) : '';
}

function countModels(entry: MaskedProvider | undefined): number {
  return entry && isRecord(entry.models) ? Object.keys(entry.models).length : 0;
}

/**
 * Derive the dirty set from edits vs the current base: a text field counts
 * as changed only when it differs from the loaded value; apiKey counts only
 * when the user actually typed a replacement (replace-only, PC-3).
 */
function dirtyWrites(
  base: ConfigResponse,
  edits: Edits,
): Record<string, ProviderWrite> {
  const writes: Record<string, ProviderWrite> = {};
  for (const [id, entry] of Object.entries(base.providers)) {
    const pending = edits[id];
    if (!pending) continue;
    const write: ProviderWrite = { hash: base.hash };
    let touched = false;
    for (const field of TEXT_FIELDS) {
      const value = pending[field];
      if (value !== undefined && value !== providerField(entry, field)) {
        write[field] = value;
        touched = true;
      }
    }
    if (pending.apiKey !== undefined && pending.apiKey.trim().length > 0) {
      write.apiKey = pending.apiKey;
      touched = true;
    }
    if (touched) writes[id] = write;
  }
  return writes;
}

function countChanges(base: ConfigResponse, edits: Edits): number {
  let n = 0;
  for (const write of Object.values(dirtyWrites(base, edits))) {
    for (const key of Object.keys(write)) if (key !== 'hash') n += 1;
  }
  return n;
}

/** Optimistically fold a committed write into the local masked copy. */
function applyWrite(
  base: ConfigResponse,
  id: string,
  write: ProviderWrite,
  nextHash: string,
): ConfigResponse {
  const entry: MaskedProvider = { ...base.providers[id] };
  if (write.name !== undefined) entry.name = write.name;
  if (write.npm !== undefined) entry.npm = write.npm;
  const options = { ...entry.options };
  if (write.baseURL !== undefined) options.baseURL = write.baseURL;
  // A stored new key flips the presence badge; the value itself never lives
  // in this layer — the server only ever answers with {configured} shapes.
  if (write.apiKey !== undefined) options.apiKey = { configured: true };
  if (Object.keys(options).length > 0) entry.options = options;
  return {
    ...base,
    hash: nextHash,
    providers: { ...base.providers, [id]: entry },
  };
}

function stripApiKeys(edits: Edits): Edits {
  const next: Edits = {};
  for (const [id, pending] of Object.entries(edits)) {
    const { apiKey: _consumed, ...rest } = pending;
    if (Object.keys(rest).length > 0) next[id] = rest;
  }
  return next;
}

/** Diff rows for the conflict modal: pending edits vs the fresh copy. */
function conflictRows(fresh: ConfigResponse, edits: Edits): ConflictRow[] {
  const rows: ConflictRow[] = [];
  for (const [id, pending] of Object.entries(edits)) {
    const entry = fresh.providers[id];
    for (const field of TEXT_FIELDS) {
      const value = pending[field];
      if (value === undefined) continue;
      const current = providerField(entry, field);
      if (value !== current) {
        rows.push({
          path: `provider.${id}.${field === 'baseURL' ? 'options.baseURL' : field}`,
          pending: value,
          current: current === '' ? '(unset)' : current,
        });
      }
    }
    if (pending.apiKey !== undefined && pending.apiKey.trim().length > 0) {
      const configured =
        isRecord(entry?.options?.apiKey) &&
        (entry?.options?.apiKey as Record<string, unknown>).configured === true;
      rows.push({
        path: `provider.${id}.options.apiKey`,
        // The pending value is a real secret — never rendered (CX-2).
        pending: '(new key — hidden)',
        current: configured ? 'Configured — hidden' : 'Not set',
      });
    }
  }
  return rows;
}

type SaveOutcome =
  | { kind: 'ok'; base: ConfigResponse }
  | { kind: 'invalid'; base: ConfigResponse; message: string }
  | { kind: 'stale'; base: ConfigResponse; conflict: ConflictInfo };

/**
 * Run the pending writes sequentially against `startBase`. Every 2xx adopts
 * the echoed hash before the next write (the file legitimately moved); a
 * 409 aborts the chain and fetches the fresh copy for the conflict diff —
 * completed writes stay committed and pending edits survive (SCW-2: reload
 * and reapply must be possible).
 */
async function runSave(
  startBase: ConfigResponse,
  edits: Edits,
): Promise<SaveOutcome> {
  let work = startBase;
  const writes = dirtyWrites(work, edits);
  for (const [id, write] of Object.entries(writes)) {
    try {
      const result = await putProvider(id, { ...write, hash: work.hash });
      work = applyWrite(work, id, write, result.hash);
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
                : write.hash,
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
          .filter(isRecord)
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

export default function ProvidersView() {
  const [base, setBase] = useState<ConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Edits>({});
  const [busy, setBusy] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);

  const reload = useCallback(async () => {
    try {
      setBase(await getConfig());
      setLoadError(null);
    } catch (err) {
      // PC-1: a missing/unparseable CONFIG surfaces as an error state only —
      // the dashboard never creates or repairs the file.
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function setEdit(id: string, field: keyof ProviderEdits, value: string) {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  }

  async function commit(baseArg: ConfigResponse) {
    setBusy(true);
    setValidationError(null);
    const outcome = await runSave(baseArg, edits);
    setBase(outcome.base);
    if (outcome.kind === 'ok') {
      setEdits(stripApiKeys);
      setRestartRequired(true);
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

  const changeCount = countChanges(base, edits);
  const conflictTarget = conflict?.fresh ?? base;

  return (
    <div className="view">
      <header className="view-header">
        <h2>
          <span className="tile tile-blue">
            <IconPlug />
          </span>
          Providers
        </h2>
        <p className="muted">
          Edit provider display name, npm package and base URL. API keys are
          stored opaquely — replace only, never shown.
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

      <div className="cards">
        {Object.entries(base.providers).map(([id, entry]) => (
          <section key={id} role="group" aria-label={id} className="card">
            <header className="card-header">
              <h3 className="mono">{id}</h3>
              <span className="chip">
                {countModels(entry)} model{countModels(entry) === 1 ? '' : 's'}
              </span>
            </header>
            <label htmlFor={`name-${id}`}>Name</label>
            <input
              id={`name-${id}`}
              value={edits[id]?.name ?? providerField(entry, 'name')}
              onChange={(e) => setEdit(id, 'name', e.target.value)}
            />
            <label htmlFor={`npm-${id}`}>npm</label>
            <input
              id={`npm-${id}`}
              className="mono"
              value={edits[id]?.npm ?? providerField(entry, 'npm')}
              onChange={(e) => setEdit(id, 'npm', e.target.value)}
            />
            <label htmlFor={`baseURL-${id}`}>Base URL</label>
            <input
              id={`baseURL-${id}`}
              className="mono"
              value={edits[id]?.baseURL ?? providerField(entry, 'baseURL')}
              onChange={(e) => setEdit(id, 'baseURL', e.target.value)}
            />
            <div className="apikey-head">
              <label htmlFor={`apiKey-${id}`}>API key</label>
              <PresenceBadge apiKey={entry.options?.apiKey} />
            </div>
            {/* Replace-only input (PC-3): never pre-filled — not with a
                value (none exists here, CX-2) and not with the mask shape. */}
            <input
              id={`apiKey-${id}`}
              type="password"
              autoComplete="new-password"
              placeholder="Leave empty to keep it — type to replace"
              value={edits[id]?.apiKey ?? ''}
              onChange={(e) => setEdit(id, 'apiKey', e.target.value)}
            />
          </section>
        ))}
      </div>

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

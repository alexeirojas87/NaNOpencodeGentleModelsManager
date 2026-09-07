// WU7.3 — the Models view: provider selector → per-provider model table
// including empty lists (MC-2), declared-vs-snapshot drift chips (MC-5,
// the design signature — ADVISORY ONLY: the save pipeline never consults
// drift and no declared value is ever rewritten from the snapshot), the
// add form with snapshot pre-fill or manual full-superset input (MC-1/
// MC-3), and confirmed removal where cancel sends no request at all
// (MC-4). All mutations go through the WU5 REST model endpoints (api.ts);
// nothing here touches the filesystem, and provider matching is by
// npm+name metadata — provider ids are data, never constants (PC-4).
import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  CatalogResponse,
  ConfigResponse,
  DriftCell,
  MaskedProvider,
  ModelConfig,
} from '../../../shared/types';
import {
  ApiError,
  deleteModel,
  getCatalog,
  getConfig,
  getStatus,
  isRecord,
  postModel,
  putModel,
} from '../api';
import { IconCube, IconPlus } from '../icons';
import { SaveBar } from '../components/SaveBar';

// --- form draft ------------------------------------------------------------

/** Raw input state; empty string means "absent" — never invented (MC-1). */
interface Draft {
  modelId: string;
  id: string;
  name: string;
  family: string;
  releaseDate: string;
  contextWindow: string;
  attachment: string;
  reasoning: string;
  temperature: string;
  toolCall: string;
  interleaved: string;
  modalitiesInput: string;
  modalitiesOutput: string;
  cost: string;
}

const BLANK: Draft = {
  modelId: '',
  id: '',
  name: '',
  family: '',
  releaseDate: '',
  contextWindow: '',
  attachment: '',
  reasoning: '',
  temperature: '',
  toolCall: '',
  interleaved: '',
  modalitiesInput: '',
  modalitiesOutput: '',
  cost: '',
};

type Drawer =
  | { kind: 'add'; provider: string; draft: Draft }
  | { kind: 'edit'; provider: string; modelId: string; draft: Draft };

interface PendingOp {
  kind: 'add' | 'edit';
  provider: string;
  modelId: string;
  model: ModelConfig;
}

function draftFromDeclared(entry: ModelConfig): Draft {
  const bool = (v: unknown) => (v === true || v === false ? String(v) : '');
  const mod = isRecord(entry.modalities) ? entry.modalities : undefined;
  const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');
  const interleaved =
    typeof entry.interleaved === 'boolean' ||
    typeof entry.interleaved === 'string'
      ? String(entry.interleaved)
      : isRecord(entry.interleaved)
        ? JSON.stringify(entry.interleaved)
        : '';
  return {
    ...BLANK,
    modelId: '',
    id: typeof entry.id === 'string' ? entry.id : '',
    name: typeof entry.name === 'string' ? entry.name : '',
    family: typeof entry.family === 'string' ? entry.family : '',
    releaseDate:
      typeof entry.release_date === 'string' ? entry.release_date : '',
    contextWindow:
      typeof entry.contextWindow === 'number'
        ? String(entry.contextWindow)
        : '',
    attachment: bool(entry.attachment),
    reasoning: bool(entry.reasoning),
    temperature: bool(entry.temperature),
    toolCall: bool(entry.tool_call),
    interleaved,
    modalitiesInput: list(mod?.input),
    modalitiesOutput: list(mod?.output),
    cost: isRecord(entry.cost) ? JSON.stringify(entry.cost) : '',
  };
}

/** MC-3: pre-fill only what the snapshot actually records — nothing guessed. */
function draftFromCatalogEntry(
  modelId: string,
  entry: Record<string, unknown>,
): Draft {
  const mod = isRecord(entry['modalities']) ? entry['modalities'] : undefined;
  const list = (v: unknown) => (Array.isArray(v) ? v.join(', ') : '');
  return {
    ...BLANK,
    modelId,
    name: typeof entry['name'] === 'string' ? entry['name'] : '',
    contextWindow:
      typeof entry['contextWindow'] === 'number'
        ? String(entry['contextWindow'])
        : '',
    modalitiesInput: list(mod?.['input']),
    modalitiesOutput: list(mod?.['output']),
  };
}

function buildModel(draft: Draft): {
  model: ModelConfig;
  error: string | null;
} {
  const model: ModelConfig = {};
  const text = (v: string): string | undefined =>
    v.trim() === '' ? undefined : v.trim();
  const bool = (v: string): boolean | undefined =>
    v === 'true' ? true : v === 'false' ? false : undefined;
  if (text(draft.id) !== undefined) model.id = text(draft.id);
  if (text(draft.name) !== undefined) model.name = text(draft.name);
  if (text(draft.family) !== undefined) model.family = text(draft.family);
  if (text(draft.releaseDate) !== undefined)
    model.release_date = text(draft.releaseDate);
  const ctx = text(draft.contextWindow);
  if (ctx !== undefined) {
    const n = Number(ctx);
    if (!Number.isFinite(n)) {
      return { model, error: 'contextWindow must be a finite number.' };
    }
    model.contextWindow = n;
  }
  if (bool(draft.attachment) !== undefined)
    model.attachment = bool(draft.attachment);
  if (bool(draft.reasoning) !== undefined)
    model.reasoning = bool(draft.reasoning);
  if (bool(draft.temperature) !== undefined)
    model.temperature = bool(draft.temperature);
  if (bool(draft.toolCall) !== undefined)
    model.tool_call = bool(draft.toolCall);
  const inter = text(draft.interleaved);
  if (inter !== undefined) {
    if (inter === 'true' || inter === 'false') {
      model.interleaved = inter === 'true';
    } else if (inter.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(inter);
        if (!isRecord(parsed)) throw new Error('not an object');
        model.interleaved = parsed;
      } catch {
        return { model, error: 'interleaved object must be valid JSON.' };
      }
    } else {
      model.interleaved = inter;
    }
  }
  const modalities: Record<string, string[]> = {};
  const ins = draft.modalitiesInput
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const outs = draft.modalitiesOutput
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ins.length > 0) modalities['input'] = ins;
  if (outs.length > 0) modalities['output'] = outs;
  if (Object.keys(modalities).length > 0) model.modalities = modalities;
  const cost = text(draft.cost);
  if (cost !== undefined) {
    try {
      const parsed: unknown = JSON.parse(cost);
      if (!isRecord(parsed)) throw new Error('not an object');
      model.cost = parsed;
    } catch {
      return { model, error: 'cost must be a JSON object.' };
    }
  }
  return { model, error: null };
}

/** Edit writes only the fields that actually differ (additive merge PUT). */
function diffAgainstDeclared(
  declared: ModelConfig,
  model: ModelConfig,
): ModelConfig {
  const changes: ModelConfig = {};
  for (const [key, value] of Object.entries(model)) {
    if (JSON.stringify(declared[key]) !== JSON.stringify(value)) {
      changes[key] = value;
    }
  }
  return changes;
}

function modelsOf(
  entry: MaskedProvider | undefined,
): Record<string, ModelConfig> {
  return entry && isRecord(entry.models)
    ? (entry.models as Record<string, ModelConfig>)
    : {};
}

/**
 * Display-side mirror of the server snapshot match (catalog/index.ts):
 * npm + name metadata, never the provider id. Only gates picker/chrome
 * presentation — drift cells themselves always come from the server.
 */
function providerMatchesCatalog(
  entry: MaskedProvider | undefined,
  catalog: CatalogResponse | null,
): boolean {
  return (
    !!catalog &&
    !!entry &&
    entry.npm === catalog.provider.npm &&
    entry.name === catalog.provider.name
  );
}

const NUM_FIELDS: [keyof Draft, string][] = [
  ['contextWindow', 'Context window'],
];
const BOOL_FIELDS: [keyof Draft, string][] = [
  ['attachment', 'Attachment'],
  ['reasoning', 'Reasoning'],
  ['temperature', 'Temperature'],
  ['toolCall', 'Tool calling'],
];
const TEXT_FIELDS: [keyof Draft, string][] = [
  ['id', 'Entry id'],
  ['name', 'Name'],
  ['family', 'Family'],
  ['releaseDate', 'Release date'],
  ['interleaved', 'Interleaved'],
  ['modalitiesInput', 'Modalities in'],
  ['modalitiesOutput', 'Modalities out'],
  ['cost', 'Cost (JSON)'],
];

export default function ModelsView() {
  const [base, setBase] = useState<ConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drift, setDrift] = useState<DriftCell[]>([]);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState<PendingOp[]>([]);
  const [confirming, setConfirming] = useState<{
    provider: string;
    modelId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  // One pass: config is mandatory; drift/catalog degrade independently so a
  // server without the WU7 bundle still lists and edits models.
  const reload = useCallback(async () => {
    try {
      const [config, status, cat] = await Promise.all([
        getConfig(),
        getStatus().catch(() => null),
        getCatalog().catch(() => null),
      ]);
      setBase(config);
      setSelected((prev) => prev ?? Object.keys(config.providers)[0] ?? null);
      setDrift(status ? [...status.drift] : []);
      setCatalog(cat);
      setLoadError(null);
    } catch (err) {
      // PC-1: a missing/unparseable CONFIG surfaces as an error — never repaired.
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const driftByKey = useMemo(() => {
    const map = new Map<string, DriftCell[]>();
    for (const cell of drift) {
      const key = `${cell.provider}|${cell.model}`;
      map.set(key, [...(map.get(key) ?? []), cell]);
    }
    return map;
  }, [drift]);

  const driftFor = (provider: string, modelId: string): DriftCell[] =>
    driftByKey.get(`${provider}|${modelId}`) ?? [];

  /** The slot an open drawer occupies in the pending queue. */
  function drawerSlot(d: Drawer): string {
    return `${d.provider}|${d.kind === 'edit' ? d.modelId : d.draft.modelId.trim()}`;
  }

  /**
   * Re-sync the drawer's slot: clear its previous key, insert the fresh op.
   * Undoing every edit back to the declared values therefore returns the
   * count to zero (no stale writes), and an add whose id is retyped never
   * leaves a ghost entry behind.
   */
  function resyncDrawer(oldSlot: string | null, op: PendingOp | null) {
    setPending((prev) => {
      const opKey = op ? `${op.provider}|${op.modelId}` : null;
      const rest = prev.filter((p) => {
        const key = `${p.provider}|${p.modelId}`;
        if (oldSlot !== null && key === oldSlot) return false;
        if (opKey !== null && key === opKey) return false;
        return true;
      });
      return op ? [...rest, op] : rest;
    });
  }

  /** Recompute the drawer's pending write; null error+op means "no change". */
  function commitDraft(d: Drawer): {
    op: PendingOp | null;
    error: string | null;
  } {
    const built = buildModel(d.draft);
    if (built.error) return { op: null, error: built.error };
    if (d.kind === 'add') {
      const modelId = d.draft.modelId.trim();
      if (modelId === '') {
        return { op: null, error: 'Model id is required to add an entry.' };
      }
      return {
        op: { kind: 'add', provider: d.provider, modelId, model: built.model },
        error: null,
      };
    }
    const declared = modelsOf(base?.providers[d.provider])[d.modelId] ?? {};
    const changes = diffAgainstDeclared(declared, built.model);
    if (Object.keys(changes).length === 0) {
      return { op: null, error: null }; // untouched form = nothing pending
    }
    return {
      op: {
        kind: 'edit',
        provider: d.provider,
        modelId: d.modelId,
        model: changes,
      },
      error: null,
    };
  }

  function editDraft(field: keyof Draft, value: string) {
    if (!drawer) return;
    const oldSlot = drawerSlot(drawer);
    const next: Drawer = {
      ...drawer,
      draft: { ...drawer.draft, [field]: value },
    };
    setDrawer(next);
    const { op, error } = commitDraft(next);
    resyncDrawer(oldSlot, op);
    setValidationError(error);
  }

  function openAdd(draft: Draft) {
    if (!base) return;
    const next: Drawer = { kind: 'add', provider: selectedProvider, draft };
    setPickerOpen(false);
    const oldSlot = drawer ? drawerSlot(drawer) : null;
    setDrawer(next);
    const { op, error } = commitDraft(next);
    resyncDrawer(oldSlot, op);
    setValidationError(error);
  }

  function openEdit(modelId: string) {
    if (!base) return;
    const entry = modelsOf(base.providers[selectedProvider])[modelId];
    const oldSlot = drawer ? drawerSlot(drawer) : null;
    const next: Drawer = {
      kind: 'edit',
      provider: selectedProvider,
      modelId,
      draft: { ...draftFromDeclared(entry), modelId },
    };
    setDrawer(next);
    resyncDrawer(oldSlot, null); // an untouched edit form is not a change
    setValidationError(null);
  }

  function closeDrawer() {
    setDrawer(null);
    setValidationError(null);
  }

  function foldWrite(
    pid: string,
    mid: string,
    model: ModelConfig,
    hash: string,
  ) {
    setBase((prev) => {
      if (!prev) return prev;
      const entry = {
        ...prev.providers[pid],
        models: {
          ...modelsOf(prev.providers[pid]),
          [mid]: { ...modelsOf(prev.providers[pid])[mid], ...model },
        },
      };
      return { ...prev, hash, providers: { ...prev.providers, [pid]: entry } };
    });
  }

  async function saveAll() {
    if (!base) return;
    setBusy(true);
    setValidationError(null);
    let work = base;
    let failure: string | null = null;
    const flushed: PendingOp[] = [];
    for (const op of pending) {
      try {
        const result =
          op.kind === 'add'
            ? await postModel(op.provider, op.modelId, op.model, work.hash)
            : await putModel(op.provider, op.modelId, op.model, work.hash);
        // SCW-2: the echoed hash is always the next valid base.
        work = { ...work, hash: result.hash };
        foldWrite(op.provider, op.modelId, op.model, result.hash);
        flushed.push(op);
      } catch (err) {
        failure =
          err instanceof ApiError && Array.isArray(err.detail['issues'])
            ? `${err.message} ${(
                err.detail['issues'] as { path: string; message: string }[]
              )
                .map((i) => `${i.path}: ${i.message}`)
                .join(' · ')}`
            : err instanceof Error
              ? err.message
              : String(err);
        break;
      }
    }
    setPending((prev) => prev.filter((op) => !flushed.includes(op)));
    if (!failure) {
      setDrawer(null);
      setRestartRequired(true); // CX-3 — every successful save ships the notice
    } else {
      setValidationError(failure); // pending edits survive (SCW-2)
    }
    setBusy(false);
  }

  async function confirmRemove() {
    if (!confirming || !base) return;
    setBusy(true);
    setValidationError(null);
    try {
      const result = await deleteModel(
        confirming.provider,
        confirming.modelId,
        base.hash,
      );
      setBase((prev) => {
        if (!prev) return prev;
        const models = { ...modelsOf(prev.providers[confirming.provider]) };
        delete models[confirming.modelId];
        return {
          ...prev,
          hash: result.hash,
          providers: {
            ...prev.providers,
            [confirming.provider]: {
              ...prev.providers[confirming.provider],
              models,
            },
          },
        };
      });
      setRestartRequired(true);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : String(err));
    }
    setConfirming(null);
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

  const providers = Object.keys(base.providers);
  const selectedProvider = selected ?? providers[0] ?? '';
  const models = modelsOf(base.providers[selectedProvider]);
  const selectedDrift = drift.filter((c) => c.provider === selectedProvider);
  const catalogMatch = providerMatchesCatalog(
    base.providers[selectedProvider],
    catalog,
  );

  return (
    <div className="view">
      <header className="view-header">
        <h2>
          <span className="tile tile-purple">
            <IconCube />
          </span>
          Models
        </h2>
        <p className="muted">
          Declared model entries per provider. Snapshot values are shown
          side-by-side as advisory — your declared values always win.
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

      <div className="models-toolbar">
        <label htmlFor="models-provider">Provider</label>
        <select
          id="models-provider"
          value={selectedProvider}
          onChange={(e) => {
            setSelected(e.target.value);
            closeDrawer();
          }}
        >
          {providers.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setPickerOpen(true)}
        >
          <IconPlus /> Add model
        </button>
        {selectedDrift.length > 0 && (
          <span className="muted drift-note">
            {selectedDrift.length} advisory drift cell
            {selectedDrift.length === 1 ? '' : 's'} vs snapshot (never
            auto-corrected)
          </span>
        )}
      </div>

      {Object.keys(models).length === 0 ? (
        <div className="panel">
          <p className="muted" role="status">
            No models declared
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="models-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Name</th>
                <th>Context window</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {Object.entries(models).map(([modelId, entry]) => {
                const cells = driftFor(selectedProvider, modelId);
                return (
                  <tr key={modelId} aria-label={modelId}>
                    <td className="mono">{modelId}</td>
                    <td>{typeof entry.name === 'string' ? entry.name : '—'}</td>
                    <td>
                      {typeof entry.contextWindow === 'number' &&
                        cells.length === 0 && (
                          <span className="mono">
                            {String(entry.contextWindow)}
                          </span>
                        )}
                      {cells.map((cell) => (
                        <span key={cell.field} className="drift-pair">
                          <span className="mono">{String(cell.declared)}</span>
                          <span className="muted">vs snapshot</span>
                          <span className="mono">{String(cell.snapshot)}</span>
                          <span
                            className="chip chip-drift"
                            title="Advisory only — the declared value is saved verbatim (MC-5)"
                          >
                            drift
                          </span>
                        </span>
                      ))}
                      {typeof entry.contextWindow !== 'number' &&
                        cells.length === 0 && <span className="muted">—</span>}
                    </td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className="btn"
                        onClick={() => openEdit(modelId)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          setConfirming({ provider: selectedProvider, modelId })
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {drawer && (
        <form
          className="panel model-drawer"
          aria-label={
            drawer.kind === 'edit'
              ? `Edit model ${drawer.modelId}`
              : `Add model ${drawer.draft.modelId.trim() === '' ? '(manual)' : drawer.draft.modelId.trim()}`
          }
          onSubmit={(e) => e.preventDefault()}
        >
          <div className="card-header">
            <h3>
              {drawer.kind === 'edit' ? `Edit ${drawer.modelId}` : 'Add model'}
            </h3>
            <button type="button" className="btn" onClick={closeDrawer}>
              Close
            </button>
          </div>
          <label htmlFor="draft-modelId">Model id</label>
          <input
            id="draft-modelId"
            className="mono"
            value={drawer.draft.modelId}
            disabled={drawer.kind === 'edit'}
            onChange={(e) => editDraft('modelId', e.target.value)}
          />
          {TEXT_FIELDS.map(([field, label]) => (
            <div key={field}>
              <label htmlFor={`draft-${field}`}>{label}</label>
              <input
                id={`draft-${field}`}
                className="mono"
                value={drawer.draft[field]}
                onChange={(e) => editDraft(field, e.target.value)}
              />
            </div>
          ))}
          {NUM_FIELDS.map(([field, label]) => (
            <div key={field}>
              <label htmlFor={`draft-${field}`}>{label}</label>
              <input
                id={`draft-${field}`}
                className="mono"
                inputMode="numeric"
                value={drawer.draft[field]}
                onChange={(e) => editDraft(field, e.target.value)}
              />
            </div>
          ))}
          <div className="bool-grid">
            {BOOL_FIELDS.map(([field, label]) => (
              <div key={field}>
                <label htmlFor={`draft-${field}`}>{label}</label>
                <select
                  id={`draft-${field}`}
                  value={drawer.draft[field]}
                  onChange={(e) => editDraft(field, e.target.value)}
                >
                  <option value="">unset</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              </div>
            ))}
          </div>
        </form>
      )}

      {pickerOpen && (
        <div
          className="overlay"
          role="dialog"
          aria-label="Add model"
          aria-modal="true"
        >
          <div className="modal">
            <h2>Add model to “{selectedProvider}”</h2>
            {catalogMatch && catalog && (
              <>
                <p className="modal-note">
                  From the bundled NaN snapshot (asOf {catalog.asOf}) — only
                  recorded fields pre-fill; nothing is guessed.
                </p>
                <div className="catalog-list">
                  {Object.entries(catalog.models).map(([modelId, entry]) => (
                    <div key={modelId} className="catalog-item">
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          openAdd(
                            draftFromCatalogEntry(
                              modelId,
                              entry as Record<string, unknown>,
                            ),
                          )
                        }
                      >
                        {modelId}
                      </button>
                      {typeof entry.contextDocs === 'string' && (
                        <span className="muted mono">{entry.contextDocs}</span>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
            <p className="modal-note">
              {catalogMatch
                ? 'Or enter every field manually.'
                : 'This provider does not match the bundled catalog — manual entry only.'}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => openAdd({ ...BLANK })}
              >
                Manual entry
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setPickerOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {confirming && (
        <div
          className="overlay"
          role="alertdialog"
          aria-label={`Remove ${confirming.modelId}?`}
          aria-modal="true"
        >
          <div className="modal">
            <h2>Remove “{confirming.modelId}”?</h2>
            <p className="modal-note">
              This deletes provider.{confirming.provider}.models[ “
              {confirming.modelId}”] on save. Cancel sends no request and leaves
              the entry untouched (MC-4).
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void confirmRemove()}
                disabled={busy}
              >
                Confirm remove
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setConfirming(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <SaveBar
        changeCount={pending.length}
        busy={busy}
        validationError={validationError}
        onSave={() => void saveAll()}
        onDiscard={() => {
          setPending([]);
          closeDrawer();
        }}
      />
    </div>
  );
}

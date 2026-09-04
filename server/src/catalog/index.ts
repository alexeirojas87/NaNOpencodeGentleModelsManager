// WU7.1 — the bundled NaN catalog and the drift oracle. The snapshot ships
// offline with the app (CX-4): routes import this module, the runtime never
// reaches the network. Provenance of every value lives in the JSON itself
// (docs transcription via the exploration record — no machine-readable NaN
// catalog endpoint exists, so nothing is fetched and nothing is invented).
//
// Drift rules (spec MC-5, design §UI): a drift cell exists when a declared
// model contextWindow differs from the snapshot value for the same model id.
// Drift is ADVISORY — this module only READS the tree; it is not part of the
// save pipeline and can never rewrite or block anything. Providers match the
// snapshot by its npm+name metadata, never by a provider id (PC-4: the nan
// id is data here, not a constant — a different provider gets no drift data).
import snapshotJson from './nan-snapshot.json';

import type {
  CatalogResponse,
  ConfigTree,
  DriftCell,
  SnapshotModelEntry,
} from '../../../shared/types';

export type { CatalogResponse, DriftCell, SnapshotModelEntry };

/** The bundled snapshot document, typed at the shared DTO boundary. */
export const nanSnapshot = snapshotJson as CatalogResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Snapshot↔provider match: npm package AND display name must equal the
 * snapshot's provider metadata. Deliberately ignores the CONFIG provider id
 * — ids are user-owned keys, so any provider wired to this npm+name pair
 * gets catalog data and a different one gets none (generic 0..N, PC-4).
 * `providerId` exists only for future diagnostics; it is never consulted.
 * Acts as a type guard so callers can trust the returned shape.
 */
export function providerMatchesSnapshot(
  entry: unknown,
  providerId?: string,
  snapshot: CatalogResponse = nanSnapshot,
): entry is Record<string, unknown> {
  void providerId; // never a match key — documented guard against regression
  if (!isRecord(entry)) return false;
  return (
    entry.npm === snapshot.provider.npm && entry.name === snapshot.provider.name
  );
}

/** Numeric-only comparison guard: non-finite/absent values never drift. */
function comparable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Declared-vs-snapshot drift cells for a whole CONFIG tree (advisory only).
 * Iteration order = provider/model insertion order, so cells are stable
 * (the drift golden below depends on it). Models absent from the snapshot,
 * models without a numeric contextWindow, and non-matching providers
 * contribute nothing — the dashboard never guesses (MC-5).
 */
export function computeDrift(
  tree: ConfigTree,
  snapshot: CatalogResponse = nanSnapshot,
): DriftCell[] {
  const cells: DriftCell[] = [];
  for (const [providerId, raw] of Object.entries(tree.provider ?? {})) {
    if (!providerMatchesSnapshot(raw, providerId, snapshot)) continue;
    const models = isRecord(raw.models) ? raw.models : {};
    for (const [modelId, model] of Object.entries(models)) {
      const declared = isRecord(model) ? model.contextWindow : undefined;
      const snapEntry = snapshot.models[modelId];
      if (!snapEntry || !comparable(declared)) continue;
      const snapshotValue = snapEntry.contextWindow;
      if (!comparable(snapshotValue) || snapshotValue === declared) continue;
      cells.push({
        provider: providerId,
        model: modelId,
        field: 'contextWindow',
        declared,
        snapshot: snapshotValue,
        advisory: true,
      });
    }
  }
  return cells;
}

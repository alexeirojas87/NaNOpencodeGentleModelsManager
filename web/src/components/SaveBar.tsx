// WU6 (design §UI) — the sticky save bar: `N changes · validation state ·
// Save · Discard`. Validation failures from the API (400 invalid/off-
// allowlist) render inline so the pending edits stay visible and fixable.
export interface SaveBarProps {
  changeCount: number;
  busy: boolean;
  validationError: string | null;
  onSave: () => void;
  onDiscard: () => void;
}

export function SaveBar({
  changeCount,
  busy,
  validationError,
  onSave,
  onDiscard,
}: SaveBarProps) {
  const label =
    changeCount === 0
      ? 'No changes'
      : `${changeCount} change${changeCount === 1 ? '' : 's'}`;
  return (
    <section className="savebar" aria-label="Pending changes">
      <span className="savebar-count">{label}</span>
      {validationError && (
        <span className="savebar-error" role="alert">
          {validationError}
        </span>
      )}
      <span className="savebar-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onSave}
          disabled={busy || changeCount === 0}
        >
          Save
        </button>
        <button
          type="button"
          className="btn"
          onClick={onDiscard}
          disabled={busy || changeCount === 0}
        >
          Discard
        </button>
      </span>
    </section>
  );
}

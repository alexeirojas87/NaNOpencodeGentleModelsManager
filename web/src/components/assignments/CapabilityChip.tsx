// role-model-assignment WU-3 — advisory capability chips (spec
// "capability-warnings"; design D10 + C1). The comparison is a PURE
// function over the DECLARED ModelConfig flags and the phase needs:
//   reasoning   ↔ model.reasoning
//   tools       ↔ model.tool_call
//   big-context ↔ model.contextWindow (declared value below the bar)
// and — C1 reconciliation — declared modalities lacking text input warn on
// ANY assignment, so the covered flag set is reasoning, tool_call,
// contextWindow AND modalities, matching the spec enumeration.
// MISSING flags never warn (absence of evidence is not evidence), and a
// warning is ADVISORY: it renders a chip but must never disable Apply.
import type { ModelConfig } from '../../../../shared/types';
import type { PhaseNeed } from './phaseKnowledge';

/** Declared contextWindow at or above this counts as "big context". */
export const BIG_CONTEXT_MIN_TOKENS = 1_000_000;

/**
 * One advisory string for every unmet need, or null when the assignment is
 * compatible (or the model declares nothing — missing flags yield no chip).
 */
export function capabilityWarning(
  model: ModelConfig | undefined,
  needs: PhaseNeed[],
): string | null {
  if (!model) return null;
  const warnings: string[] = [];
  if (needs.includes('reasoning') && model.reasoning === false) {
    warnings.push('no reasoning');
  }
  if (needs.includes('tools') && model.tool_call === false) {
    warnings.push('no tool support');
  }
  if (
    needs.includes('big-context') &&
    typeof model.contextWindow === 'number' &&
    model.contextWindow < BIG_CONTEXT_MIN_TOKENS
  ) {
    warnings.push('small context window');
  }
  const input = model.modalities?.input;
  if (Array.isArray(input) && !input.includes('text')) {
    warnings.push('no text input modality');
  }
  return warnings.length > 0 ? warnings.join(' · ') : null;
}

/** The advisory chip — renders nothing when the assignment is compatible. */
export function CapabilityChip({
  model,
  needs,
}: {
  model: ModelConfig | undefined;
  needs: PhaseNeed[];
}) {
  const warning = capabilityWarning(model, needs);
  if (!warning) return null;
  return (
    <span className="chip">
      <span className="ro-flag">advisory</span> {warning}
    </span>
  );
}

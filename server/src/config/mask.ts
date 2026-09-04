// WU2.2 — response masking (PC-2 data layer, CX-2).
// maskConfig() produces the outbound view of CONFIG: every existing
// `provider.<id>.options.apiKey` VALUE is replaced by a {configured:boolean}
// presence indicator. The secret never enters the returned tree — not as a
// value, not as a key — and the input tree is never mutated, so the server
// keeps the verbatim bytes for pass-through saves (PC-3).
//
// Presence semantics:
//  - apiKey present, non-empty string      → { configured: true }
//  - apiKey present, empty or non-string   → { configured: false }
//  - apiKey key absent                     → stays absent (nothing invented,
//    consistent with MC-1 "absent fields must not be invented").
//
// WU5 builds the masked API DTOs (shared/types.ts) on top of this output.
import type { ConfigTree } from './load';

/** Masked stand-in for an apiKey value (PC-2 presence badge source). */
export interface ApiKeyPresence {
  configured: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function maskOptions(options: unknown): unknown {
  if (!isRecord(options)) return structuredClone(options);
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === 'apiKey') {
      const presence: ApiKeyPresence = {
        configured: typeof value === 'string' && value.length > 0,
      };
      masked[key] = presence;
    } else {
      masked[key] = structuredClone(value);
    }
  }
  return masked;
}

function maskProvider(provider: unknown): unknown {
  if (!isRecord(provider)) return structuredClone(provider);
  const masked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(provider)) {
    masked[key] =
      key === 'options' ? maskOptions(value) : structuredClone(value);
  }
  return masked;
}

function maskProviders(node: unknown): unknown {
  if (!isRecord(node)) return structuredClone(node);
  const masked: Record<string, unknown> = {};
  // Generic over 0..N provider ids — nothing hardcoded (PC-4).
  for (const [id, provider] of Object.entries(node)) {
    masked[id] = maskProvider(provider);
  }
  return masked;
}

/**
 * Return a structurally independent copy of `tree` in which apiKey VALUES
 * are replaced by presence indicators. Key order is preserved everywhere;
 * everything outside `provider.*.options.apiKey` is carried over deep-equal.
 */
export function maskConfig(tree: ConfigTree): ConfigTree {
  const masked: ConfigTree = {};
  for (const [key, value] of Object.entries(tree)) {
    masked[key] =
      key === 'provider' ? maskProviders(value) : structuredClone(value);
  }
  return masked;
}

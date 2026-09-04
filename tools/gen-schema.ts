// WU3.1 — one-off generator for shared/schema.generated.ts.
// Fetches https://opencode.ai/config.json exactly ONCE and derives a
// permissive zod schema from the upstream JSON Schema. Policy (spec SCW-7 /
// CX-4 / design "Validation"):
//   - unknown keys are NEVER rejected: every object is emitted loose
//     (.passthrough()); `additionalProperties: false` is ignored on purpose;
//   - `required` is ignored — a config that merely omits a field is valid;
//   - enums/consts collapse to their base primitive type so upstream
//     vocabulary drift can never false-reject an existing CONFIG;
//   - anything the walker cannot understand degrades to z.unknown().
// If the fetch is unreachable or the response is not the expected JSON
// Schema, the script FAILS loudly and writes NOTHING — the committed schema
// is always genuine upstream bytes (never fabricated), with provenance
// (fetched-at + sha256) in the generated header.
//
// Usage: pnpm exec tsx tools/gen-schema.ts
// After generating: pnpm exec prettier --write shared/schema.generated.ts
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const SOURCE_URL = 'https://opencode.ai/config.json';
const OUT_PATH = new URL('../shared/schema.generated.ts', import.meta.url);

function fail(message: string): never {
  console.error(`gen-schema: ${message}`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Local refs (#/$defs/X) become lazy const references; anything else is unknown. */
function refToDefName(ref: unknown): string | null {
  if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) return null;
  const raw = ref.slice('#/$defs/'.length);
  if (!raw || !/^[A-Za-z0-9_$]+$/.test(sanitize(raw))) return null;
  return `def_${sanitize(raw)}`;
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, '_');
}

/** Permissive primitive type for an enum node (collapse, never constrain). */
function enumBaseType(values: unknown[]): string {
  const kinds = new Set(values.map((v) => typeof v));
  if (kinds.size === 1) {
    const kind = [...kinds][0];
    if (kind === 'string') return 'z.string()';
    if (kind === 'number') return 'z.number()';
    if (kind === 'boolean') return 'z.boolean()';
  }
  return 'z.unknown()';
}

function primitiveSchema(type: string): string {
  switch (type) {
    case 'string':
      return 'z.string()';
    case 'number':
    case 'integer':
      return 'z.number()';
    case 'boolean':
      return 'z.boolean()';
    case 'null':
      return 'z.null()';
    default:
      return 'z.unknown()';
  }
}

/** Convert one JSON Schema node to a zod expression (permissive policy above). */
function convert(node: unknown): string {
  if (node === true) return 'z.unknown()';
  if (!isRecord(node)) return 'z.unknown()';

  if (typeof node.$ref === 'string') {
    const def = refToDefName(node.$ref);
    return def ? `z.lazy(() => ${def})` : 'z.unknown()';
  }
  if ('const' in node) return `z.unknown()`; // vocabulary drift must not false-reject
  if (Array.isArray(node.enum)) return enumBaseType(node.enum);
  for (const combinator of ['anyOf', 'oneOf'] as const) {
    const members = node[combinator];
    if (Array.isArray(members) && members.length > 0) {
      const parts = members.map(convert);
      return parts.length === 1 ? parts[0] : `z.union([${parts.join(', ')}])`;
    }
  }
  if (Array.isArray(node.allOf)) return 'z.unknown()';

  const properties = node.properties;
  const asObject = (): string => {
    const additional = node.additionalProperties;
    const named =
      isRecord(properties) && Object.keys(properties).length > 0
        ? `z.object({ ${Object.entries(properties)
            .map(
              ([key, sub]) =>
                `${JSON.stringify(key)}: ${convert(sub)}.optional()`,
            )
            .join(', ')} }).passthrough()`
        : null;
    if (named && isRecord(additional)) {
      // Both named and patterned keys (e.g. `agent`): every value must satisfy
      // the additionalProperties schema — intersection keeps named checks from
      // being swallowed by passthrough, and stays loose on unknown keys.
      return `z.intersection(${named}, z.record(z.string(), ${convert(additional)}))`;
    }
    if (named) return named;
    if (isRecord(additional)) {
      return `z.record(z.string(), ${convert(additional)})`;
    }
    return 'z.object({}).passthrough()';
  };

  const type = node.type;
  if (typeof type === 'string') {
    if (type === 'array') {
      return isRecord(node.items) || node.items === true
        ? `z.array(${convert(node.items)})`
        : 'z.array(z.unknown())';
    }
    if (type === 'object') return asObject();
    return primitiveSchema(type);
  }
  if (Array.isArray(type)) {
    const parts = type.map((t) =>
      typeof t === 'string' && t === 'object'
        ? asObject()
        : primitiveSchema(String(t)),
    );
    return `z.union([${parts.join(', ')}])`;
  }
  // No usable `type` — infer object shape when properties are declared.
  if (isRecord(properties)) return asObject();
  return 'z.unknown()';
}

async function main(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    fail(`could not fetch ${SOURCE_URL}: ${(err as Error).message}`);
  }
  if (!response.ok) {
    fail(
      `fetch ${SOURCE_URL} returned HTTP ${response.status} — nothing written.`,
    );
  }
  const text = await response.text();
  let upstream: unknown;
  try {
    upstream = JSON.parse(text);
  } catch (err) {
    fail(
      `response from ${SOURCE_URL} is not valid JSON (${(err as Error).message}) — nothing written.`,
    );
  }
  if (
    !isRecord(upstream) ||
    !isRecord(upstream.$defs) ||
    (typeof upstream.$ref !== 'string' && !isRecord(upstream.properties))
  ) {
    fail(
      `response from ${SOURCE_URL} is not the expected JSON Schema — nothing written.`,
    );
  }

  const lines: string[] = [
    '// GENERATED FILE — DO NOT EDIT BY HAND.',
    `// Source: ${SOURCE_URL}`,
    `// Fetched: ${new Date().toISOString()} · sha256: ${createHash('sha256').update(text, 'utf8').digest('hex')}`,
    '// Regenerate: pnpm exec tsx tools/gen-schema.ts && pnpm exec prettier --write shared/schema.generated.ts',
    '// Policy: permissive passthrough (unknown keys never rejected — SCW-7/CX-4);',
    '// required/enum constraints intentionally dropped to avoid false rejects.',
    "import { z } from 'zod';",
    '',
  ];
  for (const [name, def] of Object.entries(upstream.$defs)) {
    lines.push(
      `const ${`def_${sanitize(name)}`}: z.ZodTypeAny = ${convert(def)};`,
    );
  }
  lines.push('');
  lines.push(`export const configSchema: z.ZodTypeAny = ${convert(upstream)};`);
  lines.push('');

  writeFileSync(OUT_PATH, lines.join('\n'), 'utf8');
  console.log(
    `gen-schema: wrote ${OUT_PATH.pathname} (${lines.length} source lines, upstream sha256 recorded)`,
  );
}

void main();

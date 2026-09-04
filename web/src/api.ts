// WU6 — the web client for the WU5 REST API. All mutations flow through
// these fetch calls: the browser never touches the filesystem, and apiKey
// values never exist in this layer (CX-2 — the server ships masked
// {configured} presences only; writes carry user-typed strings or nothing).
// WU7 extends it with the model-entry CRUD calls plus the status/catalog
// reads the Models view needs. DTOs are the shared contracts from
// shared/types.ts, never redeclared here.
import type {
  CatalogResponse,
  ConfigResponse,
  ModelConfig,
  StatusResponse,
  SyncResponse,
  WriteResponse,
} from '../../shared/types';

/** Shape guard for JSON payloads of unknown origin. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A failed API call carrying the server error envelope
 * ({ok:false, error:{code, message, ...}} from routes/http.ts) so callers
 * can branch on HTTP status and read extras like {expected, actual} for the
 * SCW-2 conflict flow or {issues[]} for SCW-3 validation display.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request(
  method: string,
  url: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers:
      body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // Non-JSON body: fall through to the generic status error below.
  }
  if (!res.ok) {
    const envelope =
      isRecord(payload) && isRecord(payload.error) ? payload.error : null;
    const code =
      typeof envelope?.code === 'string' ? envelope.code : `http_${res.status}`;
    const message =
      typeof envelope?.message === 'string'
        ? envelope.message
        : `Request failed with status ${res.status}.`;
    const detail: Record<string, unknown> = envelope ? { ...envelope } : {};
    delete detail.code;
    delete detail.message;
    throw new ApiError(res.status, code, message, detail);
  }
  return payload;
}

/** Masked whole-config snapshot: hash + providers/agents, apiKey values absent. */
export function getConfig(): Promise<ConfigResponse> {
  return request('GET', '/api/config') as Promise<ConfigResponse>;
}

/**
 * PUT /api/providers/:id body (design §API-Surface). Absent fields produce
 * no server-side op, so their bytes round-trip untouched (PC-3). `apiKey`
 * is replace-only: include it only when the user typed a new key — never a
 * masked {configured} shape and never the loaded value.
 */
export interface ProviderWrite {
  hash: string;
  name?: string;
  npm?: string;
  baseURL?: string;
  apiKey?: string;
}

export function putProvider(
  id: string,
  write: ProviderWrite,
): Promise<WriteResponse> {
  return request(
    'PUT',
    `/api/providers/${encodeURIComponent(id)}`,
    write,
  ) as Promise<WriteResponse>;
}

/**
 * WU7 — model-entry CRUD (design §API-Surface). Model writes are WHOLE-entry
 * (the allowlist stops at provider.<id>.models.<mid>, patch.ts), so a PUT
 * carries the merged ModelConfig and an absent field is never invented (MC-1).
 * `hash` is the current base on every call; a 409/`stale` ApiError carries
 * {expected, actual} exactly like the provider writes (SCW-2).
 */
export function postModel(
  providerId: string,
  modelId: string,
  model: ModelConfig,
  hash: string,
): Promise<WriteResponse> {
  return request(
    'POST',
    `/api/providers/${encodeURIComponent(providerId)}/models`,
    { hash, modelId, model },
  ) as Promise<WriteResponse>;
}

export function putModel(
  providerId: string,
  modelId: string,
  model: ModelConfig,
  hash: string,
): Promise<WriteResponse> {
  return request(
    'PUT',
    `/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`,
    { hash, model },
  ) as Promise<WriteResponse>;
}

export function deleteModel(
  providerId: string,
  modelId: string,
  hash: string,
): Promise<WriteResponse> {
  return request(
    'DELETE',
    `/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`,
    { hash },
  ) as Promise<WriteResponse>;
}

/**
 * WU8 — PUT /api/agents/:name/model (design §API-Surface, OA-2). `model` is
 * a "provider/model" string to set, or null to clear the key (runtime
 * default). This is the ONLY orchestration mutation the dashboard ships:
 * prompt bodies and gentle-ai:* markers never enter the body — the server
 * composes a single value/remove op on `agent.<name>.model` (OA-4).
 */
export function putAgentModel(
  name: string,
  hash: string,
  model: string | null,
): Promise<WriteResponse> {
  return request('PUT', `/api/agents/${encodeURIComponent(name)}/model`, {
    hash,
    model,
  }) as Promise<WriteResponse>;
}

/** Identity + advisory drift for the Status view and Models chip source (WU7). */
export function getStatus(): Promise<StatusResponse> {
  return request('GET', '/api/status') as Promise<StatusResponse>;
}

/**
 * The bundled offline NaN catalog (MC-3 pre-fill source). Served via /api so
 * the browser never touches the filesystem; shipped with the app (CX-4).
 */
export function getCatalog(): Promise<CatalogResponse> {
  return request('GET', '/api/catalog') as Promise<CatalogResponse>;
}

/**
 * WU9 — POST /api/sync (OA-3): ask the server to run the gentle-ai sync CLI
 * and report {exitCode, stdout, stderr}. `args` is optional and stays
 * server-allowlisted (the panel runs the bare, unchanged sync — flags exist
 * for callers that legitimately need them; injection attempts 400 upstream).
 * A non-zero exit RESOLVES with the outcome; only a failed REQUEST throws.
 * On exit 0 the response carries the reloaded CONFIG hash (the caller then
 * re-GETs /api/config so the matrix/list reflect sync's writes).
 */
export function runSync(args?: string[]): Promise<SyncResponse> {
  return request(
    'POST',
    '/api/sync',
    args === undefined ? {} : { args },
  ) as Promise<SyncResponse>;
}

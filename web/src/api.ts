// WU6 — the web client for the WU5 REST API. All mutations flow through
// these fetch calls: the browser never touches the filesystem, and apiKey
// values never exist in this layer (CX-2 — the server ships masked
// {configured} presences only; writes carry user-typed strings or nothing).
// DTOs are the shared contracts from shared/types.ts, never redeclared here.
import type { ConfigResponse, WriteResponse } from '../../shared/types';

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

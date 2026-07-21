/**
 * Runtime `/models` read (ADR 0001, Phase 1).
 *
 * The ADR is explicit: provider model ids move weekly, so DON'T trust the
 * literals in descriptors — read `/models` at runtime. This module fetches the
 * provider's Anthropic/OpenAI-compatible model list and (optionally) refreshes
 * the runtime model registry that `resolveProvider` validates against.
 *
 * The HTTP transport is INJECTED so this is fully unit-testable with no network
 * (a mock transport in tests; the real live call is deferred to the keyed
 * checklist). The default transport is a thin wrapper over the platform `fetch`.
 */

import { getDescriptor, setKnownModels } from './resolveProvider.js';
import type { ProviderName } from './types.js';

/** Minimal response contract a transport must satisfy (decoupled from DOM/undici types). */
export type TransportResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

/** A pluggable HTTP GET. Default wraps `globalThis.fetch`; tests inject a mock. */
export type FetchTransport = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<TransportResponse>;

/** Default transport over the platform `fetch` (Node >=18 global). */
export const defaultTransport: FetchTransport = async (url, init) => {
  const f = (globalThis as { fetch?: unknown }).fetch as
    | ((u: string, i?: unknown) => Promise<TransportResponse>)
    | undefined;
  if (typeof f !== 'function') {
    throw new Error('no global fetch available; inject a transport into fetchModels()');
  }
  return f(url, init);
};

export type FetchModelsOptions = {
  /** Injected transport (default {@link defaultTransport}). */
  transport?: FetchTransport;
  /** Env to read the auth secret from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Override base URL (e.g. the local sidecar for OpenAI). Defaults to descriptor base. */
  baseUrl?: string;
  /** When true (default), refresh the runtime model registry with the result. */
  updateRegistry?: boolean;
};

export type FetchModelsResult = {
  provider: ProviderName;
  /** The model ids parsed from the endpoint (`data[].id`, newest-first as returned). */
  models: string[];
  /** URL that was queried. */
  url: string;
  /** Whether the runtime registry was refreshed with these ids. */
  updatedRegistry: boolean;
  /** The raw decoded JSON body, for callers that need more than ids. */
  raw: unknown;
};

/** Parse `{ data: [{ id }] }` (Anthropic + OpenAI both use this shape). */
function parseModelIds(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (entry && typeof entry === 'object') {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    }
  }
  return ids;
}

/**
 * Fetch the provider's model list from its `/models` endpoint.
 *
 * Reads the auth secret from `process.env[descriptor.authEnvVar]` at call time
 * (never hardcoded). Sends `x-api-key` or `Authorization: Bearer` per the
 * descriptor's `authHeader`. On success, refreshes the runtime registry (unless
 * `updateRegistry:false`) so `resolveProvider` validates against fresh ids.
 */
export async function fetchModels(
  name: ProviderName,
  opts: FetchModelsOptions = {},
): Promise<FetchModelsResult> {
  const descriptor = getDescriptor(name);
  const env = opts.env ?? process.env;
  const transport = opts.transport ?? defaultTransport;
  const updateRegistry = opts.updateRegistry ?? true;

  const base = (opts.baseUrl ?? descriptor.baseUrl).replace(/\/+$/, '');
  const path = descriptor.modelsPath ?? '/v1/models';
  const url = `${base}${path}`;

  const headers: Record<string, string> = { accept: 'application/json' };
  const secret = descriptor.authEnvVar ? env[descriptor.authEnvVar] : undefined;
  if (secret) {
    if (descriptor.authHeader === 'x-api-key') {
      headers['x-api-key'] = secret;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.authorization = `Bearer ${secret}`;
    }
  }

  const res = await transport(url, { headers });
  if (!res.ok) {
    throw new Error(`fetchModels('${name}') GET ${url} failed: HTTP ${res.status}`);
  }
  const raw = await res.json();
  const models = parseModelIds(raw);

  let updatedRegistry = false;
  if (updateRegistry && models.length > 0) {
    setKnownModels(name, models);
    updatedRegistry = true;
  }

  return { provider: name, models, url, updatedRegistry, raw };
}

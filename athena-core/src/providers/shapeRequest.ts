/**
 * shapeRequest — the pure dialect corrector.
 *
 * Given a provider capability descriptor and an Anthropic-shaped base request,
 * apply the descriptor and return a transport-ready {@link ShapedRequest}.
 * Deterministic, side-effect free, never mutates the input, never networks.
 */

import type {
  Dispatch,
  MessagesRequest,
  ProviderCapabilities,
  ShapedRequest,
  ToolDeclaration,
} from './types.js';

/** JSON-clone. Requests are pure JSON, so this is both safe and total. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A server web tool (Anthropic `web_search_*` / `web_fetch_*`, or a bare name). */
function isWebTool(tool: ToolDeclaration): boolean {
  const type = typeof tool.type === 'string' ? tool.type : '';
  const name = typeof tool.name === 'string' ? tool.name : '';
  return /^web_search/.test(type) || /^web_fetch/.test(type) || name === 'web_search' || name === 'web_fetch';
}

/** Remove `cache_control` from system blocks, message content blocks, and tools. Returns the count removed. */
function stripCacheControl(body: MessagesRequest): number {
  let removed = 0;
  const scrub = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (b && typeof b === 'object' && 'cache_control' in (b as object)) {
        delete (b as Record<string, unknown>).cache_control;
        removed++;
      }
    }
  };
  if (Array.isArray(body.system)) scrub(body.system);
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) if (Array.isArray(m.content)) scrub(m.content);
  }
  if (Array.isArray(body.tools)) scrub(body.tools);
  return removed;
}

export function shapeRequest(provider: ProviderCapabilities, baseRequest: MessagesRequest): ShapedRequest {
  const dropped: string[] = [];
  const notes: string[] = [];
  const body = clone(baseRequest);

  // 1. Force thinking when the provider requires it (Kimi k2.7-code 400s without it).
  if (provider.requiresThinking && (!body.thinking || body.thinking.type !== 'enabled')) {
    const budget = body.thinking?.budget_tokens;
    body.thinking = { type: 'enabled', ...(typeof budget === 'number' ? { budget_tokens: budget } : {}) };
    notes.push('forced thinking.type=enabled (provider.requiresThinking)');
  }

  // 2. Strip thinking entirely when the provider cannot emit thinking blocks
  //    (never strips what step 1 required — descriptors keep those two consistent).
  if (!provider.supportsThinkingBlocks && body.thinking) {
    delete body.thinking;
    dropped.push('thinking');
    notes.push('stripped thinking (!supportsThinkingBlocks)');
  }

  // 3. Strip cache_control breakpoints when unsupported.
  if (!provider.supportsCacheControl) {
    const n = stripCacheControl(body);
    if (n > 0) {
      dropped.push('cache_control');
      notes.push(`stripped ${n} cache_control block(s) (!supportsCacheControl)`);
    }
  }

  // 4. Strip web-tool declarations when unsupported.
  if (!provider.supportsWebTools && Array.isArray(body.tools)) {
    const before = body.tools.length;
    body.tools = body.tools.filter((t) => !isWebTool(t));
    const n = before - body.tools.length;
    if (n > 0) {
      dropped.push('web_tools');
      notes.push(`stripped ${n} web-tool declaration(s) (!supportsWebTools)`);
    }
    if (body.tools.length === 0) delete body.tools;
  }

  // 5. Clamp temperature into range.
  if (typeof body.temperature === 'number') {
    const [min, max] = provider.temperatureRange;
    const clamped = Math.min(max, Math.max(min, body.temperature));
    if (clamped !== body.temperature) {
      notes.push(`clamped temperature ${body.temperature} -> ${clamped} (range [${min}, ${max}])`);
      body.temperature = clamped;
    }
  }

  // 6. Drop params the provider silently ignores.
  for (const p of provider.ignoredParams ?? []) {
    if (p in body) {
      delete (body as Record<string, unknown>)[p];
      dropped.push(p);
      notes.push(`dropped ignored param '${p}'`);
    }
  }

  const dispatch: Dispatch = provider.dispatch ?? 'direct';

  return {
    provider: provider.name,
    baseUrl: provider.baseUrl,
    authHeaderName: provider.authHeader === 'x-api-key' ? 'x-api-key' : 'authorization',
    authScheme: provider.authHeader,
    dispatch,
    body,
    dropped,
    notes,
  };
}

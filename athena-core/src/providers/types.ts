/**
 * Provider dialect layer — types.
 *
 * The internal contract is the Anthropic Messages request shape (per ADR 0001).
 * Every provider is described by a capability *descriptor*; a pure
 * {@link shapeRequest} function reads the descriptor and produces a
 * transport-ready, dialect-corrected request. No network, no SDK coupling.
 */

export type ProviderName = 'anthropic' | 'kimi' | 'minimax' | 'openai';

/**
 * Credential header style.
 * - `'x-api-key'` → header `x-api-key: <key>` (Anthropic-native, `ANTHROPIC_API_KEY`).
 * - `'bearer'`    → header `Authorization: Bearer <token>` (`ANTHROPIC_AUTH_TOKEN`, OpenAI).
 */
export type AuthHeaderStyle = 'x-api-key' | 'bearer';

/**
 * The env var the Agent SDK / Claude Code CLI itself reads to authenticate its
 * outbound HTTP request. Verified present in the SDK bundle (Phase 1, step 0).
 * - `'ANTHROPIC_API_KEY'`   → `x-api-key` auth (Anthropic, MiniMax; also the
 *   placeholder the SDK sends to the local OpenAI sidecar).
 * - `'ANTHROPIC_AUTH_TOKEN'`→ `Authorization: Bearer` auth (Kimi).
 */
export type SdkAuthEnvVar = 'ANTHROPIC_API_KEY' | 'ANTHROPIC_AUTH_TOKEN';

/** How a shaped request leaves the process. */
export type Dispatch = 'direct' | 'sidecar';

/**
 * The capability descriptor. The eight required fields are exactly the record
 * defined in ADR 0001; the trailing optional fields are forward-looking seams
 * (they never change the meaning of the required eight).
 */
export type ProviderCapabilities = {
  name: ProviderName;
  baseUrl: string;
  authHeader: AuthHeaderStyle;
  contextWindow: number;
  /** Inclusive [min, max]; `shapeRequest` clamps `temperature` into this. */
  temperatureRange: [number, number];
  /** When true, `shapeRequest` forces `thinking:{type:'enabled'}` (e.g. Kimi k2.7-code 400s without it). */
  requiresThinking: boolean;
  supportsThinkingBlocks: boolean;
  supportsCacheControl: boolean;
  supportsWebTools: boolean;

  // ---- optional forward-looking refinements (not part of the ADR's core 8) ----
  /** Params this provider silently ignores; `shapeRequest` drops them (MiniMax: top_k, stop_sequences, mcp_servers). */
  ignoredParams?: string[];
  /** Transport routing. Defaults to `'direct'`; OpenAI is `'sidecar'`. */
  dispatch?: Dispatch;
  /**
   * Env var in `process.env` that holds the REAL provider secret VALUE.
   * `resolveProvider` reads the value from here at call time (never hardcodes).
   * Usually equals {@link sdkAuthEnvVar}; for OpenAI it is `OPENAI_API_KEY`,
   * which the sidecar (not the SDK) consumes.
   */
  authEnvVar?: string;

  // ---- Phase 1 additions (env/session selection + runtime model refresh) ----
  /**
   * Env var the SDK/CLI reads to authenticate its own outbound HTTP call. For
   * direct providers this is where {@link authEnvVar}'s value is injected; for a
   * sidecar provider it carries the local sidecar's (non-secret) master key.
   */
  sdkAuthEnvVar?: SdkAuthEnvVar;
  /** Default model id used when the caller names none. VOLATILE — refresh via `/models`. */
  defaultModel?: string;
  /**
   * Known model ids (VOLATILE snapshot). `resolveProvider` validates a requested
   * model against this ∪ any runtime refresh; `fetchModels` refreshes it. When
   * empty, model validation is skipped (unknown-but-new models pass through).
   */
  models?: string[];
  /**
   * When true, `resolveProvider` also pins `ANTHROPIC_SMALL_FAST_MODEL` to the
   * resolved main model. Needed for non-Anthropic endpoints: Claude Code's
   * background/small-model calls would otherwise send a `claude-*-haiku` id the
   * provider's endpoint does not host (404). Anthropic leaves it unset.
   */
  aliasSmallFastModel?: boolean;
  /** Path (appended to `baseUrl`) of the Anthropic/OpenAI-compatible model list. Default `/v1/models`. */
  modelsPath?: string;
  /** Free-form note (e.g. why a value is set), surfaced in findings. */
  note?: string;
};

/** Anthropic Messages content block. Kept open (index signature) — providers add their own. */
export type ContentBlock = {
  type: string;
  cache_control?: { type: 'ephemeral' } & Record<string, unknown>;
  [k: string]: unknown;
};

export type Message = {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
};

/**
 * A tool declaration in an Anthropic Messages request. Custom tools carry
 * `name`/`input_schema`; server tools (web search/fetch) carry a versioned
 * `type` such as `web_search_20250305`.
 */
export type ToolDeclaration = {
  type?: string;
  name?: string;
  cache_control?: { type: 'ephemeral' } & Record<string, unknown>;
  [k: string]: unknown;
};

export type ThinkingConfig = {
  type: 'enabled' | 'disabled';
  budget_tokens?: number;
};

/** The internal request contract = Anthropic Messages request. */
export type MessagesRequest = {
  model: string;
  messages: Message[];
  system?: string | ContentBlock[];
  max_tokens?: number;
  temperature?: number;
  top_k?: number;
  top_p?: number;
  stop_sequences?: string[];
  thinking?: ThinkingConfig;
  tools?: ToolDeclaration[];
  mcp_servers?: unknown[];
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
};

/** Output of {@link shapeRequest}: a transport-ready, dialect-corrected request. */
export type ShapedRequest = {
  provider: ProviderName;
  baseUrl: string;
  /** Concrete HTTP header name to carry the credential. */
  authHeaderName: 'x-api-key' | 'authorization';
  authScheme: AuthHeaderStyle;
  dispatch: Dispatch;
  /** The cleaned request body. */
  body: MessagesRequest;
  /** Names of params/blocks removed during shaping (for tests & observability). */
  dropped: string[];
  /** Human-readable trace of every transformation applied. */
  notes: string[];
};

/** A provider = a descriptor + the pure shaping behavior it drives. */
export interface Provider {
  readonly capabilities: ProviderCapabilities;
  /** Pure. Produces a transport-ready request. Never mutates the input, never touches the network. */
  shape(baseRequest: MessagesRequest): ShapedRequest;
}

/**
 * A flat map of environment variables to inject into an SDK session (via
 * `Options.env`) so the spawned Claude Code CLI talks to the chosen provider.
 * Contains only concrete string values; secret VALUES present here were read
 * from `process.env` at call time (never hardcoded).
 */
export type SessionEnv = Record<string, string>;

/**
 * Result of {@link resolveProvider}: the descriptor, the per-session env that
 * selects the provider, the resolved model id, and — when the required secret
 * env var is absent from `process.env` — its name (config is still fully
 * returned so it is testable keyless).
 */
export type ResolvedProvider = {
  descriptor: ProviderCapabilities;
  /** Env to inject via `Options.env` (base_url + auth + flags + model). */
  sessionEnv: SessionEnv;
  /** The resolved model id (requested, else the descriptor default). */
  model: string;
  /**
   * Name of the required secret env var when it is ABSENT from `process.env`.
   * Undefined when the secret is present. The non-secret config is returned
   * regardless, so resolution is fully unit-testable without any key.
   */
  missingKeyEnvVar?: string;
};

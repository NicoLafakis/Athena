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
  /** Env var carrying the credential (documentation aid; volatile per /models). */
  authEnvVar?: string;
  /** Free-form note (e.g. why a value is set), surfaced in PHASE0 findings. */
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

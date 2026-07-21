/**
 * OpenAI sidecar adapter SEAM (ADR 0001, seam-adjacent to the provider layer).
 *
 * OpenAI is the only shape mismatch. Per the ADR it is bridged by a LiteLLM
 * sidecar: local, pinned to a known-clean version, OpenAI-scoped, never a
 * network dependency. Phase 0 ships ONLY the seam — an interface + a stub. No
 * LiteLLM is installed or bundled. A hand-rolled translator can later replace
 * the stub behind this same interface with zero churn upstream.
 *
 * SECURITY (ADR): LiteLLM shipped credential-stealing malware in 1.82.7 /
 * 1.82.8. Whatever fills this seam MUST pin & vendor a known-clean version and
 * never auto-update.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { defaultTransport, type FetchTransport } from './fetchModels.js';
import type { ShapedRequest } from './types.js';

export type SidecarDispatchResult = {
  /** Identifier of the adapter that handled (or would handle) the request. */
  handledBy: string;
  /** Whether the local sidecar is actually reachable. Phase 0 stub: always false. */
  reachable: boolean;
  /** Standing reminder that the real sidecar must pin a known-clean LiteLLM. */
  pinnedVersionRequired: true;
  /** Downstream call the sidecar would make. */
  target: string;
  note: string;
};

/** The seam. A future local translator/LiteLLM sidecar implements this. */
export interface OpenAISidecarAdapter {
  readonly kind: string;
  /** Is the local sidecar bundled & reachable? Phase 0: false. */
  available(): boolean;
  /**
   * Translate an already-dialect-corrected, Anthropic-shaped request into the
   * OpenAI call the sidecar will make, returning a dispatch descriptor. The
   * Phase 0 stub performs NO network I/O.
   */
  handle(req: ShapedRequest): SidecarDispatchResult;
}

/** Phase 0 stub. Represents the future local LiteLLM sidecar; does nothing over the wire. */
export class LiteLLMSidecarStub implements OpenAISidecarAdapter {
  readonly kind = 'litellm-sidecar-stub';

  available(): boolean {
    // Not bundled in Phase 0. The real adapter flips this once a pinned,
    // known-clean LiteLLM (or hand-rolled translator) is vendored locally.
    return false;
  }

  handle(req: ShapedRequest): SidecarDispatchResult {
    return {
      handledBy: this.kind,
      reachable: this.available(),
      pinnedVersionRequired: true,
      target: 'openai:chat.completions',
      note:
        `Phase 0 seam only — LiteLLM not installed/bundled. Would proxy model '${req.body.model}' ` +
        `via a local sidecar at ${req.baseUrl}. Pin a known-clean LiteLLM (never 1.82.7 / 1.82.8).`,
    };
  }
}

/** Default adapter instance for the seam. */
export const defaultSidecar: OpenAISidecarAdapter = new LiteLLMSidecarStub();

/**
 * Route a shaped request through the sidecar seam. Throws if the request was
 * not marked for sidecar dispatch — a direct-dispatch provider must never
 * silently fall through to OpenAI translation.
 */
export function routeToSidecar(
  req: ShapedRequest,
  sidecar: OpenAISidecarAdapter = defaultSidecar,
): SidecarDispatchResult {
  if (req.dispatch !== 'sidecar') {
    throw new Error(`routeToSidecar called on a '${req.dispatch}' request for provider '${req.provider}'`);
  }
  return sidecar.handle(req);
}

// ===========================================================================
// SidecarManager — the real local LiteLLM process lifecycle (Phase 1).
//
// The stub above is the in-SDK ROUTING seam (proves openai selection never
// makes a direct call). This is the process LIFECYCLE: start/stop a local
// LiteLLM proxy, health-check it, and expose the Anthropic-compatible base_url
// that `resolveProvider('openai', ...)` points ANTHROPIC_BASE_URL at.
//
// The real spawn is GUARDED (see canSpawnSidecar) so it never runs in this
// Linux authoring container. Tests exercise routing against MockSidecar (a real
// local http server returning a canned Anthropic-shaped /v1/messages response).
// ===========================================================================

/**
 * The pinned, known-CLEAN LiteLLM version (see PHASE1.md for rationale).
 * NEVER auto-update; vendor + hash-pin this exact version.
 */
export const LITELLM_PINNED_VERSION = '1.93.0';

/**
 * Versions that shipped the credential-stealing payload (ADR 0001). The manager
 * refuses to construct a spawn command for any of these.
 */
export const LITELLM_KNOWN_BAD_VERSIONS = ['1.82.7', '1.82.8'] as const;

/** Default LiteLLM proxy liveliness probe (returns "I'm alive!" / 200). */
export const LITELLM_HEALTH_PATH = '/health/liveliness';

/**
 * Environment variables the LiteLLM child is ALLOWED to inherit. The parent env
 * is NOT spread wholesale — a third-party proxy (whose own supply chain was
 * compromised once) must never receive our ANTHROPIC_* keys, cloud tokens, or
 * any other ambient secret. Only process basics + locale/encoding pass; the
 * proxy's own secret (OPENAI_API_KEY) and the local hop key are added
 * explicitly in buildSpawnCommand. Hosts needing more use `extraEnvAllowlist`.
 */
export const SIDECAR_ENV_ALLOWLIST = [
  'PATH',
  // POSIX / Windows process basics needed to launch python/litellm:
  'HOME', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE',
  // locale / encoding:
  'LANG', 'LC_ALL', 'TZ', 'PYTHONUTF8', 'PYTHONIOENCODING',
] as const;

/** Reads the version of the ACTUALLY-INSTALLED litellm (injectable for tests). */
export type VersionProbe = (env: Record<string, string | undefined>) => Promise<string>;

/**
 * Default probe: runs `litellm --version` and extracts a semver token. This is
 * what verifies the binary that will actually be spawned — a `PATH`-resolved or
 * hijacked `litellm` cannot be trusted from its configured version string alone.
 */
export const defaultVersionProbe: VersionProbe = async (env) =>
  new Promise<string>((resolve, reject) => {
    execFile('litellm', ['--version'], { env }, (err, stdout, stderr) => {
      if (err) return reject(err);
      const match = `${stdout} ${stderr}`.match(/\d+\.\d+\.\d+/);
      if (!match) {
        return reject(new Error(`could not parse LiteLLM version from: ${(stdout || stderr).trim()}`));
      }
      resolve(match[0]);
    });
  });

/**
 * Capability guard for the REAL spawn. Returns false in this Linux authoring
 * container (product is Windows-only, and LiteLLM is not installed here). Opt in
 * with `ATHENA_ENABLE_SIDECAR_SPAWN=1` on a host that has a pinned LiteLLM.
 */
export function canSpawnSidecar(env: Record<string, string | undefined> = process.env): boolean {
  if (env.ATHENA_ENABLE_SIDECAR_SPAWN === '1') return true;
  return process.platform === 'win32';
}

export type SidecarManagerOptions = {
  /** Port the proxy binds. Default 4000 (LiteLLM default). */
  port?: number;
  /** Interface to bind. Default `127.0.0.1` (localhost only). */
  host?: string;
  /** OpenAI model the proxy fronts (e.g. `gpt-4o`). Default `gpt-4o`. */
  model?: string;
  /** Pinned LiteLLM version. Default {@link LITELLM_PINNED_VERSION}. */
  version?: string;
  /** Optional path to a `config.yaml`; when set, `--config` is used instead of `--model`. */
  configPath?: string;
  /** Env for the spawned process + secret reads. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Liveliness path. Default {@link LITELLM_HEALTH_PATH}. */
  healthPath?: string;
  /** Max time to wait for health during start(). Default 30_000ms. */
  startTimeoutMs?: number;
  /** Injected transport for health checks (default platform fetch). */
  transport?: FetchTransport;
  /** Extra env-var names the sidecar child may inherit beyond the allowlist. */
  extraEnvAllowlist?: string[];
  /** Injected installed-version probe (default runs `litellm --version`). */
  versionProbe?: VersionProbe;
};

/** The concrete `litellm` invocation the manager would spawn. */
export type SidecarSpawnCommand = {
  command: string;
  args: string[];
  /** Env the child receives (carries OPENAI_API_KEY + optional LITELLM_MASTER_KEY). */
  env: Record<string, string | undefined>;
};

/**
 * Manages a local LiteLLM proxy that bridges OpenAI to the Anthropic Messages
 * shape. Reads `OPENAI_API_KEY` from env (consumed by the proxy, never by the
 * SDK). The real spawn is guarded; without the guard, `start()` throws a clear,
 * actionable error and never touches the system.
 */
export class SidecarManager {
  readonly port: number;
  readonly host: string;
  readonly model: string;
  readonly version: string;
  readonly healthPath: string;
  private readonly configPath?: string;
  private readonly env: Record<string, string | undefined>;
  private readonly startTimeoutMs: number;
  private readonly transport: FetchTransport;
  private readonly extraEnvAllowlist: string[];
  private readonly versionProbe: VersionProbe;
  private child?: ChildProcess;

  constructor(opts: SidecarManagerOptions = {}) {
    this.port = opts.port ?? 4000;
    this.host = opts.host ?? '127.0.0.1';
    this.model = opts.model ?? 'gpt-4o';
    this.version = opts.version ?? LITELLM_PINNED_VERSION;
    this.configPath = opts.configPath;
    this.env = opts.env ?? process.env;
    this.healthPath = opts.healthPath ?? LITELLM_HEALTH_PATH;
    this.startTimeoutMs = opts.startTimeoutMs ?? 30_000;
    this.transport = opts.transport ?? defaultTransport;
    this.extraEnvAllowlist = opts.extraEnvAllowlist ?? [];
    this.versionProbe = opts.versionProbe ?? defaultVersionProbe;
  }

  /** Unified base_url (`ANTHROPIC_BASE_URL` points here; SDK appends `/v1/messages`). */
  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  /** The Anthropic-compatible messages endpoint the SDK would call. */
  get anthropicMessagesUrl(): string {
    return `${this.baseUrl}/v1/messages`;
  }

  /** Liveliness URL. */
  get healthUrl(): string {
    return `${this.baseUrl}${this.healthPath}`;
  }

  /** Whether a child proxy process is currently tracked. */
  get running(): boolean {
    return Boolean(this.child && this.child.exitCode === null);
  }

  /** Throw unless the configured version is the single vetted, clean pin. */
  assertCleanVersion(): void {
    if ((LITELLM_KNOWN_BAD_VERSIONS as readonly string[]).includes(this.version)) {
      throw new Error(
        `refusing to run LiteLLM ${this.version}: known credential-stealing release. ` +
          `Pin ${LITELLM_PINNED_VERSION} (see PHASE1.md).`,
      );
    }
    // Allowlist-of-one: a denylist alone is fail-open (any non-listed, unvetted
    // build would pass). The configured version must be the vetted pin; changing
    // it is a deliberate code change, not a silent runtime option.
    if (this.version !== LITELLM_PINNED_VERSION) {
      throw new Error(
        `refusing to run LiteLLM ${this.version}: only the vetted pin ` +
          `${LITELLM_PINNED_VERSION} is allowed. Update LITELLM_PINNED_VERSION ` +
          `(and re-verify the artifact hash) to change it.`,
      );
    }
  }

  /**
   * Verify the version of the litellm that will ACTUALLY be spawned, not just the
   * configured string. Guards against a PATH-resolved / hijacked / downgraded
   * binary. Throws if the installed version is compromised or != the pin.
   */
  async assertInstalledVersionMatches(): Promise<void> {
    const installed = await this.versionProbe(this.env);
    if ((LITELLM_KNOWN_BAD_VERSIONS as readonly string[]).includes(installed)) {
      throw new Error(
        `installed LiteLLM ${installed} is a known credential-stealing release; refusing to spawn.`,
      );
    }
    if (installed !== this.version) {
      throw new Error(
        `installed LiteLLM ${installed} does not match pinned ${this.version}; ` +
          `refusing to spawn (possible PATH hijack or silent downgrade).`,
      );
    }
  }

  /**
   * The exact command the manager would spawn (documented + testable WITHOUT
   * spawning). Uses `--config` when a config.yaml is supplied, else `--model`.
   */
  buildSpawnCommand(): SidecarSpawnCommand {
    this.assertCleanVersion();
    const args = this.configPath
      ? ['--config', this.configPath, '--port', String(this.port), '--host', this.host]
      : ['--model', `openai/${this.model}`, '--port', String(this.port), '--host', this.host];
    // Allowlist, NOT a wholesale spread of the parent env — LiteLLM must never
    // see our ANTHROPIC_* keys, cloud tokens, or other ambient secrets.
    const childEnv: Record<string, string | undefined> = {};
    for (const key of [...SIDECAR_ENV_ALLOWLIST, ...this.extraEnvAllowlist]) {
      if (this.env[key] !== undefined) childEnv[key] = this.env[key];
    }
    // The proxy's own upstream secret + the local SDK->sidecar hop key, explicit.
    if (this.env.OPENAI_API_KEY !== undefined) childEnv.OPENAI_API_KEY = this.env.OPENAI_API_KEY;
    if (this.env.LITELLM_MASTER_KEY !== undefined) childEnv.LITELLM_MASTER_KEY = this.env.LITELLM_MASTER_KEY;

    return { command: 'litellm', args, env: childEnv };
  }

  /** GET the liveliness probe; true iff HTTP 2xx. Never throws on network error. */
  async health(): Promise<boolean> {
    try {
      const res = await this.transport(this.healthUrl, { headers: { accept: 'application/json' } });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Start the real proxy. GUARDED: throws (without spawning) when
   * {@link canSpawnSidecar} is false, so it is inert in this container. On an
   * enabled host it spawns the pinned LiteLLM and polls health until ready.
   */
  async start(): Promise<void> {
    if (!canSpawnSidecar(this.env)) {
      throw new Error(
        'SidecarManager.start() is disabled here: no local LiteLLM in this environment. ' +
          'This is Windows-only + deferred to the keyed checklist (PHASE1.md). ' +
          'Set ATHENA_ENABLE_SIDECAR_SPAWN=1 on a host with a pinned LiteLLM to enable.',
      );
    }
    this.assertCleanVersion();
    await this.assertInstalledVersionMatches();
    if (this.running) return;

    const { command, args, env } = this.buildSpawnCommand();
    this.child = spawn(command, args, { env, stdio: 'ignore' });
    this.child.on('error', () => {
      /* surfaced via health() timeout below */
    });

    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.health()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    await this.stop();
    throw new Error(`LiteLLM sidecar did not become healthy within ${this.startTimeoutMs}ms`);
  }

  /** Stop the proxy if running. Idempotent. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      // Hard stop if it ignores SIGTERM.
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 2_000);
    });
  }
}

// ---------------------------------------------------------------------------
// MockSidecar — a tiny REAL local http server that answers the Anthropic-shaped
// endpoints. Used by tests to prove OpenAI selection routes end-to-end through
// the sidecar base_url, with zero LiteLLM and zero external network.
// ---------------------------------------------------------------------------

export type MockSidecarOptions = {
  /** Model echoed back in the canned response. Default `gpt-4o`. */
  model?: string;
  /** Canned assistant text. Default a fixed marker. */
  text?: string;
  /** Model ids served at `/v1/models`. Default a small OpenAI-ish set. */
  modelsList?: string[];
  /** Host to bind. Default `127.0.0.1`. */
  host?: string;
};

/** A request the mock observed (for assertions). */
export type MockSidecarRequest = {
  method: string;
  url: string;
  body: unknown;
};

export class MockSidecar {
  private server?: Server;
  private assignedPort = 0;
  readonly host: string;
  readonly model: string;
  readonly text: string;
  readonly modelsList: string[];
  /** Every request the mock received, in order. */
  readonly requests: MockSidecarRequest[] = [];

  constructor(opts: MockSidecarOptions = {}) {
    this.host = opts.host ?? '127.0.0.1';
    this.model = opts.model ?? 'gpt-4o';
    this.text = opts.text ?? 'ATHENA_SIDECAR_MOCK_OK';
    this.modelsList = opts.modelsList ?? ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'];
  }

  /** Start listening on an ephemeral port; resolves to the base_url. */
  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this.handle(req, res));
      this.server.on('error', reject);
      this.server.listen(0, this.host, () => {
        const addr = this.server?.address();
        if (addr && typeof addr === 'object') this.assignedPort = addr.port;
        resolve(this.baseUrl);
      });
    });
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.assignedPort}`;
  }

  get anthropicMessagesUrl(): string {
    return `${this.baseUrl}/v1/messages`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const url = req.url ?? '';
      this.requests.push({ method: req.method ?? 'GET', url, body });

      const send = (code: number, payload: unknown, asText = false): void => {
        res.writeHead(code, {
          'content-type': asText ? 'text/plain' : 'application/json',
        });
        res.end(asText ? String(payload) : JSON.stringify(payload));
      };

      if (req.method === 'GET' && url.startsWith('/health/liveliness')) {
        send(200, "I'm alive!", true);
        return;
      }
      if (req.method === 'GET' && url.startsWith('/v1/models')) {
        send(200, { data: this.modelsList.map((id) => ({ id, object: 'model' })) });
        return;
      }
      if (req.method === 'POST' && url.startsWith('/v1/messages')) {
        const model =
          (body && typeof body === 'object' && (body as { model?: string }).model) || this.model;
        send(200, {
          id: 'msg_mock_sidecar',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: this.text }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
        return;
      }
      send(404, { type: 'error', error: { type: 'not_found', message: url } });
    });
  }
}

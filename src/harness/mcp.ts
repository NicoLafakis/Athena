import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ClientCredentialsProvider } from '@modelcontextprotocol/sdk/client/auth-extensions.js'
import type { Transport, FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { ToolDefinition, ToolContext } from '../engine/types.js'
import type { McpHttpConfig, McpServerConfig } from '../brain/settings.js'
import { assertPublicUrl } from '../tools/webfetch.js'

const CONNECT_TIMEOUT_MS = 15_000
const DEFAULT_OUTPUT_CHARS = 100_000
const MAX_REDIRECTS = 5

// The server's JSON Schema is surfaced to the model through inputSchemaJson. This
// permissive local schema preserves unknown keys at the dispatch seam.
const McpArgsSchema = z.object({}).passthrough()
const ResourceInput = z.object({ uri: z.string().min(1) })
const PromptInput = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.string()).optional(),
})

interface ConnectedServer {
  name: string
  client: Client
  transport: Transport
  kind: 'stdio' | 'http'
  endpoint: string
  tools: number
  resources: number
  prompts: number
}

interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
  }
}

interface McpResourceDescriptor {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

interface McpPromptDescriptor {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

export interface McpServerStatus {
  name: string
  transport: 'stdio' | 'http'
  endpoint: string
  tools: number
  resources: number
  prompts: number
}

const BASE_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'TMP',
  'TEMP',
  'LANG',
]

/** MCP subprocesses receive operational variables plus names explicitly
 * allowlisted by the user. Provider keys and unrelated secrets are excluded. */
export function buildMcpEnv(
  extra: Record<string, string>,
  allowlist: readonly string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of new Set([...BASE_ENV_ALLOWLIST, ...allowlist])) {
    const value = process.env[key]
    if (value !== undefined) out[key] = value
  }
  return { ...out, ...extra }
}

function capped(value: string, capChars: number, label = 'MCP output'): string {
  return value.length > capChars
    ? `${value.slice(0, capChars)}\n(truncated: ${label} exceeded ${capChars} chars)`
    : value
}

/** Preserve structured image/audio/resource fields as bounded JSON instead of
 * collapsing them to placeholders. */
function serializeContent(content: unknown, capChars: number): string {
  if (!Array.isArray(content)) {
    return capped(JSON.stringify(content ?? null), capChars)
  }
  const parts: string[] = []
  for (const block of content) {
    const item = block as { type?: string; text?: string }
    if (item.type === 'text') parts.push(item.text ?? '')
    else parts.push(JSON.stringify(block))
    if (parts.reduce((sum, part) => sum + part.length, 0) > capChars) break
  }
  return capped(parts.join('\n'), capChars)
}

function boundedJson(value: unknown, capChars: number, label: string): string {
  return capped(JSON.stringify(value, null, 2), capChars, label)
}

/** Proxy one server tool while respecting MCP read-only annotations. */
export function makeMcpTool(
  serverName: string,
  tool: McpToolDescriptor,
  client: Client,
  maxOutputChars = DEFAULT_OUTPUT_CHARS,
): ToolDefinition<z.infer<typeof McpArgsSchema>> {
  const inputSchemaJson =
    tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} }
  return {
    name: `mcp__${serverName}__${tool.name}`,
    description: tool.description ?? `(MCP tool ${tool.name} from ${serverName})`,
    schema: McpArgsSchema,
    inputSchemaJson,
    readOnly: tool.annotations?.readOnlyHint === true,
    async execute(input, ctx) {
      try {
        const result = await client.callTool(
          { name: tool.name, arguments: input as Record<string, unknown> },
          undefined,
          { signal: ctx.abortSignal },
        )
        const response = result as { content?: unknown; isError?: boolean; structuredContent?: unknown }
        const pieces = [
          serializeContent(response.content, maxOutputChars),
          response.structuredContent === undefined
            ? ''
            : boundedJson(response.structuredContent, maxOutputChars, 'MCP structured output'),
        ].filter(Boolean)
        return { output: capped(pieces.join('\n'), maxOutputChars) || '(no content)', isError: response.isError === true }
      } catch (err) {
        return { output: `MCP call failed: ${(err as Error).message ?? String(err)}`, isError: true }
      }
    },
  }
}

export function makeMcpResourceTools(
  serverName: string,
  resources: McpResourceDescriptor[],
  client: Client,
  maxOutputChars = DEFAULT_OUTPUT_CHARS,
): ToolDefinition<never>[] {
  if (resources.length === 0) return []
  const index = resources.map(({ uri, name, description, mimeType }) => ({
    uri,
    name,
    description,
    mimeType,
  }))
  return [
    {
      name: `mcp__${serverName}__athena_list_resources`,
      description: `List resources advertised by MCP server ${serverName}.`,
      schema: z.object({}),
      readOnly: true,
      async execute() {
        return { output: boundedJson(index, maxOutputChars, 'MCP resource index'), isError: false }
      },
    } as unknown as ToolDefinition<never>,
    {
      name: `mcp__${serverName}__athena_read_resource`,
      description: `Read a resource from MCP server ${serverName} by URI.`,
      schema: ResourceInput,
      readOnly: true,
      async execute(input: z.infer<typeof ResourceInput>, ctx: ToolContext) {
        try {
          const result = await client.readResource(
            { uri: input.uri },
            { signal: ctx.abortSignal },
          )
          return {
            output: boundedJson(result.contents, maxOutputChars, 'MCP resource'),
            isError: false,
          }
        } catch (err) {
          return { output: `MCP resource read failed: ${(err as Error).message}`, isError: true }
        }
      },
    } as unknown as ToolDefinition<never>,
  ]
}

export function makeMcpPromptTools(
  serverName: string,
  prompts: McpPromptDescriptor[],
  client: Client,
  maxOutputChars = DEFAULT_OUTPUT_CHARS,
): ToolDefinition<never>[] {
  if (prompts.length === 0) return []
  return [
    {
      name: `mcp__${serverName}__athena_list_prompts`,
      description: `List prompt templates advertised by MCP server ${serverName}.`,
      schema: z.object({}),
      readOnly: true,
      async execute() {
        return { output: boundedJson(prompts, maxOutputChars, 'MCP prompt index'), isError: false }
      },
    } as unknown as ToolDefinition<never>,
    {
      name: `mcp__${serverName}__athena_get_prompt`,
      description: `Render a prompt template from MCP server ${serverName}.`,
      schema: PromptInput,
      readOnly: true,
      async execute(input: z.infer<typeof PromptInput>, ctx: ToolContext) {
        try {
          const result = await client.getPrompt(
            { name: input.name, arguments: input.arguments },
            { signal: ctx.abortSignal },
          )
          return { output: boundedJson(result, maxOutputChars, 'MCP prompt'), isError: false }
        } catch (err) {
          return { output: `MCP prompt failed: ${(err as Error).message}`, isError: true }
        }
      },
    } as unknown as ToolDefinition<never>,
  ]
}

function capResponseBody(response: Response, maxBytes: number): Response {
  if (!response.body) return response
  const reader = response.body.getReader()
  let received = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read()
      if (next.done) {
        controller.close()
        return
      }
      received += next.value.byteLength
      if (received > maxBytes) {
        await reader.cancel('MCP response limit exceeded')
        controller.error(new Error(`MCP response exceeded ${maxBytes} bytes`))
        return
      }
      controller.enqueue(next.value)
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  })
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/** Fetch wrapper used by HTTP MCP. It validates every redirect hop and caps the
 * response stream before the MCP SDK parses it. */
export function makeGuardedMcpFetch(
  allowPrivateNetwork: boolean,
  maxBytes: number,
): FetchLike {
  return async (input, init) => {
    let request = new Request(input, init)
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (!allowPrivateNetwork) await assertPublicUrl(new URL(request.url))
      const response = await fetch(request, { redirect: 'manual' })
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return capResponseBody(response, maxBytes)
      }
      const location = response.headers.get('location')
      if (!location) return capResponseBody(response, maxBytes)
      if (redirects === MAX_REDIRECTS) throw new Error(`MCP redirect limit exceeded (${MAX_REDIRECTS})`)
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new Error('MCP refused a redirect for a request with a body')
      }
      const next = new URL(location, request.url)
      request = new Request(next, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
      })
    }
    throw new Error('MCP redirect limit exceeded')
  }
}

function httpHeaders(cfg: McpHttpConfig, env: NodeJS.ProcessEnv): Headers {
  const headers = new Headers(cfg.headers ?? {})
  for (const [header, envName] of Object.entries(cfg.headerEnv ?? {})) {
    const value = env[envName]
    if (!value) throw new Error(`MCP header ${header} requires environment variable ${envName}`)
    headers.set(header, value)
  }
  if (cfg.bearerTokenEnv) {
    const token = env[cfg.bearerTokenEnv]
    if (!token) throw new Error(`MCP bearer token requires environment variable ${cfg.bearerTokenEnv}`)
    headers.set('authorization', `Bearer ${token}`)
  }
  return headers
}

function httpTransport(cfg: McpHttpConfig, env: NodeJS.ProcessEnv): StreamableHTTPClientTransport {
  const headers = httpHeaders(cfg, env)
  let authProvider: ClientCredentialsProvider | undefined
  if (cfg.oauth) {
    const clientId = env[cfg.oauth.clientIdEnv]
    const clientSecret = env[cfg.oauth.clientSecretEnv]
    if (!clientId || !clientSecret) {
      throw new Error(
        `MCP OAuth requires ${cfg.oauth.clientIdEnv} and ${cfg.oauth.clientSecretEnv}`,
      )
    }
    authProvider = new ClientCredentialsProvider({
      clientId,
      clientSecret,
      scope: cfg.oauth.scope,
      clientName: 'Athena',
    })
  }
  return new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: { headers },
    authProvider,
    fetch: makeGuardedMcpFetch(
      cfg.allowPrivateNetwork === true,
      Math.max(1_024, (cfg.maxOutputChars ?? DEFAULT_OUTPUT_CHARS) * 4),
    ),
    reconnectionOptions: {
      initialReconnectionDelay: 500,
      maxReconnectionDelay: 5_000,
      reconnectionDelayGrowFactor: 2,
      maxRetries: 2,
    },
  })
}

async function discoverResources(
  client: Client,
  limit: number,
): Promise<McpResourceDescriptor[]> {
  const out: McpResourceDescriptor[] = []
  let cursor: string | undefined
  do {
    const page = await client.listResources(cursor ? { cursor } : undefined)
    out.push(...(page.resources as McpResourceDescriptor[]).slice(0, Math.max(0, limit - out.length)))
    cursor = out.length < limit ? page.nextCursor : undefined
  } while (cursor)
  return out
}

async function discoverPrompts(client: Client, limit: number): Promise<McpPromptDescriptor[]> {
  const out: McpPromptDescriptor[] = []
  let cursor: string | undefined
  do {
    const page = await client.listPrompts(cursor ? { cursor } : undefined)
    out.push(...(page.prompts as McpPromptDescriptor[]).slice(0, Math.max(0, limit - out.length)))
    cursor = out.length < limit ? page.nextCursor : undefined
  } while (cursor)
  return out
}

/** Connects managed stdio and Streamable HTTP servers, discovers tools,
 * resources, and prompts, and mounts their bounded adapters in the base registry. */
export class McpManager {
  private servers: ConnectedServer[] = []

  status(): McpServerStatus[] {
    return this.servers.map(({ name, kind, endpoint, tools, resources, prompts }) => ({
      name,
      transport: kind,
      endpoint,
      tools,
      resources,
      prompts,
    }))
  }

  async connectAll(
    servers: Record<string, McpServerConfig>,
    registry: ToolRegistry,
    log: (msg: string) => void,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<void> {
    for (const [name, cfg] of Object.entries(servers)) {
      let transport: Transport
      let kind: 'stdio' | 'http'
      let endpoint: string
      try {
        if (cfg.transport === 'http') {
          transport = httpTransport(cfg, env)
          kind = 'http'
          endpoint = cfg.url
        } else {
          transport = new StdioClientTransport({
            command: cfg.command,
            args: cfg.args ?? [],
            env: buildMcpEnv(cfg.env ?? {}, cfg.envAllowlist ?? []),
          })
          kind = 'stdio'
          endpoint = [cfg.command, ...(cfg.args ?? [])].join(' ')
        }
      } catch (err) {
        log(`MCP server "${name}" configuration failed: ${(err as Error).message}`)
        continue
      }

      const client = new Client(
        { name: 'athena', version: '0.1.0' },
        { capabilities: {} },
      )
      try {
        if (kind === 'http' && cfg.transport === 'http' && cfg.allowPrivateNetwork !== true) {
          await assertPublicUrl(new URL(cfg.url))
        }
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
      } catch (err) {
        log(`MCP server "${name}" failed: ${(err as Error).message ?? String(err)}`)
        try {
          await transport.close()
        } catch {
          // Failed transports may already be closed.
        }
        continue
      }

      const connected: ConnectedServer = {
        name,
        client,
        transport,
        kind,
        endpoint,
        tools: 0,
        resources: 0,
        prompts: 0,
      }
      this.servers.push(connected)
      const outputCap = cfg.maxOutputChars ?? DEFAULT_OUTPUT_CHARS
      const discoveryLimit = cfg.discoveryLimit ?? 200

      try {
        const { tools } = await client.listTools()
        for (const tool of (tools as McpToolDescriptor[]).slice(0, discoveryLimit)) {
          registry.register(
            makeMcpTool(name, tool, client, outputCap) as ToolDefinition<never>,
          )
          connected.tools++
        }
      } catch (err) {
        log(`MCP server "${name}" tool discovery failed: ${(err as Error).message ?? String(err)}`)
      }

      try {
        const resources = await discoverResources(client, discoveryLimit)
        for (const tool of makeMcpResourceTools(name, resources, client, outputCap)) {
          registry.register(tool)
        }
        connected.resources = resources.length
      } catch {
        // Resources are optional protocol capabilities.
      }

      try {
        const prompts = await discoverPrompts(client, discoveryLimit)
        for (const tool of makeMcpPromptTools(name, prompts, client, outputCap)) {
          registry.register(tool)
        }
        connected.prompts = prompts.length
      } catch {
        // Prompts are optional protocol capabilities.
      }

      log(
        `MCP: mounted ${connected.tools} tool(s), ${connected.resources} resource(s), and ` +
          `${connected.prompts} prompt(s) from "${name}" over ${kind}`,
      )
    }
  }

  async closeAll(): Promise<void> {
    for (const server of this.servers) {
      try {
        await server.client.close()
      } catch {
        // Best-effort shutdown.
      }
      try {
        await server.transport.close()
      } catch {
        // Best-effort shutdown.
      }
    }
    this.servers = []
  }
}

import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolRegistry } from '../tools/registry.js'
import type { ToolDefinition } from '../engine/types.js'
import type { McpServerConfig } from '../brain/settings.js'

const CONNECT_TIMEOUT_MS = 15_000

// Permissive local-validation schema for every MCP tool: the gate/dispatch path in the
// engine runs `schema.safeParse(input)` before executing, and it must never reject valid
// server args. The model is steered by `inputSchemaJson` (the server's real JSON Schema);
// this only guards the dispatch seam. `.passthrough()` keeps unknown keys intact.
const McpArgsSchema = z.object({}).passthrough()

interface ConnectedServer {
  name: string
  client: Client
  transport: StdioClientTransport
}

/** Shape of a single tool as returned by `client.listTools()` — only the fields we consume. */
interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/** Full process env as a string map (StdioClientTransport wants Record<string,string>;
 *  process.env values are string | undefined). Undefined entries are dropped. */
function inheritedEnv(extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v
  }
  return { ...out, ...extra }
}

/** Flatten an MCP tool-result `content` array to a single string. Text parts join verbatim;
 *  non-text parts collapse to a short placeholder so the model still sees they were present. */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const b = block as { type?: string; text?: string }
    if (b.type === 'text') parts.push(b.text ?? '')
    else if (b.type === 'image') parts.push('[image]')
    else if (b.type === 'audio') parts.push('[audio]')
    else if (b.type === 'resource' || b.type === 'resource_link') parts.push('[resource]')
    else parts.push(`[${b.type ?? 'unknown'}]`)
  }
  return parts.join('\n')
}

/** Build a native ToolDefinition that proxies to one MCP server tool. Named
 *  `mcp__<server>__<tool>` so it never collides with a built-in tool. */
export function makeMcpTool(
  serverName: string,
  tool: McpToolDescriptor,
  client: Client,
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
    readOnly: false, // safe default: the normal-mode gate will 'ask' before running it
    async execute(input, ctx) {
      try {
        const result = await client.callTool(
          { name: tool.name, arguments: input as Record<string, unknown> },
          undefined,
          { signal: ctx.abortSignal },
        )
        const r = result as { content?: unknown; isError?: boolean }
        const output = flattenContent(r.content)
        return { output: output || '(no content)', isError: r.isError === true }
      } catch (err) {
        return { output: `MCP call failed: ${(err as Error).message ?? String(err)}`, isError: true }
      }
    },
  }
}

/**
 * Connects to configured MCP servers over stdio, discovers their tools, and mounts each
 * as a native tool in the ToolRegistry. Because it registers into the BASE registry, the
 * mounted tools flow to sub-agents under the usual restriction (Task 12).
 *
 * Dependency-injected and side-effect-light: connectAll takes the registry and a log
 * callback (no direct console), so it is unit-testable against a real stdio server.
 */
export class McpManager {
  private servers: ConnectedServer[] = []

  /** For each configured server: spawn it, connect (15s cap), list its tools, and register
   *  them. A server that fails to connect or list is logged and skipped — connectAll never
   *  throws, so one broken server can't take down session startup or the other servers. */
  async connectAll(
    servers: Record<string, McpServerConfig>,
    registry: ToolRegistry,
    log: (msg: string) => void,
  ): Promise<void> {
    for (const [name, cfg] of Object.entries(servers)) {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: inheritedEnv(cfg.env),
      })
      const client = new Client({ name: 'athena', version: '0.1.0' }, { capabilities: {} })
      try {
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
      } catch (err) {
        log(`MCP server "${name}" failed: ${(err as Error).message ?? String(err)}`)
        try {
          await transport.close()
        } catch {
          /* best-effort: the failed transport may already be dead */
        }
        continue
      }
      this.servers.push({ name, client, transport })
      try {
        const { tools } = await client.listTools()
        let count = 0
        for (const tool of tools as McpToolDescriptor[]) {
          registry.register(makeMcpTool(name, tool, client) as ToolDefinition<never>)
          count++
        }
        log(`MCP: mounted ${count} tool(s) from "${name}"`)
      } catch (err) {
        log(`MCP server "${name}" tool discovery failed: ${(err as Error).message ?? String(err)}`)
      }
    }
  }

  /** Close every connected client and transport, swallowing errors. Idempotent. */
  async closeAll(): Promise<void> {
    for (const s of this.servers) {
      try {
        await s.client.close()
      } catch {
        /* swallow: shutting down anyway */
      }
      try {
        await s.transport.close()
      } catch {
        /* swallow: shutting down anyway */
      }
    }
    this.servers = []
  }
}

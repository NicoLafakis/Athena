import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { McpManager } from '../../src/harness/mcp.js'
import { ToolRegistry } from '../../src/tools/registry.js'
import { toolInputSchema } from '../../src/engine/loop.js'
import type { McpServerConfig } from '../../src/brain/settings.js'
import { makeCtx } from '../helpers/tool-ctx.js'

const ECHO_SERVER = fileURLToPath(new URL('../fixtures/mcp-echo-server.mjs', import.meta.url))

// Spawning node + an MCP handshake takes a moment; give each case room.
const SPAWN_TIMEOUT = 20_000

describe('McpManager', () => {
  it(
    'connects to a real stdio server, mounts its tool, and the tool round-trips',
    async () => {
      const mcp = new McpManager()
      const registry = new ToolRegistry()
      const logs: string[] = []
      const servers: Record<string, McpServerConfig> = {
        echo: { command: process.execPath, args: [ECHO_SERVER], env: {} },
      }
      await mcp.connectAll(servers, registry, (m) => logs.push(m))

      const tool = registry.get('mcp__echo__echo')
      expect(tool).toBeDefined()
      // The model-facing schema is the server's JSON Schema, surfaced verbatim.
      expect(toolInputSchema(tool!)).toMatchObject({
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      })
      expect(logs).toContain('MCP: mounted 1 tool(s) from "echo"')

      const res = await tool!.execute({ text: 'hi' } as never, makeCtx(process.cwd()))
      expect(res.isError).toBe(false)
      expect(res.output).toContain('hi')

      await expect(mcp.closeAll()).resolves.toBeUndefined()
    },
    SPAWN_TIMEOUT,
  )

  it(
    'a bogus command does not throw, logs a failure, and registers no tool',
    async () => {
      const mcp = new McpManager()
      const registry = new ToolRegistry()
      const logs: string[] = []
      const servers: Record<string, McpServerConfig> = {
        broken: { command: 'this-command-does-not-exist-xyz', args: [], env: {} },
      }
      // Must not reject.
      await expect(mcp.connectAll(servers, registry, (m) => logs.push(m))).resolves.toBeUndefined()
      expect(registry.list()).toHaveLength(0)
      expect(logs.some((m) => m.includes('broken') && m.includes('failed'))).toBe(true)
      await mcp.closeAll()
    },
    SPAWN_TIMEOUT,
  )
})

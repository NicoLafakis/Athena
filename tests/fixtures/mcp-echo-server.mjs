// Minimal real stdio MCP server used by tests/harness/mcp.test.ts. Exposes ONE tool,
// `echo`, that returns its `text` argument back as a text content block. Run with
// `node <this file>` — it talks MCP over stdin/stdout, so it must never write to stdout
// itself (that would corrupt the JSON-RPC stream).
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'echo', version: '0.0.1' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'Echo the provided text back.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  if (name === 'echo') {
    return { content: [{ type: 'text', text: String(args?.text ?? '') }] }
  }
  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
})

const transport = new StdioServerTransport()
await server.connect(transport)

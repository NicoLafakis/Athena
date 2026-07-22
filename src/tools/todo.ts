import { z } from 'zod'
import type { ToolDefinition, TodoItem } from '../engine/types.js'

const TodoInput = z.object({
  todos: z.array(
    z.object({
      text: z.string().min(1),
      status: z.enum(['pending', 'in_progress', 'done']),
    }),
  ),
})

export const todoTool: ToolDefinition<z.infer<typeof TodoInput>> = {
  name: 'TodoWrite',
  description: 'Replace the session task list. Rendered live in the TUI.',
  schema: TodoInput,
  readOnly: true,
  async execute(input, ctx) {
    const todos: TodoItem[] = input.todos
    ctx.todos.length = 0
    ctx.todos.push(...todos)
    ctx.emit({ type: 'todo-update', todos })
    return { output: `Todo list updated (${todos.length} items).`, isError: false }
  },
}

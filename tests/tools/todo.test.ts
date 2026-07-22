import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { todoTool } from '../../src/tools/todo.js'
import { makeCtx } from '../helpers/tool-ctx.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'athena-todo-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('todoTool', () => {
  it('stores todos in ctx and emits todo-update', async () => {
    const ctx = makeCtx(dir)
    const todos = [{ text: 'a', status: 'pending' as const }]
    const res = await todoTool.execute({ todos }, ctx)
    expect(res.isError).toBe(false)
    expect(ctx.todos).toEqual(todos)
    expect(ctx.events).toContainEqual({ type: 'todo-update', todos })
  })

  it('replaces the previous list', async () => {
    const ctx = makeCtx(dir)
    await todoTool.execute(
      {
        todos: [
          { text: 'a', status: 'pending' as const },
          { text: 'b', status: 'in_progress' as const },
        ],
      },
      ctx,
    )
    const next = [{ text: 'b', status: 'done' as const }]
    const res = await todoTool.execute({ todos: next }, ctx)
    expect(res.isError).toBe(false)
    expect(ctx.todos).toEqual(next)
  })

  it('rejects empty todo text via schema', () => {
    expect(todoTool.schema.safeParse({ todos: [{ text: '', status: 'pending' }] }).success).toBe(
      false,
    )
  })
})

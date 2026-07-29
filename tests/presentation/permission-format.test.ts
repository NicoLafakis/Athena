import { describe, expect, it } from 'vitest'
import {
  createAccessiblePermissionRequest,
  formatAccessiblePermission,
} from '../../src/presentation/permission-format.js'

describe('accessible permission formatting', () => {
  it('names identity, target, consequence, reason, choices, and detail route without raw content', () => {
    const request = createAccessiblePermissionRequest({
      id: 'permission-1',
      toolName: 'Write',
      input: {
        file_path: 'src/app.ts',
        content: 'sk-ant-api03-supersecretvalue1234',
      },
      summary: 'Write src/app.ts',
      reason: 'Mutation requires approval.',
      diff: { addedLines: 4, removedLines: 2 },
    })
    expect(request).toMatchObject({
      id: 'permission-1',
      toolName: 'Write',
      target: 'src/app.ts',
      consequence: 'Replace or create file content.',
      diff: { addedLines: 4, removedLines: 2 },
      detailsCommand: '/details permission permission-1',
    })
    const output = formatAccessiblePermission(request)
    expect(output).toContain('Permission: Write requires a decision.')
    expect(output).toContain('Target: src/app.ts')
    expect(output).toContain('Consequence: Replace or create file content.')
    expect(output).toContain('Reason: Mutation requires approval.')
    expect(output).toContain('Changes: 4 added lines, 2 removed lines.')
    expect(output).toContain('[y] allow once; [a] always allow; [n] deny')
    expect(output).toContain('/details permission permission-1')
    expect(output).not.toContain('supersecretvalue1234')
  })

  it('uses bounded generic targets for commands and strips terminal control sequences', () => {
    const request = createAccessiblePermissionRequest({
      id: 'permission-shell',
      toolName: 'PowerShell',
      input: { command: 'do-not-announce-this-secret' },
      summary: '\u001b[31mRun command\u001b[0m',
      reason: '\u001b[2JPolicy asks.',
    })
    expect(request.target).toBe('workspace shell')
    const output = formatAccessiblePermission(request)
    expect(output).not.toContain('do-not-announce-this-secret')
    expect(output).not.toMatch(/\u001b|\u009b/)
    expect(output.length).toBeLessThan(4_096)
  })
})

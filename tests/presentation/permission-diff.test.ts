import { describe, expect, it } from 'vitest'
import {
  formatPermissionDiffDetail,
  permissionDiffStats,
} from '../../src/presentation/permission-diff.js'

describe('presentation-neutral permission diffs', () => {
  it('reports the same line changes used by presentation previews', () => {
    const diff = { oldText: 'keep\nremove', newText: 'keep\nadd one\nadd two' }
    expect(permissionDiffStats(diff)).toEqual({ addedLines: 2, removedLines: 1 })
    expect(formatPermissionDiffDetail(diff)).toContain('- remove')
    expect(formatPermissionDiffDetail(diff)).toContain('+ add one')
  })

  it('bounds and redacts on-demand detail', () => {
    const detail = formatPermissionDiffDetail({
      oldText: '',
      newText: 'sk-ant-api03-supersecretvalue1234',
    })
    expect(detail).toContain('[REDACTED]')
    expect(detail).not.toContain('supersecretvalue1234')
  })
})

import { describe, expect, it } from 'vitest'
import { render } from 'ink-testing-library'
import { Box } from 'ink'
import { DiffPreview } from '../../src/tui/components/DiffPreview.js'

describe('diff truncation notice counts', () => {
  it.each([
    { text: 'x'.repeat(80), hidden: 1 },
    { text: `${'x'.repeat(80)}\nnext line`, hidden: 2 },
  ])('counts affected source lines instead of wrapped terminal rows: $hidden', ({ text, hidden }) => {
    const view = render(<Box width={40}><DiffPreview oldText="" newText={text} columns={40} maxLines={1} /></Box>)
    expect(view.lastFrame()).toContain(`+${hidden} more lines truncated`)
    view.unmount()
  })
})

import { describe, expect, it } from 'vitest'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { transcriptEntriesFromMessages } from '../../src/tui/App.js'

describe('resumed transcript reconstruction', () => {
  it('shows the same user, assistant, and tool history loaded into the Engine', () => {
    const history: MessageParam[] = [
      { role: 'user', content: 'inspect x' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking', citations: null },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'x' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'contents',
            is_error: false,
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'finished', citations: null }] },
    ]
    expect(transcriptEntriesFromMessages(history)).toEqual([
      { kind: 'user', text: 'inspect x' },
      { kind: 'assistant', text: 'checking' },
      {
        kind: 'tool',
        id: 'tool-1',
        name: 'Read',
        input: { file_path: 'x' },
        output: 'contents',
        isError: false,
      },
      { kind: 'assistant', text: 'finished' },
    ])
  })
})

// src/tui/components/TodoPanel.tsx
import { Box, Text } from 'ink'
import type { TodoItem } from '../../engine/types.js'

export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {todos.map((todo, idx) => {
        if (todo.status === 'done')
          return (
            <Text key={idx} dimColor strikethrough>
              [x] {todo.text}
            </Text>
          )
        if (todo.status === 'in_progress')
          return (
            <Text key={idx} color="yellow" bold>
              [~] {todo.text}
            </Text>
          )
        return <Text key={idx}>[ ] {todo.text}</Text>
      })}
    </Box>
  )
}

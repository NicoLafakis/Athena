// src/tui/components/TodoPanel.tsx
import { Box, Text } from 'ink'
import type { TodoItem } from '../../engine/types.js'
import { truncateRowsWithNotice, wrappedRowCount } from '../viewport.js'

/** Columns eaten by borderStyle="round" (1 col each side) + paddingX={1} (1 col each
 *  side) before any todo text actually starts wrapping. Exported so App.tsx's row
 *  budgeting uses the SAME effective width this component actually renders into. */
export const TODO_HORIZONTAL_CHROME_COLS = 4

/** The exact prefix + text a todo renders as — a single source of truth so App.tsx's
 *  fullscreen row budgeting (see wrappedRowCount in viewport.ts) can measure the SAME
 *  string the component below actually renders, rather than assuming every todo is
 *  always exactly one row regardless of text length or terminal width. */
export function todoLineText(todo: TodoItem): string {
  const prefix = todo.status === 'done' ? '[x] ' : todo.status === 'in_progress' ? '[~] ' : '[ ] '
  return prefix + todo.text
}

/** The "+N more..." truncation notice — full (with the "widen terminal..." hint) form
 *  when it comfortably fits the available width, short form otherwise. See
 *  DiffPreview.diffNoticeText for why an unconditionally-verbose notice is itself a
 *  layout-corruption risk at narrow terminal widths. Exported so App.tsx's row budgeting
 *  can reserve the SAME (worst-case) row count this component will actually render. */
export function todoNoticeText(hiddenCount: number, columns: number): string {
  const full = `+${hiddenCount} more (widen terminal or /tui classic to see all)`
  if (wrappedRowCount(full, columns) <= 2) return full
  return `+${hiddenCount} more`
}

export function TodoPanel({
  todos,
  maxRows,
  columns = 80,
}: {
  todos: TodoItem[]
  /** Real remaining CONTENT-rows budget for todo items, computed by App.tsx from the
   *  actual terminal size (fullscreen mode only) — a content-only budget; App.tsx already
   *  reserves room for the "+N more" notice itself separately, so this component doesn't
   *  need to steal a row from `maxRows` for it. Undefined in classic mode, where every
   *  todo renders unbounded — native scrollback means there's no fixed-height layout to
   *  protect. When set and exceeded, the panel shows as many todos as fit (a long todo
   *  can itself wrap to more than one row — see todoLineText/wrappedRowCount) plus a
   *  visible "+N more" notice rather than silently truncating (or, at the Yoga/Ink layout
   *  level, corrupting) the render. */
  maxRows?: number
  /** Terminal column count, needed to know how many rows a given todo's (possibly long)
   *  text actually wraps to — see TODO_HORIZONTAL_CHROME_COLS above for the border/
   *  padding this panel itself consumes from that width. Defaults to 80, matching
   *  Banner's own default. */
  columns?: number
}) {
  const effectiveColumns = Math.max(columns - TODO_HORIZONTAL_CHROME_COLS, 1)
  const rowsOf = (todo: TodoItem): number => wrappedRowCount(todoLineText(todo), effectiveColumns)
  const { shown, hiddenCount } =
    maxRows === undefined ? { shown: todos, hiddenCount: 0 } : truncateRowsWithNotice(todos, rowsOf, maxRows)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {shown.map((todo, idx) => {
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
      {hiddenCount > 0 && <Text dimColor>{todoNoticeText(hiddenCount, effectiveColumns)}</Text>}
    </Box>
  )
}

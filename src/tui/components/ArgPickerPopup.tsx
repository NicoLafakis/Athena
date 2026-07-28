// src/tui/components/ArgPickerPopup.tsx
import { Box, Text } from 'ink'
import type { ArgPickerOption } from '../argPicker.js'
import { popupLine, popupTextColumns, type PopupLayout } from '../popupWindow.js'

export interface ArgPickerPopupProps {
  title: string
  options: readonly ArgPickerOption[]
  index: number
  currentValue: string
  /** Which slice to draw and how tall it is. Unlike the two InputBox-owned popups this
   *  one's owner is App itself, which reserves exactly `layout.rows` for it in the
   *  fullscreen budget — see popupWindow.ts and App.tsx's argPicker budget. */
  layout: PopupLayout
  /** Terminal column count, so every row can be held to exactly one row (popupLine). */
  columns?: number
}

/** Second-level "pick a value" popup for slash commands with an enumerable argument
 *  (/model, /provider, /effort, /mode, /tui run bare) — mirrors SlashMenuPopup's
 *  bordered/windowed visual language in a third accent color (green) so the three
 *  popup kinds (this, SlashMenuPopup's yellow live "/" menu, MentionPopup's cyan '@'
 *  picker) never look alike at a glance. Purely presentational: App.tsx owns all key
 *  handling and just feeds this the cursor `index` and the value that was already
 *  active before the picker opened.
 *
 *  Cursor position (`index`, inverse-highlighted) and "this is the current value"
 *  (`currentValue`, leading marker) are independent signals — the cursor moves as the
 *  user browses, but the marker stays put until Enter actually changes anything, so
 *  both must render correctly even when they point at different rows. */
export function ArgPickerPopup({ title, options, index, currentValue, layout, columns = 80 }: ArgPickerPopupProps) {
  const width = popupTextColumns(columns)
  // Windowed render: keep the selection visible without drawing an unbounded list — the
  // window comes from `layout` (popupWindow.ts), the same math SlashMenuPopup/MentionPopup
  // now use, so a long option list degrades to fewer visible rows instead of overflowing.
  const { start, count } = layout
  const visible = options.slice(start, start + count)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text bold color="green">
        {popupLine(`${title} (↑/↓ select, Enter confirm, Esc cancel)`, width)}
      </Text>
      {start > 0 && <Text dimColor>… {start} earlier</Text>}
      {visible.map((option, i) => {
        const abs = start + i
        const active = abs === index
        const isCurrent = option.value === currentValue
        return (
          <Text key={option.value} color={active ? 'green' : undefined} inverse={active}>
            {popupLine(`${isCurrent ? '● ' : '  '}${option.label}`, width)}
          </Text>
        )
      })}
      {start + count < options.length && <Text dimColor>… {options.length - start - count} more</Text>}
    </Box>
  )
}

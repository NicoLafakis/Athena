// src/tui/components/ArgPickerPopup.tsx
import { Box, Text } from 'ink'
import type { ArgPickerOption } from '../argPicker.js'

const WINDOW = 8

export interface ArgPickerPopupProps {
  title: string
  options: readonly ArgPickerOption[]
  index: number
  currentValue: string
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
export function ArgPickerPopup({ title, options, index, currentValue }: ArgPickerPopupProps) {
  // Windowed render: keep the selection visible without drawing an unbounded list —
  // same math as SlashMenuPopup/MentionPopup, future-proofing for a longer option list
  // even though every current kind's option count is small.
  const start = Math.min(Math.max(0, index - WINDOW + 1), Math.max(0, options.length - WINDOW))
  const visible = options.slice(start, start + WINDOW)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
      <Text bold color="green">
        {title} (↑/↓ select, Enter confirm, Esc cancel)
      </Text>
      {start > 0 && <Text dimColor>… {start} earlier</Text>}
      {visible.map((option, i) => {
        const abs = start + i
        const active = abs === index
        const isCurrent = option.value === currentValue
        return (
          <Text key={option.value} color={active ? 'green' : undefined} inverse={active}>
            {isCurrent ? '● ' : '  '}
            {option.label}
          </Text>
        )
      })}
      {start + WINDOW < options.length && <Text dimColor>… {options.length - start - WINDOW} more</Text>}
    </Box>
  )
}

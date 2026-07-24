// src/tui/argPicker.ts
// Pure logic behind the second-level "select a value" picker for slash commands whose
// argument is an enumerable/fixed set (/model, /provider, /effort, /mode, /tui run bare)
// — mirrors slashMenu.ts's Ink-free, unit-testable split from its presentational
// counterpart (ArgPickerPopup.tsx). This is UI-only: it never touches parseSlash/dispatch
// (slash.ts) or the engine — App.tsx is the one place that turns a picked option into an
// actual onSlash() dispatch.
import { modelKeys, modelLabel, PROVIDER_IDS, PROVIDERS, EFFORTS, type ProviderId } from '../brain/models.js'

export type PickableKind = 'model' | 'provider' | 'effort' | 'mode' | 'tui'

export interface ArgPickerOption {
  value: string
  label: string
}

export interface ArgPickerState {
  kind: PickableKind
  index: number
}

/** The single source of truth for which bare slash-command names open a picker instead
 *  of waiting for a typed argument — read by both InputBox (deciding whether a
 *  slash-menu Tab/Enter selection should hand off immediately instead of filling text)
 *  and App.tsx (detectBarePickableCommand). Do not duplicate this literal set elsewhere. */
export const PICKABLE_KINDS: ReadonlySet<string> = new Set<PickableKind>([
  'model',
  'provider',
  'effort',
  'mode',
  'tui',
])

// Fixed option sets for the two kinds with no dedicated registry of their own — kept in
// sync with slash.ts's MODES/TUI_MODES Sets and engine/types.ts's PermissionMode /
// slash.ts's TuiMode unions by hand, same as slashMenu.ts's BUILTIN_SLASH_COMMANDS already
// does for RESERVED_COMMAND_NAMES.
const MODE_VALUES: readonly string[] = ['normal', 'acceptEdits', 'plan', 'trusted']
const TUI_VALUES: readonly string[] = ['classic', 'fullscreen']

export function pickerOptions(kind: PickableKind, provider: ProviderId): ArgPickerOption[] {
  switch (kind) {
    case 'model':
      return modelKeys(provider).map((k) => ({ value: k, label: modelLabel(provider, k) }))
    case 'provider':
      return PROVIDER_IDS.map((p) => ({ value: p, label: PROVIDERS[p].label }))
    case 'effort':
      return EFFORTS.map((e) => ({ value: e, label: e }))
    case 'mode':
      return MODE_VALUES.map((v) => ({ value: v, label: v }))
    case 'tui':
      return TUI_VALUES.map((v) => ({ value: v, label: v }))
  }
}

/** Defensive fallback to 0 (never -1) so a stale/unrecognized currentValue never leaves
 *  the picker's cursor pointing at nothing. */
export function currentOptionIndex(options: readonly ArgPickerOption[], currentValue: string): number {
  return Math.max(
    0,
    options.findIndex((o) => o.value === currentValue),
  )
}

export function pickerTitle(kind: PickableKind): string {
  switch (kind) {
    case 'model':
      return 'Select model'
    case 'provider':
      return 'Select provider'
    case 'effort':
      return 'Select effort'
    case 'mode':
      return 'Select permission mode'
    case 'tui':
      return 'Select TUI mode'
  }
}

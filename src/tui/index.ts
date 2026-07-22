// src/tui/index.ts
export {
  App,
  PermissionBridge,
  reduceEvent,
  type AppProps,
  type AppStatus,
  type PendingPermission,
  type PermissionAnswer,
} from './App.js'
export { parseSlash, type SlashCommand } from './slash.js'
export { type TranscriptEntry } from './components/Transcript.js'
export { diffLines } from './components/DiffPreview.js'

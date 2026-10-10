import type { BrainPaths } from '../brain/paths.js'
import type { Effort } from '../brain/models.js'
import type { ModelClient } from '../engine/client.js'
import { projectId } from '../harness/trust.js'
import { JournalRuntime } from './runtime.js'
import { JournalStore } from './store.js'

export const JOURNAL_USAGE = 'Usage: athena journal <enable [--time HH:mm] [--timezone IANA] [--no-model]|disable|status|run|entries [--global]|memory [--global]|reject id>'
export async function runJournalCommand(paths: BrainPaths, cwd: string, args: string[], provider?: () => { client: ModelClient; model: string; effort?: Effort } | undefined): Promise<string> {
  const [action = 'status', ...rest] = args
  const store = new JournalStore(paths)
  if (action === 'enable') {
    let time: string | undefined
    let timezone: string | undefined
    let modelSynthesis = true
    for (let index = 0; index < rest.length; index++) {
      const flag = rest[index]
      if (flag === '--no-model') modelSynthesis = false
      else if (flag === '--time') { time = rest[++index]; if (!time) throw new Error(JOURNAL_USAGE) }
      else if (flag === '--timezone') { timezone = rest[++index]; if (!timezone) throw new Error(JOURNAL_USAGE) }
      else throw new Error(JOURNAL_USAGE)
    }
    const config = store.configure({ enabled: true, modelSynthesis, ...(time ? { time } : {}), ...(timezone ? { timezone } : {}) })
    return JSON.stringify({ config, notice: 'Capture uses no model. Daily synthesis uses at most two one-shot attempts, each at most 1400 output tokens. The built-in timer runs while Athena is open or on next startup; this command does not install an OS task.' }, null, 2)
  }
  if (!['disable', 'status', 'run', 'entries', 'memory', 'reject'].includes(action)) throw new Error(JOURNAL_USAGE)
  const global = rest.length === 1 && rest[0] === '--global'
  if (action === 'reject') {
    if (rest.length !== 1 || !/^[a-f0-9]{64}$/.test(rest[0]!)) throw new Error(JOURNAL_USAGE)
    store.reject(rest[0]!)
    return `Journal memory ${rest[0]} rejected; its provenance and history remain preserved.`
  }
  if (rest.length && !(global && ['entries', 'memory'].includes(action))) throw new Error(JOURNAL_USAGE)
  if (action === 'disable') return JSON.stringify(store.configure({ enabled: false }), null, 2)
  const runtime = new JournalRuntime(paths, cwd)
  if (action === 'status') return JSON.stringify(runtime.status(), null, 2)
  if (action === 'entries') return JSON.stringify([...store.load().entries.values()].filter(entry => global || entry.scopeId === projectId(cwd)).slice(-64), null, 2)
  if (action === 'memory') return JSON.stringify(runtime.memoryView(global), null, 2)
  let selected: ReturnType<NonNullable<typeof provider>>
  if (store.config().enabled && store.config().modelSynthesis) selected = provider?.()
  const worker = new JournalRuntime(paths, cwd, { client: selected?.client, model: selected ? () => selected!.model : undefined, effort: selected ? () => selected!.effort : undefined })
  try { return JSON.stringify(await worker.tick(true), null, 2) } finally { await worker.stop() }
}

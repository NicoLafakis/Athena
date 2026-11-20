import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runAuthWizard, terminalIO } from '../auth/wizard.js'
import {
  formatAuthStatus,
  loadCredentials,
  resolveApiKey,
} from '../brain/credentials.js'
import {
  createCredentialVault,
  formatCredentialVaultStatus,
  type CredentialVault,
} from '../brain/credential-vault.js'
import { importBrain } from '../brain/import.js'
import { MemoryHygieneStore } from '../brain/hygiene.js'
import {
  formatFreeTextReviewList,
  restoreFreeTextMemory,
  tombstoneFreeTextMemory,
  verifyCitations,
} from '../brain/free-text-hygiene.js'
import { modelCapabilities } from '../brain/models.js'
import type { BrainPaths } from '../brain/paths.js'
import { loadGlobalTimeZone, loadSettings, readProjectSettingsCapabilities } from '../brain/settings.js'
import { FileLedgerStore } from '../brain/vmp-ledger.js'
import { generateSemanticCandidates, reviewSemanticCandidate } from '../continuity/candidates.js'
import {
  formatContinuityEpisode,
  formatContinuityRanking,
  formatContinuityRollups,
  formatContinuitySearch,
  formatContinuityStatus,
  formatSemanticCandidateReview,
} from '../continuity/presentation.js'
import { ContinuityStore } from '../continuity/store.js'
import { makeTelemetryRecorder } from '../engine/telemetry.js'
import { PluginManager } from '../harness/plugins.js'
import { ProtectedPaths } from '../harness/protected-paths.js'
import { realPathForAccess, ResourcePolicy } from '../harness/resource-policy.js'
import { SessionStore } from '../harness/sessions.js'
import {
  ProjectTrustStore,
  capabilityDigest,
  canonicalProjectPath,
} from '../harness/trust.js'
import { configureVmp, getVmpStatus, printVmpReport, startVmpServer } from '../harness/vmp.js'
import { runJournalCommand } from '../journal/cli.js'
import { admitCandidate, CandidateStore, reflectTraces } from '../learning/candidates.js'
import { LearningEvaluator } from '../learning/evaluation.js'
import { LearningMemoryStore } from '../learning/memory.js'
import { PromotionManager } from '../learning/promotion.js'
import { TraceWarehouse } from '../learning/warehouse.js'
import { CLI_EXIT, type CliCommand } from './args.js'
import { makeClient } from './client.js'
import { resolveStoredProjectTrust } from './trust.js'

export async function runImportCommand(
  cmd: Extract<CliCommand, { command: 'import' }>,
  paths: BrainPaths,
): Promise<void> {
  try {
    const report = await importBrain({ sourceDir: cmd.sourceDir, paths, force: cmd.force })
    console.log(
      `Imported ${report.copied.length} files (${report.rewritten.length} rewritten, ${report.flagged.length} flagged).`,
    )
    console.log(`Report: ${paths.brainDir}/import-report.md`)
  } catch (err) {
    console.error(`Import failed: ${(err as Error).message}`)
    process.exitCode = 1
  }
}

export function runTrustCommand(
  cmd: Extract<CliCommand, { command: 'trust' }>,
  paths: BrainPaths,
  cwd: string,
): void {
  if (!paths.projectBrainDir) {
    console.error(`No .athena project configuration exists in ${cwd}`)
    process.exitCode = 1
    return
  }
  const store = new ProjectTrustStore(paths.trustFile)
  if (cmd.revoke) {
    console.log(
      store.revoke(cwd) ? `Revoked trust for ${canonicalProjectPath(cwd)}` : 'Project was not trusted.',
    )
    return
  }
  if (!store.isTrusted(cwd)) store.trust(cwd)
  const values = readProjectSettingsCapabilities(paths)
  for (const capability of cmd.capabilities) {
    const value = capability === 'hooks' ? values.hooks : values.mcpServers
    store.approveCapability(cwd, capability, capabilityDigest(value))
  }
  console.log(
    `Trusted ${canonicalProjectPath(cwd)}${
      cmd.capabilities.length ? `; approved ${cmd.capabilities.join(', ')}` : ''
    }`,
  )
}

export async function runJournalCliCommand(
  cmd: Extract<CliCommand, { command: 'journal' }>,
  paths: BrainPaths,
  cwd: string,
): Promise<void> {
  try {
    console.log(
      await runJournalCommand(paths, cwd, cmd.args, () => {
        const credentials = loadCredentials(paths)
        const provider = credentials.activeProvider
        const settings = loadSettings({ ...paths, projectBrainDir: null }, provider)
        const key = resolveApiKey(
          provider,
          credentials,
          process.env,
          createCredentialVault(paths),
          (message) => console.error(message),
        )
        if (!key) return undefined
        const recorder = settings.vmp.enabled
          ? makeTelemetryRecorder(new FileLedgerStore(paths.vmpLedgerFile))
          : undefined
        return {
          client: makeClient(provider, key.key, recorder),
          model: modelCapabilities(provider, settings.model).id,
          effort: provider === 'openai' ? settings.effort : undefined,
        }
      }),
    )
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = CLI_EXIT.usage
  }
}

export async function runVmpCommand(
  cmd: Extract<CliCommand, { command: 'vmp' }>,
  paths: BrainPaths,
): Promise<void> {
  const settings = loadSettings(
    { ...paths, projectBrainDir: null },
    loadCredentials(paths).activeProvider,
  )
  try {
    switch (cmd.sub) {
      case 'status': {
        const status = await getVmpStatus(paths, settings)
        console.log(`VMP connector: ${status.enabled ? 'enabled' : 'disabled'}`)
        if (status.reportUrl) console.log(`Report URL: ${status.reportUrl}`)
        console.log(`Key hash configured: ${status.keyHashConfigured ? 'yes' : 'no'}`)
        console.log(`Ledger entries: ${status.ledgerEntries}`)
        break
      }
      case 'report': {
        await printVmpReport(paths)
        break
      }
      case 'configure': {
        if (!cmd.url || !cmd.keyHash) {
          console.error('Usage: athena vmp configure --url <report-url> --key-hash <sha256-hash>')
          process.exitCode = CLI_EXIT.usage
          break
        }
        configureVmp(paths, settings, { reportUrl: cmd.url, keyHash: cmd.keyHash })
        console.log('VMP connector configured. VMP can now pull reports from this app.')
        break
      }
      case 'server': {
        await startVmpServer(paths, settings.vmp, cmd.port)
        // Server runs until SIGINT.
        await new Promise<void>((res) => {
          process.on('SIGINT', () => {
            console.error('\nVMP server stopping.')
            res()
          })
        })
        break
      }
    }
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = 1
  }
}

export function runPluginCommand(
  cmd: Extract<CliCommand, { command: 'plugin' }>,
  paths: BrainPaths,
): void {
  const manager = new PluginManager(paths)
  const [target] = cmd.args
  try {
    switch (cmd.action) {
      case 'list':
        console.log(
          manager
            .list()
            .map(
              (plugin) =>
                `${plugin.id}\t${plugin.version}\t${plugin.enabled ? 'enabled' : 'disabled'}\t` +
                `${plugin.signatureVerified ? 'signed' : 'unsigned'}\t${plugin.source}`,
            )
            .join('\n'),
        )
        break
      case 'install': {
        if (!target) {
          throw new Error('Usage: athena plugin install <directory-or-git-url> [--require-signature]')
        }
        const installed = manager.install(target, { requireSignature: cmd.requireSignature })
        console.log(`Installed ${installed.id}@${installed.version} (${installed.digest.slice(0, 12)})`)
        break
      }
      case 'update': {
        if (!target) throw new Error('Usage: athena plugin update <id> [--require-signature]')
        const updated = manager.update(target, { requireSignature: cmd.requireSignature })
        console.log(`Updated ${updated.id}@${updated.version} (${updated.digest.slice(0, 12)})`)
        break
      }
      case 'enable':
      case 'disable':
        if (!target) throw new Error(`Usage: athena plugin ${cmd.action} <id>`)
        manager.setEnabled(target, cmd.action === 'enable')
        console.log(`${cmd.action === 'enable' ? 'Enabled' : 'Disabled'} ${target}`)
        break
      case 'remove':
        if (!target) throw new Error('Usage: athena plugin remove <id>')
        console.log(`Removed ${target}; recoverable copy: ${manager.remove(target)}`)
        break
      case 'verify':
        if (!target) throw new Error('Usage: athena plugin verify <id>')
        if (!manager.verify(target)) {
          console.error(`Plugin ${target} differs from its installed digest`)
          process.exitCode = 1
        } else {
          console.log(`Plugin ${target} verified`)
        }
        break
    }
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = CLI_EXIT.usage
  }
}

export async function runLearnCommand(
  cmd: Extract<CliCommand, { command: 'learn' }>,
  paths: BrainPaths,
  cwd: string,
): Promise<void> {
  const candidates = new CandidateStore(paths)
  const evaluator = new LearningEvaluator(paths)
  const promotions = new PromotionManager(paths)
  const [first, second] = cmd.args
  try {
    switch (cmd.action) {
      case 'traces':
        console.log(JSON.stringify(await new TraceWarehouse(paths.runsDir).list(), null, 2))
        break
      case 'reflect': {
        if (cmd.args.length === 0) throw new Error('Usage: athena learn reflect <run-id> [run-id...]')
        const candidate = await reflectTraces(paths, cmd.args)
        console.log(candidate.id)
        break
      }
      case 'add': {
        if (!first) throw new Error('Usage: athena learn add <candidate.json>')
        const candidate = await admitCandidate(
          paths,
          JSON.parse(await readFile(resolve(cwd, first), 'utf8')),
        )
        console.log(candidate.id)
        break
      }
      case 'candidates':
        console.log(
          candidates
            .list()
            .map(
              (candidate) =>
                `${candidate.id}\t${candidate.status}\t${candidate.target}\t` +
                `${candidate.confidence.toFixed(2)}\t${candidate.hypothesis.slice(0, 100)}`,
            )
            .join('\n'),
        )
        break
      case 'evaluate': {
        if (!first || !second) {
          throw new Error('Usage: athena learn evaluate <candidate-id> <suite.json>')
        }
        const comparison = await evaluator.evaluate(
          candidates.load(first),
          evaluator.loadSuite(resolve(cwd, second)),
          cwd,
        )
        console.log(JSON.stringify(comparison, null, 2))
        break
      }
      case 'promote': {
        if (!first) throw new Error('Usage: athena learn promote <candidate-id> --approve')
        const record = promotions.promoteCanary(first, cwd, cmd.approved)
        console.log(`Canary ${record.id} applied; run a canary evaluation before finalize.`)
        break
      }
      case 'canary': {
        if (!first || !second) throw new Error('Usage: athena learn canary <candidate-id> <suite.json>')
        const run = await evaluator.runCanary(
          candidates.load(first),
          evaluator.loadSuite(resolve(cwd, second)),
          cwd,
        )
        console.log(run.id)
        break
      }
      case 'finalize': {
        if (!first || !second) {
          throw new Error('Usage: athena learn finalize <candidate-id> <canary-run-id>')
        }
        console.log(promotions.finalize(first, second, cwd).id)
        break
      }
      case 'rollback':
        if (!first) throw new Error('Usage: athena learn rollback <candidate-id>')
        console.log(promotions.rollback(first, cwd).id)
        break
      case 'consolidate': {
        const claims = new LearningMemoryStore(paths).consolidate()
        console.log(`Consolidated ${claims.length} learned-memory claim(s).`)
        break
      }
      case 'lineage':
        console.log(
          JSON.stringify(
            {
              verification: promotions.verifyLineage(),
              records: promotions.lineage(),
            },
            null,
            2,
          ),
        )
        break
    }
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = CLI_EXIT.usage
  }
}

export function runMemoryCommand(
  cmd: Extract<CliCommand, { command: 'memory' }>,
  paths: BrainPaths,
  cwd: string,
): void {
  const store = new ContinuityStore(paths.continuityDir, { onWarn: (warning) => console.error(warning) })
  try {
    if (cmd.action === 'rebuild') {
      const result = store.rebuild(paths.sessionsDir)
      console.log(`Indexed ${result.episodeCount} episode(s) from ${result.sessionCount} session(s).`)
      for (const warning of result.warnings) console.error(warning)
      return
    }
    if (cmd.action === 'status') {
      console.log(formatContinuityStatus(store))
      return
    }
    if (cmd.action === 'candidates') {
      const semanticStore = new MemoryHygieneStore(paths.memoryDir, {
        onWarn: (warning) => console.error(warning),
      })
      const result = generateSemanticCandidates(store, paths.sessionsDir, semanticStore)
      console.log(formatSemanticCandidateReview(result, semanticStore.listAll()))
      return
    }
    if (cmd.action === 'hygiene') {
      const result = verifyCitations(paths.memoryDir, cwd)
      console.log(
        `Checked ${result.checked} memory file(s); relocated ${result.relocated} citation(s); flagged ${result.flagged.length}.`,
      )
      console.log(formatFreeTextReviewList(paths.memoryDir))
      return
    }
    if (cmd.action === 'review') {
      if (cmd.args[0] === '--list') {
        console.log(formatFreeTextReviewList(paths.memoryDir))
        return
      }
      if (cmd.args[0] === '--keep' && cmd.args[1]) {
        restoreFreeTextMemory(paths.memoryDir, cmd.args[1])
        console.log(`Restored free-text memory ${cmd.args[1]} to active.`)
        return
      }
      if (cmd.args[0] === '--tombstone' && cmd.args[1]) {
        const reason = cmd.args.slice(2).join(' ') || 'tombstoned via review'
        tombstoneFreeTextMemory(paths.memoryDir, cmd.args[1], reason)
        console.log(`Tombstoned free-text memory ${cmd.args[1]}.`)
        return
      }
      const [memoryId, action] = cmd.args
      if (!memoryId || (action !== 'promote' && action !== 'reject')) {
        throw new Error('Usage: athena memory review <memory-id> <promote|reject> | --list | --keep <path> | --tombstone <path> [reason]')
      }
      const semanticStore = new MemoryHygieneStore(paths.memoryDir, {
        onWarn: (warning) => console.error(warning),
      })
      const reviewed = reviewSemanticCandidate(semanticStore, store, paths.sessionsDir, memoryId, action)
      console.log(`Semantic memory ${reviewed.memoryId} ${action === 'promote' ? 'promoted' : 'rejected'}.`)
      return
    }
    if (cmd.action === 'forget') {
      const [memoryId] = cmd.args
      if (!memoryId) throw new Error('Usage: athena memory forget <memory-id>')
      const semanticStore = new MemoryHygieneStore(paths.memoryDir, {
        onWarn: (warning) => console.error(warning),
      })
      const forgotten = semanticStore.forget(memoryId)
      console.log(`Semantic memory ${forgotten.memoryId} forgotten. Its source session remains available for historical recall.`)
      return
    }

    let timeZone: string | undefined
    try {
      timeZone = loadGlobalTimeZone(paths, (warning) => console.error(warning))
    } catch {
      console.error('The configured timezone could not be loaded; memory dates will use the inferred OS timezone.')
    }

    if (cmd.action === 'rollup') {
      console.log(formatContinuityRollups(
        store,
        paths.sessionsDir,
        timeZone,
        cmd.args[0] as 'day' | 'week' | 'month' | 'quarter' | 'year' | undefined,
      ))
      return
    }
    if (cmd.action === 'rank') {
      const semanticStore = new MemoryHygieneStore(paths.memoryDir, {
        onWarn: (warning) => console.error(warning),
      })
      const currentProjectId = new SessionStore(paths.sessionsDir, cwd).projectId
      console.log(formatContinuityRanking(store, {
        sessionsRoot: paths.sessionsDir,
        query: cmd.args.join(' '),
        semanticMemories: semanticStore.listAll(),
        currentProjectId,
        ...(cmd.projectId ? { projectId: cmd.projectId } : {}),
        ...(timeZone ? { timeZone } : {}),
      }))
      return
    }
    if (cmd.action === 'search' || cmd.action === 'timeline') {
      console.log(formatContinuitySearch(store, paths.sessionsDir, {
        action: cmd.action,
        query: cmd.args.join(' '),
        ...(cmd.projectId ? { projectId: cmd.projectId } : {}),
        ...(timeZone ? { timeZone } : {}),
      }))
      return
    }
    console.log(formatContinuityEpisode(store, paths.sessionsDir, cmd.args[0]!))
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = CLI_EXIT.usage
  }
}

export function runSessionCommand(
  cmd: Extract<CliCommand, { command: 'session' }>,
  paths: BrainPaths,
  cwd: string,
): void {
  const store = new SessionStore(paths.sessionsDir, cwd)
  const continuityStore = new ContinuityStore(paths.continuityDir, { onWarn: (warning) => console.error(warning) })
  const [id, ...rest] = cmd.args
  try {
    switch (cmd.action) {
      case 'list':
        console.log(
          store.list().map((item) => `${item.id}\t${item.updatedAt.toISOString()}\t${item.title}`).join('\n'),
        )
        break
      case 'search':
        if (!id) throw new Error('Usage: athena session search <query>')
        console.log(
          store.search(cmd.args.join(' ')).map((item) => `${item.id}\t${item.title}`).join('\n'),
        )
        break
      case 'checkpoints':
        if (!id) throw new Error('Usage: athena session checkpoints <session-id>')
        console.log(
          store
            .checkpoints(id)
            .map((item) => `${item.id}\t${item.timestamp.toISOString()}\t${item.label}`)
            .join('\n'),
        )
        break
      case 'rewind':
        if (!id || !rest[0]) throw new Error('Usage: athena session rewind <session-id> <checkpoint-id>')
        store.rewind(id, rest[0])
        console.log(`Rewound ${id} to ${rest[0]}`)
        break
      case 'fork': {
        if (!id) throw new Error('Usage: athena session fork <session-id> [checkpoint-id]')
        const fork = store.fork(id, rest[0])
        console.log(fork.id)
        break
      }
      case 'rename':
        if (!id || rest.length === 0) throw new Error('Usage: athena session rename <session-id> <title>')
        store.rename(id, rest.join(' '))
        console.log(`Renamed ${id}`)
        break
      case 'delete':
        if (!id) throw new Error('Usage: athena session delete <session-id>')
        store.assertExists(id)
        continuityStore.tombstoneSession(store.projectId, id)
        try {
          console.log(`Deleted ${id}; recoverable copy: ${store.delete(id)}; continuity suppressed.`)
        } catch (error) {
          continuityStore.restoreSession(store.projectId, id, paths.sessionsDir)
          throw error
        }
        break
      case 'restore': {
        if (!id) throw new Error('Usage: athena session restore <session-id>')
        const file = store.restore(id)
        const result = continuityStore.restoreSession(store.projectId, id, paths.sessionsDir)
        if (result.state === 'indexed') {
          console.log(`Restored ${id}; continuity indexed ${result.episodeCount} episode(s).`)
        } else {
          console.error(`Restored ${id} at ${file}, but continuity could not be refreshed (${result.state}). Run \`athena memory rebuild\`.`)
          process.exitCode = CLI_EXIT.provider
        }
        break
      }
    }
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = CLI_EXIT.usage
  }
}

/** Construct the fenced ResourcePolicy for `athena watch` including canonical ProtectedPaths. */
export function createWatchResourcePolicy(
  cwd: string,
  paths: BrainPaths,
  configuredProtectedRoots: readonly string[],
): ResourcePolicy {
  const protectedRoots = configuredProtectedRoots.flatMap((root) => {
    try {
      const canonical = realPathForAccess(root, cwd)
      return canonical === root ? [root] : [root, canonical]
    } catch {
      return [root]
    }
  })
  const protectedPaths = ProtectedPaths.from(protectedRoots)
  return new ResourcePolicy(cwd, 'workspace-write', [paths.brainDir], protectedPaths)
}

export async function runWatchCommand(
  cmd: Extract<CliCommand, { command: 'watch' }>,
  paths: BrainPaths,
  cwd: string,
): Promise<void> {
  const {
    probeFilesystemWatch,
    runForegroundFilesystemWatch,
    WatchStore,
    createExplicitFilesystemWatch,
  } = await import('../harness/watchers/index.js')
  const probe = await probeFilesystemWatch()
  if (cmd.statusOnly) {
    console.log(`Watch backend: ${probe.backend} (${probe.available ? 'available' : 'unavailable'})`)
    console.log(`Detail: ${probe.detail}`)
    console.log(`Recovery command: ${probe.recoveryCommand}`)
    return
  }
  const targetPath = resolve(cwd, cmd.path ?? '.')
  let protectedRoots: string[] = []
  try {
    const provider = loadCredentials(paths).activeProvider
    const trust = resolveStoredProjectTrust(paths, cwd)
    protectedRoots = loadSettings(paths, provider, undefined, {
      projectTrusted: trust.trusted,
      allowProjectHooks: false,
      allowProjectMcp: false,
    }).protectedPaths
  } catch {
    protectedRoots = []
  }
  const resourcePolicy = createWatchResourcePolicy(cwd, paths, protectedRoots)
  const store = new WatchStore(paths.watchesFile)
  const watchDef = store.upsert(
    createExplicitFilesystemWatch({
      requestedBy: 'user',
      projectRoot: cwd,
      resource: targetPath,
      policy: resourcePolicy,
    }),
  )
  console.log(`Athena watching ${targetPath} (watch ID ${watchDef.id}). Press Ctrl+C to stop.`)
  const controller = new AbortController()
  const handleSigint = () => {
    console.log('\nStopping watch.')
    controller.abort()
  }
  process.on('SIGINT', handleSigint)
  const handle = runForegroundFilesystemWatch({
    watchId: watchDef.id,
    resourcePath: targetPath,
    signal: controller.signal,
    onObservation: (obs) => {
      console.log(`[${obs.observedAt}] Watch ${obs.watchId}: ${obs.summary}`)
    },
    onFailure: (warn) => {
      console.error(warn)
    },
  })
  await new Promise<void>((res) => {
    controller.signal.addEventListener('abort', () => {
      handle.close()
      process.removeListener('SIGINT', handleSigint)
      res()
    })
  })
}

export async function runAuthCommand(
  cmd: Extract<CliCommand, { command: 'auth' }>,
  paths: BrainPaths,
  credentialVault: CredentialVault,
): Promise<void> {
  if (cmd.sub === 'status') {
    try {
      const creds = loadCredentials(paths)
      console.log(formatAuthStatus(creds, creds.activeProvider, process.env, credentialVault))
      console.log(formatCredentialVaultStatus(credentialVault))
    } catch (err) {
      console.error((err as Error).message)
      process.exitCode = 1
    }
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('athena auth needs an interactive terminal.')
    process.exitCode = 1
    return
  }
  const authPresentation =
    cmd.accessibility ??
    loadSettings(paths, cmd.provider ?? 'anthropic').accessibility.presentation
  await runAuthWizard({
    paths,
    provider: cmd.provider,
    vault: credentialVault,
    io: terminalIO({ screenReader: authPresentation === 'screen-reader' }),
  })
}

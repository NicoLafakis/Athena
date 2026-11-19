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
import { modelCapabilities } from '../brain/models.js'
import type { BrainPaths } from '../brain/paths.js'
import { loadSettings, readProjectSettingsCapabilities } from '../brain/settings.js'
import { FileLedgerStore } from '../brain/vmp-ledger.js'
import { makeTelemetryRecorder } from '../engine/telemetry.js'
import { PluginManager } from '../harness/plugins.js'
import { ResourcePolicy } from '../harness/resource-policy.js'
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

export function runSessionCommand(
  cmd: Extract<CliCommand, { command: 'session' }>,
  paths: BrainPaths,
  cwd: string,
): void {
  const store = new SessionStore(paths.sessionsDir, cwd)
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
        console.log(`Deleted ${id}; recoverable copy: ${store.delete(id)}`)
        break
    }
  } catch (err) {
    console.error((err as Error).message)
    process.exitCode = CLI_EXIT.usage
  }
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
  const resourcePolicy = new ResourcePolicy(cwd, 'workspace-write', [paths.brainDir])
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

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { LibraryRuntime } from '../../src/library/runtime.js'
import { LibraryConfigSchema } from '../../src/library/config.js'
import { HarnessSessionController } from '../../src/harness/controller.js'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { makeSettingsSchema } from '../../src/brain/settings.js'
import type { MockAnthropicClient } from './mock-client.js'
import type { LibraryNote, Review } from '../../src/library/core.js'

function runGit(cwd: string, autocrlf: boolean, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'core.autocrlf=' + String(autocrlf),
      '-c',
      `core.hooksPath=${join(cwd, 'empty-hooks')}`,
      '-c',
      'user.name=Synthetic Reviewer',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()
}

function buildFreshRepo(enabled: boolean, autocrlf: boolean): string {
  const cwd = mkdtempSync(join(tmpdir(), 'athena-library-integration-'))
  mkdirSync(join(cwd, '.athena'))
  mkdirSync(join(cwd, 'reviews'))
  mkdirSync(join(cwd, 'empty-hooks'))
  runGit(cwd, autocrlf, 'init', '--initial-branch=main')
  runGit(cwd, autocrlf, 'config', 'core.autocrlf', String(autocrlf))
  writeFileSync(
    join(cwd, 'detail.md'),
    autocrlf
      ? 'Detailed context retention rationale: keep original sources.\r\nQualify uncertain claims.\r\n'
      : 'Detailed context retention rationale: keep original sources and qualify uncertain claims.\n',
  )
  writeFileSync(join(cwd, 'summary.md'), 'Retain source-linked context.\n')
  writeFileSync(
    join(cwd, 'check.mjs'),
    "import { readFileSync } from 'node:fs'; if (!readFileSync('detail.md','utf8').includes('original sources')) process.exit(1);\n",
  )
  const config = LibraryConfigSchema.parse({
    enabled,
    publicSources: ['detail.md', 'summary.md'],
    categories: ['context'],
    checks: [{ id: 'source-fixture', args: ['check.mjs'] }],
  })
  writeFileSync(join(cwd, '.athena', 'library.config.json'), JSON.stringify(config))
  runGit(cwd, autocrlf, 'add', '--', 'detail.md', 'summary.md', 'check.mjs', '.athena/library.config.json')
  runGit(cwd, autocrlf, 'commit', '--no-gpg-sign', '-m', 'synthetic original sources')
  return cwd
}

export interface LibraryFixtureHarness {
  fixture: (enabled?: boolean, autocrlf?: boolean) => ReturnType<typeof wrapFixture>
  controller: (cwd: string, client: MockAnthropicClient) => Promise<HarnessSessionController>
  cleanupEach: () => Promise<void>
  cleanupAll: () => void
}

function wrapFixture(cwd: string, enabled: boolean, autocrlf: boolean) {
  const git = (...args: string[]) => runGit(cwd, autocrlf, ...args)
  const config = LibraryConfigSchema.parse({
    enabled,
    publicSources: ['detail.md', 'summary.md'],
    categories: ['context'],
    checks: [{ id: 'source-fixture', args: ['check.mjs'] }],
  })
  const library = new LibraryRuntime(cwd, config)
  const input = { detailPath: 'detail.md', summaryPath: 'summary.md', categories: ['context'] }
  function reviewed(note: LibraryNote): string {
    const stages: Review['stage'][] = ['request', 'implementation', 'verification', 'librarian']
    for (const stage of stages) {
      writeFileSync(
        join(cwd, 'reviews', `${stage}.json`),
        JSON.stringify(
          {
            schemaVersion: 1,
            stage,
            noteId: note.id,
            reviewer: `synthetic-${stage}`,
            verdict: 'approve',
            rationale: `Synthetic fixture ${stage} independently inspects the declared source contract.`,
          },
          null,
          autocrlf ? 2 : undefined,
        ).replace(/\n/g, autocrlf ? '\r\n' : '\n'),
      )
    }
    git('add', '--', ...stages.map((stage) => `reviews/${stage}.json`))
    git('commit', '--no-gpg-sign', '-m', 'synthetic review evidence')
    const commit = git('rev-parse', 'HEAD')
    for (const stage of stages) library.review(note.id, commit, `reviews/${stage}.json`)
    return commit
  }
  return { cwd, git, config, library, input, reviewed }
}

/** Per-file fixture harness that caches base git templates (autocrlf=false) via fast cpSync
 *  while keeping every test isolated in its own real Git repo and temporary directory. */
export function createLibraryFixtureHarness(): LibraryFixtureHarness {
  const templates = new Map<string, string>()
  const roots: string[] = []
  const controllers: HarnessSessionController[] = []

  function fixture(enabled = true, autocrlf = false) {
    let cwd: string
    if (autocrlf) {
      // Build fresh to exercise real core.autocrlf=true checkout & commit behavior.
      cwd = buildFreshRepo(enabled, true)
    } else {
      const key = String(enabled)
      let template = templates.get(key)
      if (!template) {
        template = buildFreshRepo(enabled, false)
        templates.set(key, template)
      }
      cwd = mkdtempSync(join(tmpdir(), 'athena-library-integration-'))
      cpSync(template, cwd, { recursive: true })
    }
    roots.push(cwd)
    return wrapFixture(cwd, enabled, autocrlf)
  }

  async function controller(cwd: string, client: MockAnthropicClient): Promise<HarnessSessionController> {
    const home = join(cwd, 'synthetic-home')
    mkdirSync(home)
    const paths = resolveBrainPaths({ cwd, homeOverride: home })
    const value = await HarnessSessionController.create({
      paths,
      effectivePaths: paths,
      cwd,
      client,
      provider: 'anthropic',
      settings: makeSettingsSchema().parse({ permissionMode: 'trusted' }),
      projectTrust: { trusted: true, allowProjectHooks: false, allowProjectMcp: false },
    })
    controllers.push(value)
    return value
  }

  async function cleanupEach(): Promise<void> {
    for (const c of controllers.splice(0)) await c.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  }

  function cleanupAll(): void {
    for (const template of templates.values()) rmSync(template, { recursive: true, force: true })
    templates.clear()
  }

  return { fixture, controller, cleanupEach, cleanupAll }
}

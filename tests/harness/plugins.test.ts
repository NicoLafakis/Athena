import { generateKeyPairSync, sign } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveBrainPaths } from '../../src/brain/paths.js'
import { discoverPlugins, loadSkillsIndexWithPlugins } from '../../src/brain/plugins.js'
import { PluginManager, digestPluginDirectory } from '../../src/harness/plugins.js'

let home: string
let project: string
let source: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'athena-plugin-home-'))
  project = mkdtempSync(join(tmpdir(), 'athena-plugin-project-'))
  source = mkdtempSync(join(tmpdir(), 'athena-plugin-source-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
  rmSync(source, { recursive: true, force: true })
})

function seed(version = '1.0.0'): void {
  mkdirSync(join(source, 'skills'), { recursive: true })
  writeFileSync(
    join(source, 'plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'acme',
      version,
      apiVersion: '1',
      contributes: { skills: 'skills' },
    }),
  )
  writeFileSync(
    join(source, 'skills', 'helper.md'),
    '---\nname: helper\ndescription: Helper\n---\nHelp.',
  )
}

describe('PluginManager', () => {
  it('installs with provenance, loads namespaced capabilities, and verifies the digest', () => {
    seed()
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const manager = new PluginManager(paths)
    const installed = manager.install(source)

    expect(installed).toMatchObject({ id: 'acme', version: '1.0.0', enabled: true })
    expect(manager.verify('acme')).toBe(true)
    expect(loadSkillsIndexWithPlugins(paths).map((skill) => skill.name)).toEqual(['acme:helper'])
    expect(manager.list()[0]!.source).toBe(realpathSync.native(resolve(source)))
  })

  it('enable and disable control discovery without deleting the package', () => {
    seed()
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const manager = new PluginManager(paths)
    manager.install(source)
    manager.setEnabled('acme', false)

    expect(discoverPlugins(paths)).toEqual([])
    expect(existsSync(join(paths.pluginsDir, 'acme'))).toBe(true)
    manager.setEnabled('acme', true)
    expect(discoverPlugins(paths).map((plugin) => plugin.id)).toEqual(['acme'])
  })

  it('updates from recorded provenance and detects later tampering', () => {
    seed()
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const manager = new PluginManager(paths)
    manager.install(source)
    seed('1.1.0')
    expect(manager.update('acme').version).toBe('1.1.0')

    writeFileSync(join(paths.pluginsDir, 'acme', 'skills', 'helper.md'), 'tampered')
    expect(manager.verify('acme')).toBe(false)
  })

  it('rejects an update whose source changes identity without replacing the installed plugin', () => {
    seed()
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const manager = new PluginManager(paths)
    manager.install(source)
    const manifestFile = join(source, 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
    manifest['id'] = 'other'
    manifest['version'] = '2.0.0'
    writeFileSync(manifestFile, JSON.stringify(manifest))

    expect(() => manager.update('acme')).toThrow(/changed plugin id/)
    expect(manager.list()).toMatchObject([{ id: 'acme', version: '1.0.0' }])
    expect(existsSync(join(paths.pluginsDir, 'acme'))).toBe(true)
    expect(existsSync(join(paths.pluginsDir, 'other'))).toBe(false)
  })

  it('moves removed plugins to a recoverable trash location', () => {
    seed()
    const paths = resolveBrainPaths({ cwd: project, homeOverride: home })
    const manager = new PluginManager(paths)
    manager.install(source)
    const trash = manager.remove('acme')
    expect(existsSync(trash)).toBe(true)
    expect(manager.list()).toEqual([])
  })

  it('enforces and verifies optional Ed25519 signatures', () => {
    seed()
    const manifestFile = join(source, 'plugin.json')
    const digest = digestPluginDirectory(source)
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
    manifest['signature'] = {
      algorithm: 'ed25519',
      publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      value: sign(null, Buffer.from(digest, 'hex'), privateKey).toString('base64'),
    }
    writeFileSync(manifestFile, JSON.stringify(manifest))

    const manager = new PluginManager(resolveBrainPaths({ cwd: project, homeOverride: home }))
    expect(manager.install(source, { requireSignature: true }).signatureVerified).toBe(true)
  })
})

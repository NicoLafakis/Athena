import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResourcePolicy } from '../../../src/harness/resource-policy.js'
import {
  WatchStore,
  createExplicitFilesystemWatch,
} from '../../../src/harness/watchers/index.js'

let root: string
let project: string
let storeFile: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'athena-watch-store-'))
  project = join(root, 'project')
  storeFile = join(root, 'brain', 'watches.json')
  mkdirSync(project)
  writeFileSync(join(project, 'source.txt'), 'one')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('WatchStore', () => {
  it('creates nothing implicitly and persists only an explicit user-scoped watch', () => {
    const store = new WatchStore(storeFile)
    expect(store.list()).toEqual([])
    expect(() => createExplicitFilesystemWatch({
      requestedBy: 'system' as 'user',
      projectRoot: project,
      resource: 'source.txt',
      policy: new ResourcePolicy(project),
      now: '2026-07-29T12:00:00.000Z',
    })).toThrow(/explicit user request/)

    const definition = createExplicitFilesystemWatch({
      requestedBy: 'user',
      projectRoot: project,
      resource: 'source.txt',
      policy: new ResourcePolicy(project),
      now: '2026-07-29T12:00:00.000Z',
    })
    store.upsert(definition)
    expect(store.list()).toEqual([definition])
    expect(JSON.parse(readFileSync(storeFile, 'utf8'))).toMatchObject({ schemaVersion: 1 })

    const disabled = store.setLifecycle(definition.id, 'disabled', '2026-07-29T12:01:00.000Z')
    expect(disabled.lifecycle).toBe('disabled')
    expect(store.list()).toHaveLength(1)
  })

  it('denies resources outside policy scope before persisting anything', () => {
    const outside = join(root, 'outside.txt')
    writeFileSync(outside, 'private')
    expect(() => createExplicitFilesystemWatch({
      requestedBy: 'user',
      projectRoot: project,
      resource: outside,
      policy: new ResourcePolicy(project),
    })).toThrow(/outside sandbox roots denied/)
    expect(new WatchStore(storeFile).list()).toEqual([])
  })

  it('keeps a corrupt optional index unchanged and emits one actionable warning', () => {
    mkdirSync(join(storeFile, '..'), { recursive: true })
    writeFileSync(storeFile, '{broken')
    const warnings: string[] = []
    const store = new WatchStore(storeFile, { onWarn: (warning) => warnings.push(warning) })
    expect(store.list()).toEqual([])
    expect(store.list()).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(storeFile)
    expect(warnings[0]).toContain('node-fs-watch')
    expect(warnings[0]).toContain('athena watch')
    expect(() => store.upsert(createExplicitFilesystemWatch({
      requestedBy: 'user',
      projectRoot: project,
      resource: 'source.txt',
      policy: new ResourcePolicy(project),
    }))).toThrow(/left unchanged/)
    expect(readFileSync(storeFile, 'utf8')).toBe('{broken')
  })
})

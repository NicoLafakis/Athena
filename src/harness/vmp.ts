import { createServer, type IncomingMessage } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { BrainPaths } from '../brain/paths.js'
import type { Settings, VmpConnectorSettings } from '../brain/settings.js'
import { saveSettings } from '../brain/settings.js'
import { FileLedgerStore } from '../brain/vmp-ledger.js'
import { sha256 } from '../../api-calculator/src/auth.js'
import { readAttempts } from '../../api-calculator/src/ledger.js'
import { buildReport } from '../../api-calculator/src/report.js'

export interface VmpStatus {
  enabled: boolean
  reportUrl?: string
  keyHashConfigured: boolean
  ledgerEntries: number
}

export async function getVmpStatus(paths: BrainPaths, settings: Settings): Promise<VmpStatus> {
  const store = FileLedgerStore.forPaths(paths)
  const attempts = await store.listSince(new Date(Date.now() - 365 * 86_400_000))
  return {
    enabled: settings.vmp.enabled,
    reportUrl: settings.vmp.reportUrl,
    keyHashConfigured: Boolean(settings.vmp.keyHash),
    ledgerEntries: attempts.length,
  }
}

export async function buildVmpReport(paths: BrainPaths, days = 30) {
  const store = FileLedgerStore.forPaths(paths)
  const attempts = await readAttempts(store, days)
  return buildReport(attempts, days, () => null)
}

export async function printVmpReport(paths: BrainPaths, days = 30): Promise<void> {
  const report = await buildVmpReport(paths, days)
  console.log(JSON.stringify(report, null, 2))
}

export function configureVmp(
  paths: BrainPaths,
  settings: Settings,
  updates: { reportUrl: string; keyHash: string },
): void {
  const normalizedHash = updates.keyHash.toLowerCase().trim()
  if (!/^[a-f0-9]{64}$/.test(normalizedHash)) {
    throw new Error('key-hash must be a 64-character hex SHA-256 hash')
  }
  const next: Settings = {
    ...settings,
    vmp: {
      enabled: true,
      reportUrl: updates.reportUrl,
      keyHash: normalizedHash,
    },
  }
  saveSettings(paths, next)
}

export function revokeVmp(paths: BrainPaths, settings: Settings): void {
  const next: Settings = { ...settings, vmp: { enabled: false } }
  saveSettings(paths, next)
}

function isAuthorizedNode(req: IncomingMessage, expectedHash: string): boolean {
  const header = req.headers['authorization']
  const value = Array.isArray(header) ? header[0] : header
  const token = typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7).trim() : ''
  if (!token || !/^[a-f0-9]{64}$/i.test(expectedHash)) return false
  const actual = Buffer.from(sha256(token), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function startVmpServer(
  paths: BrainPaths,
  settings: VmpConnectorSettings,
  port = 8080,
): Promise<void> {
  if (!settings.enabled || !settings.keyHash) {
    throw new Error('VMP connector is not configured; run `athena vmp configure` first')
  }
  const store = FileLedgerStore.forPaths(paths)
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (req.method !== 'GET' || url.pathname !== '/api/vmp/report') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    if (!isAuthorizedNode(req, settings.keyHash!)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    const days = Number(url.searchParams.get('days') ?? '30')
    const attempts = await readAttempts(store, days)
    const report = buildReport(attempts, days, () => null)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(report))
  })

  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      console.error(`VMP report server listening on http://localhost:${port}/api/vmp/report`)
      resolve()
    })
    server.on('error', reject)
  })
}

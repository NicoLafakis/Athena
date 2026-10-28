import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { digest, type LibraryNote, type Review } from './core.js'
import { projectFile, readProjectText, type LibraryConfig } from './config.js'

const ReviewEvidenceSchema = z.object({
  schemaVersion: z.literal(1), stage: z.enum(['request', 'implementation', 'verification', 'librarian']),
  noteId: z.string().regex(/^[a-f0-9]{64}$/), reviewer: z.string().min(1).max(120),
  verdict: z.literal('approve'), rationale: z.string().min(20).max(2000),
}).strict()
export interface CheckResult { id: string; passed: boolean; outputHash: string; definitionHash: string }
/** Local read-only Git inspection; no shell interpolation, network or configured
 * check execution during retrieval. Git object contents, not claimed hashes, win. */
export class GitLibraryVerifier {
  constructor(readonly cwd: string, readonly config: LibraryConfig) {}
  private git(args: string[], input?: string): Buffer {
    return execFileSync('git', ['--no-optional-locks', '-C', this.cwd, ...args], { input, maxBuffer: 1_000_000, timeout: 10_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  }
  tree(commit?: string): string { if (commit && !/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid commit identity'); return this.git(['rev-parse', (commit ?? 'HEAD') + '^{tree}']).toString('utf8').trim() }
  head(): string { return this.git(['rev-parse', 'HEAD']).toString('utf8').trim() }
  source(id: string): { id: string; revision: string } {
    if (!this.config.publicSources.includes(id)) throw new Error('Source lacks explicit public approval')
    return { id, revision: this.revision(this.workingBlob(id)) }
  }
  current(source: LibraryNote['sources'][number]): boolean {
    try { return this.source(source.id).revision === source.revision } catch { return false }
  }
  private revision(blob: string): string { return digest('git-canonical-blob-v1:' + blob) }
  private workingBlob(name: string): string {
    projectFile(this.cwd, name)
    // Git's built-in text/eol rules normalize LF/CRLF. Refuse external clean filters
    // and non-UTF8 encodings rather than executing project filters during recall.
    const attrs = this.git(['check-attr', '-z', 'filter', 'working-tree-encoding', '--', name]).toString('utf8').split('\0')
    for (let at = 2; at < attrs.length; at += 3) if (!['unspecified', 'unset'].includes(attrs[at]!)) throw new Error('Library sources cannot use custom filters or working-tree encodings')
    return this.git(['hash-object', '--stdin', `--path=${name}`], readProjectText(this.cwd, name)).toString('utf8').trim()
  }
  private committedBlob(commit: string, name: string): string {
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid commit identity')
    projectFile(this.cwd, name)
    return this.git(['rev-parse', '--verify', `${commit}:${name}`]).toString('utf8').trim()
  }
  definitionHash(check: LibraryConfig['checks'][number]): string {
    return digest(JSON.stringify({ version: 1, id: check.id, executable: process.execPath, nodeVersion: process.version, cwd: this.cwd, args: check.args, entryRevision: this.revision(this.workingBlob(check.args[0]!)) }))
  }
  committed(note: LibraryNote, commit: string): boolean {
    try {
      this.git(['merge-base', '--is-ancestor', commit, 'HEAD'])
      return note.sources.every(source => this.current(source) && this.revision(this.committedBlob(commit, source.id)) === source.revision)
    } catch { return false }
  }
  review(note: LibraryNote, commit: string, path: string): Review {
    const actual = readProjectText(this.cwd, path)
    const blob = this.workingBlob(path)
    if (blob !== this.committedBlob(commit, path)) throw new Error('Review evidence is not the committed revision')
    const evidence = ReviewEvidenceSchema.parse(JSON.parse(actual))
    if (evidence.noteId !== note.id) throw new Error('Review evidence belongs to a different note')
    return { stage: evidence.stage, reviewer: evidence.reviewer, evidence: this.revision(blob), path }
  }
  /** Operator-only entry point: model tools cannot trigger check execution or
   * promotion. The explicitly opted-in checks run without provider credentials. */
  clean(): boolean {
    try { this.git(['diff', '--quiet', 'HEAD', '--']); return true } catch { return false }
  }
  runChecks(): CheckResult[] {
    if (!this.clean()) throw new Error('Tracked tree must match the committed implementation before checks')
    for (const check of this.config.checks) {
      const entry = check.args[0]!
      if (!/\.[cm]?js$/.test(entry) || entry.startsWith('-')) throw new Error('Check entry must be a committed JavaScript file')
      projectFile(this.cwd, entry)
      this.git(['ls-files', '--error-unmatch', '--', entry])
    }
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'COMSPEC', 'PATHEXT']) if (process.env[key]) env[key] = process.env[key]
    return this.config.checks.map(check => {
      const definitionHash = this.definitionHash(check)
      const result = spawnSync(process.execPath, check.args, { cwd: this.cwd, env, windowsHide: true, timeout: 60_000, maxBuffer: 1_000_000, encoding: 'utf8' })
      return { id: check.id, definitionHash, passed: !result.error && result.status === 0 && definitionHash === this.definitionHash(check), outputHash: createHash('sha256').update(result.stdout ?? '').update(result.stderr ?? '').digest('hex') }
    })
  }
}

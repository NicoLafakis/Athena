import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { containsCredential } from './core.js'

export const LibraryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  publicSources: z.array(z.string().min(1).max(120)).max(128).default([]),
  categories: z.array(z.string().regex(/^[a-z0-9][a-z0-9 -]{0,79}$/)).max(32).default([]),
  checks: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,80}$/), args: z.array(z.string().min(1).max(500)).min(1).max(20) }).strict()).max(8).default([]),
}).strict()
export type LibraryConfig = z.infer<typeof LibraryConfigSchema>
export function projectFile(cwd: string, name: string): string {
  if (isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..') || /(^|\/)(\.git|node_modules|\.env[^/]*|credentials[^/]*|[^/]*\.pem|[^/]*\.key)(\/|$)/i.test(name)) throw new Error('Library source path is not eligible')
  const file = resolve(cwd, name)
  const root = realpathSync(cwd)
  const actual = realpathSync(file)
  const rel = relative(root, actual)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || actual.toLowerCase() !== file.toLowerCase()) throw new Error('Library source is redirected')
  if (!statSync(actual).isFile() || statSync(actual).size > 64_000) throw new Error('Library source exceeds file budget')
  return actual
}
export function readProjectText(cwd: string, name: string): string { return readFileSync(projectFile(cwd, name), 'utf8') }
export function loadLibraryConfig(cwd: string, trusted: boolean): LibraryConfig | null {
  if (!trusted || !existsSync(join(cwd, '.athena', 'library.config.json'))) return null
  const config = LibraryConfigSchema.parse(JSON.parse(readProjectText(cwd, '.athena/library.config.json')))
  if (!config.enabled) return null
  if (!config.publicSources.length || !config.categories.length || !config.checks.length) throw new Error('Library opt-in requires approved public source paths, categories and checks')
  for (const name of config.publicSources) projectFile(cwd, name)
  if (new Set(config.checks.map(check => check.id)).size !== config.checks.length) throw new Error('Duplicate library check ID')
  return config
}
/** Public-source allowlisting is the positive classification boundary. Unknown
 * text is never accepted as a note. These extra filters reject likely secrets/PII. */
export function sensitiveText(content: string): boolean {
  return containsCredential(content) || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b\d{3}-\d{2}-\d{4}\b|\b(?:bearer\s+[a-z0-9._-]{12,}|gh[pousr]_[a-z0-9]{16,})\b|\b(?:confidential|private personal|do not store|sensitive data)\b/i.test(content)
}

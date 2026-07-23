// src/tui/fileMention.ts
// Pure logic behind @-mention autocomplete in InputBox: file walk, fuzzy ranking,
// capped file reads, and context-block formatting. Kept Ink-free and side-effect-light
// so the ranking/formatting pieces are unit-testable without rendering anything.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { glob } from 'tinyglobby'
import Fuse from 'fuse.js'
import { DEFAULT_IGNORE_GLOBS } from '../tools/glob.js'

/** Extra ignore on top of the Glob tool's defaults: build output is never a sensible
 *  @-mention target. */
const MENTION_IGNORE_GLOBS = [...DEFAULT_IGNORE_GLOBS, '**/dist/**']

/** Guard against pathological repos — tinyglobby is fast but an unbounded list would
 *  make every keystroke's fuzzy pass slower and slower. */
const MAX_MENTION_FILES = 5000

/** ~100KB cap on injected file content, matching the spirit of the Read tool's line
 *  cap (src/tools/read.ts) but sized in bytes since we splice raw content, not
 *  numbered lines. */
export const MAX_MENTION_FILE_BYTES = 100_000

/** Recursive project file walk for @-mention autocomplete. Returns paths relative to
 *  cwd with forward slashes (so `@relPath` mentions are stable across platforms). */
export async function walkMentionFiles(cwd: string): Promise<string[]> {
  const matches = await glob('**/*', {
    cwd,
    dot: false,
    absolute: false,
    onlyFiles: true,
    ignore: MENTION_IGNORE_GLOBS,
  })
  return matches.slice(0, MAX_MENTION_FILES).map((f) => f.split(sep).join('/'))
}

/** Pure fuzzy-rank of a query against the known file list — no Ink, no filesystem,
 *  unit-testable in isolation. An empty query returns the first `limit` files
 *  (alphabetical) so the popup isn't blank the instant '@' is typed. */
export function rankFileMatches(query: string, files: readonly string[], limit = 10): string[] {
  if (query.trim() === '') return [...files].sort().slice(0, limit)
  const fuse = new Fuse(files, { threshold: 0.4, ignoreLocation: true })
  return fuse
    .search(query)
    .slice(0, limit)
    .map((r) => r.item)
}

export interface MentionFileContent {
  content: string
  truncated: boolean
}

/** Reads a mentioned file, capped at MAX_MENTION_FILE_BYTES so one huge asset can't
 *  blow out the prompt. relPath is resolved against cwd — same coordinate system the
 *  tools resolve file_path against. */
export function readMentionFile(cwd: string, relPath: string): MentionFileContent {
  const abs = resolve(cwd, relPath)
  if (!existsSync(abs)) return { content: `(file not found: ${relPath})`, truncated: false }
  try {
    const size = statSync(abs).size
    const truncated = size > MAX_MENTION_FILE_BYTES
    const buf = readFileSync(abs)
    const content = truncated ? buf.subarray(0, MAX_MENTION_FILE_BYTES).toString('utf8') : buf.toString('utf8')
    return { content, truncated }
  } catch (err) {
    return { content: `(unreadable: ${(err as Error).message})`, truncated: false }
  }
}

/** Wraps mentioned-file content in a clearly-labeled fenced block so the model can
 *  tell injected file content apart from the user's own words. */
export function formatMentionBlock(relPath: string, content: string, truncated: boolean): string {
  const note = truncated ? `\n(truncated: file exceeds ${MAX_MENTION_FILE_BYTES / 1000}KB cap)` : ''
  return `--- @${relPath} ---\n\`\`\`\n${content}\n\`\`\`${note}\n--- end @${relPath} ---`
}

/** Characters that can continue a mention token once one has started, for FILE paths —
 *  word characters plus '.', '/', '-' (what actually occurs in the forward-slash
 *  relative paths walkMentionFiles emits). Checked immediately after a matched
 *  `@relPath` so a mentioned path that's a literal prefix of another mentioned path in
 *  the same turn (e.g. "@src/a.ts" vs "@src/a.ts.bak", both selected this turn) can't
 *  spuriously match inside the longer one — defense-in-depth alongside
 *  agentMention.ts's identical boundary check, even though this function's blast radius
 *  is smaller (it only iterates paths actually mentioned this turn via the picker, never
 *  the full project file universe). */
const FILE_PATH_CONTINUATION_CHARS = 'A-Za-z0-9_./-'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** True if `@relPath` appears in `text` as a whole mention token — i.e. not merely as a
 *  substring prefix of some longer `@relPath...` token also present in the text. */
function hasWholeFileMention(text: string, relPath: string): boolean {
  const re = new RegExp(`@${escapeRegExp(relPath)}(?![${FILE_PATH_CONTINUATION_CHARS}])`)
  return re.test(text)
}

/** Scans the literal submitted text for @mentions and returns context blocks only for
 *  paths that still appear in it. This is what makes history-recalled drafts or a
 *  backspaced-away mention NOT silently drag along a stale file's content. Each
 *  candidate path is matched as a WHOLE mention token (hasWholeFileMention), not a bare
 *  substring, so a mentioned path that's a textual prefix of another mentioned path
 *  can't falsely "still be present" just because the longer one is. */
export function extractMentionBlocks(
  text: string,
  mentionedFiles: ReadonlyMap<string, MentionFileContent>,
): string[] {
  const blocks: string[] = []
  for (const [relPath, file] of mentionedFiles) {
    if (hasWholeFileMention(text, relPath)) blocks.push(formatMentionBlock(relPath, file.content, file.truncated))
  }
  return blocks
}

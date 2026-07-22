import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { BrainPaths } from './paths.js'

export interface ImportReport {
  copied: string[]
  rewritten: string[]
  flagged: Array<{ file: string; reason: string }>
}

/**
 * Whole-word Ares->Athena outside fenced code blocks.
 * frontmatterOnly limits rewriting to name:/description: lines of the leading frontmatter.
 */
export function rewriteIdentity(
  content: string,
  opts: { frontmatterOnly: boolean }
): { text: string; changed: boolean } {
  const lines = content.split('\n')
  let inCodeBlock = false
  let inFrontmatter = false
  let frontmatterClosed = false
  let changed = false
  const out = lines.map((line, i) => {
    if (i === 0 && line.trim() === '---') {
      inFrontmatter = true
      return line
    }
    if (inFrontmatter && !frontmatterClosed && line.trim() === '---') {
      frontmatterClosed = true
      inFrontmatter = false
      return line
    }
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeBlock = !inCodeBlock
      return line
    }
    if (inCodeBlock) return line
    if (opts.frontmatterOnly) {
      const isTargetLine = inFrontmatter && /^(name|description):/i.test(line.trim())
      if (!isTargetLine) return line
    }
    const next = line
      .replace(/\bAres\b/g, 'Athena')
      .replace(/\bARES\b/g, 'ATHENA')
      .replace(/\bares\b/g, 'athena')
    if (next !== line) changed = true
    return next
  })
  return { text: out.join('\n'), changed }
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const full = join(dir, e)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const SOURCE_CONSTITUTION_NAMES = ['ARES.md', 'CONSTITUTION.md', 'ATHENA.md', 'CLAUDE.md']

export async function importBrain(opts: {
  sourceDir: string
  paths: BrainPaths
  force: boolean
}): Promise<ImportReport> {
  const { sourceDir, paths, force } = opts
  if (!existsSync(sourceDir)) throw new Error(`Source directory not found: ${sourceDir}`)
  const targetMemoryFiles = existsSync(paths.memoryDir) ? walk(paths.memoryDir) : []
  if (targetMemoryFiles.length > 0 && !force) {
    throw new Error(
      `Target memory is non-empty (${targetMemoryFiles.length} files in ${paths.memoryDir}). Re-run with --force to merge/overwrite.`
    )
  }
  const report: ImportReport = { copied: [], rewritten: [], flagged: [] }

  // 1. Constitution: first matching source name, rewritten fully, written as ATHENA.md.
  const constitutionSource = SOURCE_CONSTITUTION_NAMES.map((n) => join(sourceDir, n)).find(
    existsSync
  )
  if (constitutionSource) {
    const { text, changed } = rewriteIdentity(readFileSync(constitutionSource, 'utf8'), {
      frontmatterOnly: false,
    })
    mkdirSync(paths.brainDir, { recursive: true })
    writeFileSync(paths.constitutionFile, text, 'utf8')
    report.copied.push('ATHENA.md')
    if (changed) report.rewritten.push('ATHENA.md')
  } else {
    report.flagged.push({
      file: '(constitution)',
      reason: `No constitution found in ${sourceDir} (looked for ${SOURCE_CONSTITUTION_NAMES.join(', ')})`,
    })
  }

  // 2. memory/ — frontmatter-only rewrite; bodies still mentioning Ares get flagged for manual review.
  //    skills/ and agents/ — copied verbatim (no rewrite), flagged if they mention Ares.
  const sections: Array<{ name: string; targetDir: string; rewrite: boolean }> = [
    { name: 'memory', targetDir: paths.memoryDir, rewrite: true },
    { name: 'skills', targetDir: paths.skillsDir, rewrite: false },
    { name: 'agents', targetDir: paths.agentsDir, rewrite: false },
  ]
  for (const section of sections) {
    const srcDir = join(sourceDir, section.name)
    if (!existsSync(srcDir)) continue
    for (const file of walk(srcDir)) {
      const rel = `${section.name}/${relative(srcDir, file).replaceAll('\\', '/')}`
      const dest = join(section.targetDir, relative(srcDir, file))
      mkdirSync(dirname(dest), { recursive: true })
      let content = readFileSync(file, 'utf8')
      if (section.rewrite && file.endsWith('.md')) {
        const { text, changed } = rewriteIdentity(content, { frontmatterOnly: true })
        content = text
        if (changed) report.rewritten.push(rel)
      }
      writeFileSync(dest, content, 'utf8')
      report.copied.push(rel)
      if (/\bAres\b/i.test(content)) {
        report.flagged.push({
          file: rel,
          reason: 'still mentions Ares outside rewritten regions — review manually',
        })
      }
    }
  }

  // 3. Report file.
  const reportMd = [
    '# Athena Import Report',
    '',
    `Source: ${sourceDir}`,
    `Date: ${new Date().toISOString()}`,
    '',
    `## Copied (${report.copied.length})`,
    ...report.copied.map((f) => `- ${f}`),
    '',
    `## Rewritten (${report.rewritten.length})`,
    ...report.rewritten.map((f) => `- ${f}`),
    '',
    `## Flagged for manual review (${report.flagged.length})`,
    ...report.flagged.map((f) => `- ${f.file} — ${f.reason}`),
    '',
  ].join('\n')
  mkdirSync(paths.brainDir, { recursive: true })
  writeFileSync(join(paths.brainDir, 'import-report.md'), reportMd, 'utf8')
  return report
}

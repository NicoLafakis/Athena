import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { z } from 'zod'
import type { CompilerHost, ParseConfigHost } from 'typescript'
import type { ToolDefinition } from '../engine/types.js'
import { resolveToolPath } from './files.js'

const DiagnosticsInput = z.object({
  path: z.string().optional(),
  max_diagnostics: z.number().int().positive().max(1000).optional(),
})

function isWithin(root: string, path: string): boolean {
  const value = relative(root, path)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

function findTsconfig(start: string, canRead: (path: string) => boolean): string | null {
  let directory = start
  for (;;) {
    const candidate = join(directory, 'tsconfig.json')
    if (!canRead(candidate)) return null
    if (existsSync(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

export const diagnosticsTool: ToolDefinition<z.infer<typeof DiagnosticsInput>> = {
  name: 'Diagnostics',
  description:
    'Collect bounded TypeScript compiler diagnostics in-process without executing project scripts.',
  schema: DiagnosticsInput,
  readOnly: true,
  async execute(input, ctx) {
    try {
      const target = resolveToolPath(ctx, input.path ?? '.', 'read')
      const canReadProject = (path: string): boolean => {
        try {
          resolveToolPath(ctx, path, 'read')
          return true
        } catch {
          return false
        }
      }
      const configFile = findTsconfig(
        existsSync(target) && !target.endsWith('.ts') ? target : dirname(target),
        canReadProject,
      )
      if (!configFile) throw new Error('no tsconfig.json found')
      // TypeScript is a runtime dependency. Its filesystem host is brokered so
      // project config/import traversal cannot escape the active read sandbox.
      const ts = await import('typescript')
      const config = ts.readConfigFile(configFile, (file) => readFileSync(file, 'utf8'))
      if (config.error) {
        return {
          output: ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
          isError: true,
        }
      }
      const parseHost: ParseConfigHost = {
        useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
        fileExists: (file) => canReadProject(file) && ts.sys.fileExists(file),
        readFile: (file) => canReadProject(file) ? ts.sys.readFile(file) : undefined,
        readDirectory: (root, extensions, excludes, includes, depth) => {
          if (!canReadProject(root)) return []
          return ts.sys
            .readDirectory(root, extensions, excludes, includes, depth)
            .filter(canReadProject)
        },
      }
      const parsed = ts.parseJsonConfigFileContent(
        config.config,
        parseHost,
        dirname(configFile),
      )
      for (const file of parsed.fileNames) resolveToolPath(ctx, file, 'read')
      const defaultLibDir = dirname(ts.getDefaultLibFilePath(parsed.options))
      const canReadCompiler = (path: string): boolean =>
        canReadProject(path) || isWithin(defaultLibDir, path)
      const compilerHost: CompilerHost = ts.createCompilerHost(parsed.options)
      const getSourceFile = compilerHost.getSourceFile.bind(compilerHost)
      compilerHost.fileExists = (file) => canReadCompiler(file) && ts.sys.fileExists(file)
      compilerHost.readFile = (file) => canReadCompiler(file) ? ts.sys.readFile(file) : undefined
      compilerHost.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
        canReadCompiler(file)
          ? getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
          : undefined
      compilerHost.directoryExists = (directory) =>
        canReadCompiler(directory) && (ts.sys.directoryExists?.(directory) ?? false)
      compilerHost.getDirectories = (directory) =>
        canReadCompiler(directory)
          ? (ts.sys.getDirectories?.(directory) ?? []).filter(canReadCompiler)
          : []
      const program = ts.createProgram(parsed.fileNames, parsed.options, compilerHost)
      const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
        .slice(0, input.max_diagnostics ?? 200)
        .map((diagnostic) => {
          const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
          if (!diagnostic.file || diagnostic.start === undefined) return message
          const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} TS${diagnostic.code} ${message}`
        })
      const output =
        diagnostics.length > 0
          ? diagnostics.join('\n')
          : `No TypeScript diagnostics for ${configFile}`
      const cap = 100_000
      return {
        output:
          output.length > cap
            ? `${output.slice(0, cap)}\n(truncated: diagnostics exceeded ${cap} chars)`
            : output,
        isError: diagnostics.length > 0,
      }
    } catch (error) {
      return { output: `Diagnostics failed: ${(error as Error).message}`, isError: true }
    }
  },
}

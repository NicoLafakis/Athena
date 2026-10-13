import { resolve } from 'node:path'

export function sessionGrantRule(name: string, input: unknown, cwd: string): string {
  const obj = (input ?? {}) as Record<string, unknown>
  if (name === 'Bash' || name === 'PowerShell') {
    const first = String(obj['command'] ?? '').trim().split(/\s+/)[0] ?? ''
    return `${name}(${first}:*)`
  }
  if (typeof obj['file_path'] === 'string') {
    return `${name}(${resolve(cwd, obj['file_path']).replaceAll('\\', '/')})`
  }
  return name
}

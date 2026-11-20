import { createHash } from 'node:crypto'

/** Canonical SHA-256 hex digest of a raw UTF-8 string. */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Canonical SHA-256 hex digest of a JSON-serialized value. */
export function digest(value: unknown): string {
  return sha256Text(JSON.stringify(value))
}

const SECRET_KEY =
  /^(?:api[_-]?key|authorization|password|passwd|private[_-]?key|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token)$/i

const PEM_PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g
const PEM_PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g
const PROVIDER_KEY_PATTERN = /\bsk-(?:ant|kimi|live|proj|test)-[A-Za-z0-9._-]{8,}\b/g
const STRIPE_KEY_PATTERN = /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g
const LEGACY_SK_PATTERN = /\bsk-[A-Za-z0-9]{20,}\b/g
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g
const AWS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g
const SLACK_TOKEN_PATTERN = /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g
const GOOGLE_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{35}\b/g
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}\b/gi
const INLINE_CREDENTIAL_PATTERN =
  /(\b(?:password|passwd|api[_ -]?key|private[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret)\s*[:=]\s*["']?)(?!\[REDACTED\])([^\s"',;]{6,})(["']?)/gi

const SECRET_PATTERNS: readonly RegExp[] = [
  PEM_PRIVATE_KEY_BLOCK,
  PEM_PRIVATE_KEY_HEADER,
  PROVIDER_KEY_PATTERN,
  STRIPE_KEY_PATTERN,
  LEGACY_SK_PATTERN,
  GITHUB_TOKEN_PATTERN,
  AWS_KEY_PATTERN,
  SLACK_TOKEN_PATTERN,
  GOOGLE_KEY_PATTERN,
  BEARER_PATTERN,
  INLINE_CREDENTIAL_PATTERN,
]

function redactString(value: string): string {
  let text = value
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern === BEARER_PATTERN) {
      text = text.replace(pattern, 'Bearer [REDACTED]')
    } else if (pattern === INLINE_CREDENTIAL_PATTERN) {
      text = text.replace(pattern, '$1[REDACTED]$3')
    } else {
      text = text.replace(pattern, '[REDACTED]')
    }
  }
  return text
}

/** True when `text` matches any shared boundary secret/credential pattern. */
export function containsSecret(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) {
      pattern.lastIndex = 0
      return true
    }
  }
  return false
}

/** Shared boundary redaction for sessions, traces, semantic state, and agent records. */
export function redactSessionValue(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactString(value)
  if (Array.isArray(value)) return value.map((item) => redactSessionValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => [
        name,
        redactSessionValue(item, name),
      ]),
    )
  }
  return value
}

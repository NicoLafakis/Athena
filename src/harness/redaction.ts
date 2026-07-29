const SECRET_KEY = /^(?:api[_-]?key|authorization|password|secret|token|access[_-]?token|refresh[_-]?token)$/i
const SECRET_PATTERNS = [
  /\bsk-(?:ant|kimi|live|proj)-[A-Za-z0-9._-]{8,}\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}\b/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
]

/** Shared boundary redaction for sessions, traces, semantic state, and agent records. */
export function redactSessionValue(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    return SECRET_PATTERNS.reduce(
      (text, pattern) =>
        text.replace(pattern, (match) =>
          /^Bearer\s+/i.test(match) ? 'Bearer [REDACTED]' : '[REDACTED]',
        ),
      value,
    )
  }
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

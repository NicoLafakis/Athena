export type ComputerTargetSurface = 'browser' | 'window' | 'desktop'

export interface ComputerUsePolicyInput {
  objective: string
  targetSurface: ComputerTargetSurface
  allowFullDesktop: boolean
  windowTitle?: string
  typedText?: string
}

export type ComputerUsePolicyVerdict =
  | { allowed: true }
  | { allowed: false; rule: string; reason: string }

interface HardDenyRule {
  rule: string
  pattern: RegExp
  reason: string
}

/**
 * Standing hard deny list that NO global permissionMode or sandboxMode can override
 * (see .wiki/features/computer-use/00-overview.md).
 */
const HARD_DENY_RULES: readonly HardDenyRule[] = [
  {
    rule: 'credentials-vault',
    pattern: /(~\/\.athena|\.athena[\\/]|credentials(?:\.vault)?\.json|\b\.env\b|api[_-]?key\s*vault)/i,
    reason: 'Computer use must never access ~/.athena, credential vaults, or .env files.',
  },
  {
    rule: 'password-manager',
    pattern: /\b(1password|bitwarden|lastpass|keepass|dashlane|keeper\s*vault|credential\s*manager|keychain\s*access)\b/i,
    reason: 'Computer use must never drive password managers or credential stores.',
  },
  {
    rule: 'financial',
    pattern: /\b(confirm\s+purchase|place\s+order|submit\s+payment|wire\s+transfer|checkout|paypal|stripe\.com\/pay|online\s+banking|bank\s+account)\b/i,
    reason: 'Computer use must never interact with banking, payment, or purchase flows.',
  },
  {
    rule: 'os-security',
    pattern: /\b(user\s+account\s+control|\buac\b|windows\s+defender|bitlocker|windows\s+security|credential\s+guard)\b/i,
    reason: 'Computer use must never drive OS security dialogs (UAC, Defender, BitLocker).',
  },
  {
    rule: 'captcha',
    pattern: /\b(captcha|recaptcha|hcaptcha|turnstile|verify\s+you\s+are\s+human)\b/i,
    reason: 'Computer use must never solve or bypass CAPTCHAs or anti-bot challenges.',
  },
  {
    rule: 'messaging',
    pattern: /\b(send\s+email|send\s+message|mail\.google\.com|outlook\.live\.com|compose\s+mail)\b/i,
    reason: 'Computer use must never send email or messages without explicit per-action confirmation.',
  },
  {
    rule: 'cli-laundering',
    pattern: /\b(git\s+push\s+--force|vercel\s+--prod|drop\s+database|rm\s+-rf)\b/i,
    reason: 'Production deploys and destructive git/shell operations must use gated CLI tools, not GUI clicks.',
  },
]

export function evaluateComputerUsePolicy(
  input: ComputerUsePolicyInput,
): ComputerUsePolicyVerdict {
  if (input.targetSurface === 'desktop' && !input.allowFullDesktop) {
    return {
      allowed: false,
      rule: 'bounded-surface',
      reason: 'Full-desktop computer use requires explicit opt-in; default target is a bounded browser or window.',
    }
  }
  const inspectable = [input.objective, input.windowTitle ?? '', input.typedText ?? ''].join('\n')
  for (const deny of HARD_DENY_RULES) {
    if (deny.pattern.test(inspectable)) {
      return { allowed: false, rule: deny.rule, reason: deny.reason }
    }
  }
  return { allowed: true }
}

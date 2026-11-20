export type JevBudgetRejectReason =
  | 'session-budget-exhausted'
  | 'turn-budget-exhausted'
  | 'turn-wall-budget-exhausted'
  | 'circuit-open'
  | 'auth-disabled'

export type JevBudgetReservation =
  | { allowed: true }
  | { allowed: false; reason: JevBudgetRejectReason }

export interface JevBudgetGuardOptions {
  maxSessionAttempts?: number
  maxTurnRequests?: number
  turnWallBudgetMs?: number
  circuitBreakerThreshold?: number
  circuitBreakerCooldownMs?: number
  cacheMaxEntries?: number
  cacheTtlMs?: number
  now?: () => number
}

interface CacheEntry {
  value: unknown
  expiresAt: number
}

/**
 * Root-level operational budget, circuit breaker, and process-only LRU cache
 * for optional Jev decision calls (see .wiki/features/jev-integration/design.md).
 */
export class JevBudgetGuard {
  private readonly maxSessionAttempts: number
  private readonly maxTurnRequests: number
  private readonly turnWallBudgetMs: number
  private readonly circuitBreakerThreshold: number
  private readonly circuitBreakerCooldownMs: number
  private readonly cacheMaxEntries: number
  private readonly cacheTtlMs: number
  private readonly now: () => number

  private sessionAttempts = 0
  private activeTurnId: string | null = null
  private turnRequests = 0
  private turnWallMs = 0
  private consecutiveFailures = 0
  private circuitOpenUntil = 0
  private authDisabled = false
  private readonly cache = new Map<string, CacheEntry>()

  constructor(options: JevBudgetGuardOptions = {}) {
    this.maxSessionAttempts = options.maxSessionAttempts ?? 200
    this.maxTurnRequests = options.maxTurnRequests ?? 2
    this.turnWallBudgetMs = options.turnWallBudgetMs ?? 2_000
    this.circuitBreakerThreshold = options.circuitBreakerThreshold ?? 3
    this.circuitBreakerCooldownMs = options.circuitBreakerCooldownMs ?? 60_000
    this.cacheMaxEntries = options.cacheMaxEntries ?? 128
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000
    this.now = options.now ?? (() => Date.now())
  }

  /** Hard-reserve a dispatch slot before issuing a Jev call. */
  tryReserve(turnId: string): JevBudgetReservation {
    if (this.authDisabled) return { allowed: false, reason: 'auth-disabled' }
    const currentMs = this.now()
    if (this.circuitOpenUntil > 0 && currentMs < this.circuitOpenUntil) {
      return { allowed: false, reason: 'circuit-open' }
    }
    if (this.circuitOpenUntil > 0 && currentMs >= this.circuitOpenUntil) {
      this.circuitOpenUntil = 0
      this.consecutiveFailures = 0
    }
    if (this.sessionAttempts >= this.maxSessionAttempts) {
      return { allowed: false, reason: 'session-budget-exhausted' }
    }
    if (this.activeTurnId !== turnId) {
      this.activeTurnId = turnId
      this.turnRequests = 0
      this.turnWallMs = 0
    }
    if (this.turnRequests >= this.maxTurnRequests) {
      return { allowed: false, reason: 'turn-budget-exhausted' }
    }
    if (this.turnWallMs >= this.turnWallBudgetMs) {
      return { allowed: false, reason: 'turn-wall-budget-exhausted' }
    }
    this.sessionAttempts++
    this.turnRequests++
    return { allowed: true }
  }

  recordElapsed(turnId: string, elapsedMs: number): void {
    if (this.activeTurnId === turnId && Number.isFinite(elapsedMs) && elapsedMs > 0) {
      this.turnWallMs += elapsedMs
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0
    this.circuitOpenUntil = 0
  }

  recordTransientFailure(): void {
    this.consecutiveFailures++
    if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
      this.circuitOpenUntil = this.now() + this.circuitBreakerCooldownMs
    }
  }

  recordAuthFailure(): void {
    this.authDisabled = true
    this.clearCache()
  }

  getCached<T>(key: string): T | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (this.now() >= entry.expiresAt) {
      this.cache.delete(key)
      return undefined
    }
    // Refresh LRU order.
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.value as T
  }

  setCached(key: string, value: unknown): void {
    if (this.cacheMaxEntries <= 0) return
    if (this.cache.has(key)) this.cache.delete(key)
    while (this.cache.size >= this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    this.cache.set(key, { value, expiresAt: this.now() + this.cacheTtlMs })
  }

  clearCache(): void {
    this.cache.clear()
  }

  snapshot(): {
    sessionAttempts: number
    maxSessionAttempts: number
    authDisabled: boolean
    circuitOpen: boolean
  } {
    const currentMs = this.now()
    return {
      sessionAttempts: this.sessionAttempts,
      maxSessionAttempts: this.maxSessionAttempts,
      authDisabled: this.authDisabled,
      circuitOpen: this.circuitOpenUntil > 0 && currentMs < this.circuitOpenUntil,
    }
  }
}

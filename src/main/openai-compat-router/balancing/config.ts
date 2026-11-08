import type { BalancerConfig } from './types'

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const DEFAULT_BALANCER_CONFIG: Readonly<BalancerConfig> = {
  maxAttempts: 3,
  transientFailuresBeforeRest: 3,
  transientWindowMs: 2 * MINUTE,
  transientRestInitialMs: 30 * SECOND,
  transientRestMaxMs: 5 * MINUTE,
  rateRestInitialMs: 30 * SECOND,
  rateRestMaxMs: 5 * MINUTE,
  announcedRestMinMs: SECOND,
  announcedRestMaxMs: DAY,
  quotaRestInitialMs: 30 * MINUTE,
  quotaRestMaxMs: DAY,
  authRestInitialMs: 5 * MINUTE,
  authRestMaxMs: HOUR,
  unavailableRestInitialMs: 30 * MINUTE,
  unavailableRestMaxMs: 6 * HOUR,
  shapeFailuresBeforeRest: 3,
  shapeRestMs: 5 * MINUTE,
  probeLeaseMs: 150 * SECOND,
  forcedProbeIntervalMs: MINUTE,
  stickyMaxSessions: 4_096,
  stickyTtlMs: DAY,
  healthMaxEntries: 512,
  idleForgetMs: DAY,
}

export function resolveBalancerConfig(overrides?: Partial<BalancerConfig>): BalancerConfig {
  return { ...DEFAULT_BALANCER_CONFIG, ...overrides }
}

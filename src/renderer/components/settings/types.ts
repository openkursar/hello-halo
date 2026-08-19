/**
 * Settings Page Types and Configuration
 * Defines navigation structure and section types for the settings page
 */

import type { LucideIcon } from 'lucide-react'

/**
 * Navigation item for settings sidebar
 */
export interface SettingsNavItem {
  /** Unique identifier matching section id */
  id: string
  /** Translation key for display label */
  labelKey: string
  /** Lucide icon component */
  icon: LucideIcon
  /** Only show in desktop app (not remote mode) */
  desktopOnly?: boolean
}

/**
 * Section component props - shared interface for all section components
 */
export interface SettingsSectionProps {
  /** Section id for scrolling and navigation */
  id: string
}

/**
 * Remote access status type
 */
export interface RemoteAccessStatus {
  enabled: boolean
  server: {
    running: boolean
    port: number
    token: string | null
    localUrl: string | null
    lanUrl: string | null
  }
  tunnel: {
    status: 'stopped' | 'starting' | 'running' | 'error'
    url: string | null
    error: string | null
    /** 'named' = permanent hostname, 'quick' = random per-run fallback */
    mode: 'named' | 'quick' | null
    /** Why quick-fallback is active — distinguishes quota from outage */
    fallbackReason: 'issuer_unreachable' | 'issuer_rate_limited' | 'issuer_rejected' | null
  }
  clients: number
}

/**
 * Health check result from diagnostics
 */
export interface HealthCheckResult {
  timestamp: number
  processes: {
    claude: { expected: number; actual: number; pids: number[]; healthy: boolean }
    cloudflared: { expected: number; actual: number; pids: number[]; healthy: boolean }
  }
  services: {
    openaiRouter: { port: number | null; responsive: boolean; responseTime?: number; error?: string }
    httpServer: { port: number | null; responsive: boolean; responseTime?: number; error?: string }
  }
  issues: string[]
  healthy: boolean
  registryCleanup: { removed: number; orphans: number }
}

/**
 * Health report from diagnostics
 */
export interface HealthReport {
  timestamp: string
  version: string
  platform: string
  arch: string
  config: {
    currentSource: string
    provider: string
    hasApiKey: boolean
    apiUrlHost: string
    mcpServerCount: number
  }
  processes: {
    registered: number
    orphansFound: number
    orphansCleaned: number
  }
  health: {
    lastCheckTime: string
    consecutiveFailures: number
    recoveryAttempts: number
  }
  recentErrors: Array<{
    time: string
    source: string
    message: string
  }>
  system: {
    memory: { total: string; free: string }
    uptime: number
  }
}

/**
 * Outcome of the update check shown next to the version number.
 * 'downloading' covers the window between finding an update and it being
 * ready to apply, so the row never looks idle while work is in flight.
 */
export type UpdateCheckPhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'up-to-date' | 'failed'

/**
 * Update status state
 */
export interface UpdateStatus {
  phase: UpdateCheckPhase
  version?: string
  percent?: number
}

/**
 * AppStatusDot
 *
 * Visual status indicator for an app's current state.
 * Renders a colored dot with appropriate size and animation.
 */

import type { AppStatus } from '../../../shared/apps/app-types'
import type { AutomationAppState } from '../../../shared/apps/app-types'
import { deriveAutomationStatus } from '../../utils/automation-status'

interface AppStatusDotProps {
  /** From InstalledApp.status */
  status: AppStatus
  /** If provided, used to distinguish running vs idle for automation apps */
  runtimeStatus?: AutomationAppState['status']
  size?: 'sm' | 'md'
  className?: string
}

export function AppStatusDot({ status, runtimeStatus, size = 'sm', className = '' }: AppStatusDotProps) {
  const sz = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5'

  const effective = deriveAutomationStatus(status, runtimeStatus)

  if (effective === 'running') {
    return (
      <span className={`relative inline-flex ${sz} ${className}`}>
        <span className="absolute inset-0 rounded-full bg-green-400 opacity-75 animate-ping" />
        <span className={`relative inline-block ${sz} rounded-full bg-green-500`} />
      </span>
    )
  }
  if (effective === 'queued') {
    return (
      <span className={`inline-block ${sz} rounded-full bg-blue-400 ${className}`} />
    )
  }
  if (effective === 'idle' || status === 'active') {
    return (
      <span className={`inline-block ${sz} rounded-full bg-green-500/50 ${className}`} />
    )
  }
  if (status === 'waiting_user' || effective === 'waiting_user') {
    return (
      <span className={`inline-block ${sz} rounded-full bg-orange-400 ${className}`} />
    )
  }
  if (status === 'error' || effective === 'error') {
    return (
      <span className={`inline-block ${sz} rounded-full bg-red-500 ${className}`} />
    )
  }
  if (status === 'paused' || effective === 'paused') {
    return (
      <span className={`inline-block ${sz} rounded-full border border-muted-foreground/40 ${className}`} />
    )
  }
  if (status === 'needs_login') {
    return (
      <span className={`inline-block ${sz} rounded-full bg-yellow-400 ${className}`} />
    )
  }
  if (status === 'uninstalled') {
    return (
      <span className={`inline-block ${sz} rounded-full bg-muted-foreground/20 ${className}`} />
    )
  }

  // Fallback: installed (mcp/skill)
  return (
    <span className={`inline-block ${sz} rounded-sm bg-muted-foreground/40 ${className}`} />
  )
}

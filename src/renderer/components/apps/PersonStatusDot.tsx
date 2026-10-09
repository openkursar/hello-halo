/**
 * The dot beside a digital human's status label, paired with
 * describePersonStatus: a flag shows in the owner-attention tones, anything
 * else as the regular status dot for the effective status.
 */

import type { AppStatus, AutomationAppState } from '../../../shared/apps/app-types'
import type { EffectiveAutomationStatus } from '../../utils/automation-status'
import { AppStatusDot } from './AppStatusDot'

interface PersonStatusDotProps {
  appStatus: AppStatus
  effective: EffectiveAutomationStatus
  flag?: 'alert' | 'attention'
  className?: string
}

export function PersonStatusDot({ appStatus, effective, flag, className = '' }: PersonStatusDotProps) {
  if (flag) {
    return <span className={`h-2 w-2 flex-shrink-0 rounded-full ${flag === 'alert' ? 'bg-halo-error' : 'bg-halo-warning'} ${className}`} />
  }
  // The effective status is a runtime status here (a live person, not removed).
  // AppStatusDot reads an `active` app as idle before it checks for paused.
  return (
    <AppStatusDot
      status={effective === 'paused' ? 'paused' : appStatus}
      runtimeStatus={effective as AutomationAppState['status']}
      size="sm"
      className={className}
    />
  )
}

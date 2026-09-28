import type { ReactNode } from 'react'
import type { ImageAttachment } from '../../types'
import type { AttachedPath } from '../../../shared/attached-paths'

/**
 * What the composer needs to offer goal mode. Built by `useGoalComposer`; a
 * composer given none shows no goal controls at all.
 */
export interface GoalComposerConfig {
  /**
   * Send sets the goal and starts working toward it; while a turn runs, it
   * sets the goal for that turn's next step instead.
   */
  active: boolean
  /** Row in the Context group of the composer's "+" menu. */
  menuItem: {
    label: string
    /** One line, shown beside the label: what a goal does for the user. */
    description: string
    onSelect: () => void
  }
  /** Leave goal mode. The typed text stays as an ordinary draft. */
  exit: () => void
  /** Mode marker shown above the textarea while active. */
  chip: ReactNode
  placeholder: string
  sendTitle: string
  /** Whether the draft describes a goal at all. */
  canSubmit: (text: string) => boolean
  /**
   * Resolves false when nothing was sent, so the composer restores the draft.
   * Attached paths ride on the message, never on the goal text.
   */
  submit: (text: string, images: ImageAttachment[] | undefined, thinkingEnabled: boolean, paths?: AttachedPath[]) => Promise<boolean>
  /** Current goal, shown between the live-sessions capsule and the composer card. */
  shelf: ReactNode
}

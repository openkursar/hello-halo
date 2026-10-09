/**
 * Icon and hue of each canvas content type that is not a file, shared by the
 * tab bar and the header and mobile overflow menus, so they never drift apart.
 * `NON_FILE_CONTENT_META` is a full Record: a new content type does not compile
 * until it is listed (`null` for file types, whose icon comes from their extension).
 */

import { Globe, TerminalSquare, GitCompareArrows, Target, Users, type LucideIcon } from 'lucide-react'
import type { ContentType } from '../../services/canvas-lifecycle'

export interface NonFileContentMeta {
  icon: LucideIcon
  /** Text colour class; a type without a coloured menu entry uses `primary`. */
  color: string
}

export const BROWSER_META: NonFileContentMeta = { icon: Globe, color: 'text-blue-500' }
export const TERMINAL_META: NonFileContentMeta = { icon: TerminalSquare, color: 'text-violet-500' }
// 600: orange's 500 is too light on a white tab; light hues among the file-kind colours use 600 too.
export const CHANGES_META: NonFileContentMeta = { icon: GitCompareArrows, color: 'text-orange-600' }

export const NON_FILE_CONTENT_META: Record<ContentType, NonFileContentMeta | null> = {
  code: null,
  markdown: null,
  html: null,
  image: null,
  pdf: null,
  text: null,
  json: null,
  csv: null,
  xlsx: null,
  docx: null,
  pptx: null,
  browser: BROWSER_META,
  terminal: TERMINAL_META,
  changes: CHANGES_META,
  goal: { icon: Target, color: 'text-primary' },
  team: { icon: Users, color: 'text-primary' },
}

/**
 * Type glyphs for store app icons, matching the marketplace visual spec:
 * automation = robot head, skill = bolt, mcp = connected nodes. They are
 * drop-in replacements for lucide icons (accept the same SVG props, stroke
 * with currentColor) so the type-color tokens on the container drive them.
 */

import type { ComponentType, SVGProps } from 'react'
import { Package } from 'lucide-react'
import type { AppType } from '../../../shared/apps/spec-types'

export type GlyphComponent = ComponentType<SVGProps<SVGSVGElement>>

function AutomationGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 7V4" />
      <circle cx="12" cy="3" r="1" />
      <circle cx="9" cy="12.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12.5" r="1" fill="currentColor" stroke="none" />
      <path d="M9.5 16h5" />
    </svg>
  )
}

function SkillGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  )
}

function McpGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="5" cy="12" r="2.2" />
      <circle cx="19" cy="6" r="2.2" />
      <circle cx="19" cy="18" r="2.2" />
      <path d="M7 11l10-4.2M7 13l10 4.2" />
    </svg>
  )
}

export const APP_TYPE_GLYPH: Record<AppType, GlyphComponent> = {
  automation: AutomationGlyph,
  skill: SkillGlyph,
  mcp: McpGlyph,
  extension: Package,
}

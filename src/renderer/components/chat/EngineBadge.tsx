/**
 * EngineBadge
 *
 * Subtle inline marker that tells the user which agent engine
 * ("Claude Code", "Halo SDK", "Codex", "DeepSeek dsh") owns a
 * conversation.
 *
 * Visual treatment is intentionally low-key — light/translucent colored text,
 * no fill, no border — so the badge informs without competing with the
 * conversation title for attention. Hover the badge to see the full engine
 * name in the tooltip.
 *
 * This is the ONLY place in the renderer that's allowed to read an engine
 * id directly. Every other component branches on capability flags via
 * `useEngineCapabilities()` to stay engine-agnostic.
 *
 * Renders nothing for the default ('anthropic') engine to avoid badge
 * clutter on existing CC users — the UX promise is zero disruption for them.
 * Every other engine shows the badge.
 */

import { useTranslation } from '../../i18n'
import type { EngineId } from '../../types'

export interface EngineBadgeProps {
  /**
   * Explicit engine id (e.g. read from a conversation's recorded engine).
   * If null/undefined, treated as 'anthropic' (the legacy default) and the
   * badge does not render — see component comment for rationale.
   */
  engineId?: EngineId | null
  size?: 'xs' | 'sm'
  className?: string
}

export function EngineBadge({ engineId, size = 'xs', className = '' }: EngineBadgeProps) {
  const { t } = useTranslation()

  const resolved = engineId ?? 'anthropic'
  if (resolved === 'anthropic') return null

  // Short label kept consistent in length with "Codex" so the sidebar title
  // doesn't get pushed around. Full product name lives in the tooltip.
  // Whisper-soft tag: barely-there tinted background + dimmed semantic
  // text. Visible enough to identify the engine at a glance, quiet enough
  // that the conversation title remains the focal point.
  const label = resolved === 'codex' ? t('Codex') : resolved === 'dsh' ? t('DSH') : t('Halo')
  const fullName = resolved === 'codex'
    ? t('Codex')
    : resolved === 'dsh' ? t('DeepSeek dsh') : t('Halo SDK')
  const tone = resolved === 'codex'
    ? 'bg-violet-500/[0.05] text-violet-500/65'
    : resolved === 'dsh'
      ? 'bg-blue-500/[0.05] text-blue-500/65'
      : 'bg-cyan-500/[0.05] text-cyan-500/65'

  const sizing = size === 'xs'
    ? 'px-1.5 py-0.5 text-[10px]'
    : 'px-2 py-0.5 text-xs'

  return (
    <span
      className={`inline-flex items-center rounded font-medium shrink-0 ${tone} ${sizing} ${className}`}
      title={t('This conversation runs on the {{engine}} engine.', { engine: fullName })}
    >
      {label}
    </span>
  )
}

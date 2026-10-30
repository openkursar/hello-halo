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
 * The default Halo engine needs no badge. Other labels describe the engine
 * that created the conversation, which may differ after a later switch.
 */

import { useTranslation } from '../../i18n'
import type { EngineId } from '../../types'

export interface EngineBadgeProps {
  /**
   * Explicit engine id (e.g. read from a conversation's recorded engine).
   * If null/undefined, treated as 'anthropic' (the legacy default) and the
   * conversation predates explicit origin stamps.
   */
  engineId?: EngineId | null
  size?: 'xs' | 'sm'
  className?: string
}

export function EngineBadge({ engineId, size = 'xs', className = '' }: EngineBadgeProps) {
  const { t } = useTranslation()

  const resolved = engineId ?? 'anthropic'
  if (resolved === 'halo') return null

  // Short label kept consistent in length with "Codex" so the sidebar title
  // doesn't get pushed around. Full product name lives in the tooltip.
  // Whisper-soft tag: barely-there tinted background + dimmed semantic
  // text. Visible enough to identify the engine at a glance, quiet enough
  // that the conversation title remains the focal point.
  const label = resolved === 'codex' ? t('Codex') : resolved === 'dsh' ? t('DSH') : t('CC')
  const fullName = resolved === 'codex'
    ? t('Codex')
    : resolved === 'dsh' ? t('DeepSeek dsh') : t('Claude Code')
  const tone = 'bg-muted text-muted-foreground'

  const sizing = size === 'xs'
    ? 'px-1.5 py-0.5 text-[10px]'
    : 'px-2 py-0.5 text-xs'

  return (
    <span
      className={`inline-flex items-center rounded font-medium shrink-0 ${tone} ${sizing} ${className}`}
      title={t('This conversation was created with {{engine}}.', { engine: fullName })}
    >
      {label}
    </span>
  )
}

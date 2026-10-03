/**
 * ThinkingLevelControl — the model card's thinking slider (off → max).
 *
 * Shows the level the owner (a conversation, or a digital human) has picked,
 * else what the model's configured effort would do. Moving it saves to the
 * owner through `onChange` and becomes the last-used level that new
 * conversations start from. Engines clamp the level to what they support.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from '../../i18n'
import { THINKING_LEVELS, useThinkingLevelStore, type ThinkingLevel } from '../../stores/thinking-level.store'
import {
  DEFAULT_REASONING_EFFORT,
  clampReasoningEffort,
  isReasoningEffortLevel,
  type ReasoningEffortLevel,
  type ReasoningEffortSetting,
} from '../../../shared/constants/reasoning-effort'

/** A drag passes several stops; only where it settles is saved. */
const SAVE_DELAY_MS = 300

/** Nearest slider stop for a configured setting; a passthrough value reads as the default. */
function stopFor(configured: ReasoningEffortSetting | undefined): ThinkingLevel {
  const level = isReasoningEffortLevel(configured) ? configured : DEFAULT_REASONING_EFFORT
  if (level === 'off') return 'off'
  // 'off' is left out so a configured 'minimal' reads as low, not off.
  const thinkingStops = THINKING_LEVELS.filter(stop => stop !== 'off')
  return (clampReasoningEffort(level, thinkingStops) ?? 'high') as ThinkingLevel
}

interface ThinkingLevelControlProps {
  /** The owner's own level, if it has one. */
  value?: ReasoningEffortLevel
  /** The model's configured effort, shown when nothing was picked. */
  configured?: ReasoningEffortSetting
  /** Saves the level to its owner; omitted where there is no owner yet. */
  onChange?: (level: ThinkingLevel) => void
}

export function ThinkingLevelControl({ value, configured, onChange }: ThinkingLevelControlProps) {
  const { t } = useTranslation()
  const id = useId()
  const setLastUsed = useThinkingLevelStore(state => state.setLevel)
  // Shown from the first step of a drag, before the owner's save lands.
  const [draft, setDraft] = useState<ThinkingLevel | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commit = useRef<() => void>(() => {})
  const saved = stopFor(value ?? configured)
  const level = draft ?? saved
  const pick = (next: ThinkingLevel) => {
    setDraft(next)
    commit.current = () => {
      saveTimer.current = null
      setLastUsed(next)
      onChange?.(next)
    }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => commit.current(), SAVE_DELAY_MS)
  }
  // Leaving mid-delay still saves what was picked.
  useEffect(() => () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      commit.current()
    }
  }, [])
  // The draft has done its job once the owner reports the saved level; a save
  // that fails never does, so the draft also lapses after a while.
  useEffect(() => {
    if (!draft || saveTimer.current) return
    if (saved === draft) {
      setDraft(null)
      return
    }
    const lapse = setTimeout(() => setDraft(null), 3000)
    return () => clearTimeout(lapse)
  }, [draft, saved])
  const index = THINKING_LEVELS.indexOf(level)

  const labels: Record<ThinkingLevel, string> = {
    off: t('Off'),
    low: t('Low'),
    medium: t('Medium'),
    high: t('High'),
    xhigh: t('Extra High'),
    max: t('Max'),
  }

  return (
    <div>
      <input
        id={id}
        type="range"
        min={0}
        max={THINKING_LEVELS.length - 1}
        step={1}
        value={index}
        onChange={event => pick(THINKING_LEVELS[Number(event.target.value)])}
        aria-valuetext={labels[level]}
        className="thinking-slider mt-1 block w-full cursor-pointer"
        style={{ '--fill': `${(index / (THINKING_LEVELS.length - 1)) * 100}%` } as React.CSSProperties}
      />
      <div className="mt-2 flex items-baseline justify-between text-[11px] text-subtle-foreground">
        <label htmlFor={id}>{t('Deep Thinking')}</label>
        <span>{labels[level]}</span>
      </div>
    </div>
  )
}

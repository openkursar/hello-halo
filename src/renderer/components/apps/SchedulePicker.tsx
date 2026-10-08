/**
 * SchedulePicker — visual schedule editor.
 *
 * Two modes:
 *   - Interval: pill buttons for common presets (5m, 1h, 1d, ...)
 *   - Cron (timed): repeat type (daily/weekly/monthly) + day/weekday selection + time list
 *
 * For complex cron expressions that cannot be represented visually,
 * shows a read-only cronstrue description with a hint to edit in YAML.
 *
 * Time selection uses popover grids (hour 6×4, minute 6×10) for fast,
 * precise, desktop-friendly interaction.
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { Info } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { getCurrentLanguage } from '../../i18n'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'
import {
  FREQUENCY_PRESETS,
  durationToMs,
  buildCronFromPicker,
  parseCronToPickerState,
  formatCronHumanReadable,
  type ScheduleValue,
  type CronPickerState,
} from './schedule-utils'

// ============================================
// Props
// ============================================

interface SchedulePickerProps {
  value: ScheduleValue
  onChange: (value: ScheduleValue) => void
  constraints?: {
    min?: string
    max?: string
  }
  disabled?: boolean
  readOnlyReason?: string
}

// ============================================
// Constants
// ============================================

type PickerMode = 'interval' | 'cron'

const WEEKDAY_KEYS = [0, 1, 2, 3, 4, 5, 6] as const
const WEEKDAY_LABELS: Record<number, string> = {
  0: 'Sun',
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat',
}

// ============================================
// HourPicker — popover with 6×4 grid
// ============================================

function HourPicker({
  value,
  onChange,
  disabled,
}: {
  value: number
  onChange: (v: number) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const { t } = useTranslation()

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger>
        <div
          className={`px-2.5 py-1.5 text-sm font-mono rounded-md border transition-colors text-center min-w-[2.5rem] ${
            open
              ? 'border-primary bg-primary/10 text-foreground'
              : 'border-border bg-secondary text-foreground hover:border-primary/50'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        >
          {String(value).padStart(2, '0')}
        </div>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4}>
        <div className="p-2.5">
          <div className="text-[11px] text-muted-foreground mb-2 font-medium">{t('Hour')}</div>
          <div className="grid grid-cols-6 gap-1">
            {Array.from({ length: 24 }, (_, i) => (
              <button
                key={i}
                type="button"
                disabled={disabled}
                onClick={() => { onChange(i); setOpen(false) }}
                className={`w-8 h-7 text-xs rounded-md transition-all duration-100 ${
                  value === i
                    ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/25'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                {String(i).padStart(2, '0')}
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ============================================
// MinutePicker — popover with 6×10 scrollable grid
// ============================================

function MinutePicker({
  value,
  onChange,
  disabled,
}: {
  value: number
  onChange: (v: number) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const { t } = useTranslation()
  const gridRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bring selected minute into view on open
  useEffect(() => {
    if (!open || !gridRef.current) return
    const selected = gridRef.current.querySelector('[data-selected="true"]')
    if (selected) {
      selected.scrollIntoView({ block: 'nearest', behavior: 'auto' })
    }
  }, [open])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger>
        <div
          className={`px-2.5 py-1.5 text-sm font-mono rounded-md border transition-colors text-center min-w-[2.5rem] ${
            open
              ? 'border-primary bg-primary/10 text-foreground'
              : 'border-border bg-secondary text-foreground hover:border-primary/50'
          } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
        >
          {String(value).padStart(2, '0')}
        </div>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4}>
        <div className="p-2.5">
          <div className="text-[11px] text-muted-foreground mb-2 font-medium">{t('Minute')}</div>
          <div
            ref={gridRef}
            className="grid grid-cols-6 gap-1 max-h-48 overflow-y-auto scrollbar-thin"
          >
            {Array.from({ length: 60 }, (_, i) => (
              <button
                key={i}
                type="button"
                disabled={disabled}
                data-selected={value === i}
                onClick={() => { onChange(i); setOpen(false) }}
                className={`w-8 h-7 text-xs rounded-md transition-all duration-100 ${
                  value === i
                    ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/25'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                {String(i).padStart(2, '0')}
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ============================================
// Component
// ============================================

export function SchedulePicker({
  value,
  onChange,
  constraints,
  disabled = false,
  readOnlyReason,
}: SchedulePickerProps) {
  const { t } = useTranslation()
  const locale = getCurrentLanguage()

  // Determine initial mode from value
  const initialMode: PickerMode = value.type === 'cron' ? 'cron' : 'interval'
  const [mode, setMode] = useState<PickerMode>(initialMode)

  // For cron mode, try to parse into picker state
  const parsedPickerState = useMemo(() => {
    if (value.type !== 'cron') return null
    return parseCronToPickerState(value.cron)
  }, [value])

  // Whether the current cron is too complex for visual editing
  const isComplexCron = value.type === 'cron' && parsedPickerState === null

  // Local picker state for cron mode
  const [pickerState, setPickerState] = useState<CronPickerState>(() => {
    if (parsedPickerState) return parsedPickerState
    return { repeatType: 'daily', hour: 9, minute: 0 }
  })

  // Sync picker state when value changes externally (e.g., YAML edit then switch to visual)
  useEffect(() => {
    if (parsedPickerState) setPickerState(parsedPickerState)
  }, [parsedPickerState])

  // ── Filter presets by constraints ──
  const filteredPresets = useMemo(() => {
    if (!constraints) return FREQUENCY_PRESETS
    const minMs = constraints.min ? durationToMs(constraints.min) : 0
    const maxMs = constraints.max ? durationToMs(constraints.max) : Infinity
    return FREQUENCY_PRESETS.filter(p => {
      const ms = durationToMs(p.value)
      return ms >= minMs && ms <= maxMs
    })
  }, [constraints])

  // ── Handlers ──
  const handleModeSwitch = useCallback((newMode: PickerMode) => {
    if (disabled) return
    setMode(newMode)
    if (newMode === 'interval' && value.type === 'cron') {
      onChange({ type: 'every', every: '1h' })
    } else if (newMode === 'cron' && value.type === 'every') {
      const cron = buildCronFromPicker(pickerState)
      onChange({ type: 'cron', cron })
    }
  }, [disabled, value, pickerState, onChange])

  const handleIntervalSelect = useCallback((preset: string) => {
    if (disabled) return
    onChange({ type: 'every', every: preset })
  }, [disabled, onChange])

  const handlePickerChange = useCallback((newState: CronPickerState) => {
    setPickerState(newState)
    const cron = buildCronFromPicker(newState)
    onChange({ type: 'cron', cron })
  }, [onChange])

  // ── Cron preview text ──
  const previewText = useMemo(() => {
    if (value.type === 'cron') {
      return formatCronHumanReadable(value.cron, locale)
    }
    return null
  }, [value, locale])

  // ── Read-only mode (after all hooks to satisfy Rules of Hooks) ──
  if (readOnlyReason || (isComplexCron && !disabled)) {
    const desc = value.type === 'cron'
      ? formatCronHumanReadable(value.cron, locale)
      : ''
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-2 p-3 rounded-lg bg-secondary border border-border">
          <Info className="w-4 h-4 text-muted-foreground flex-shrink-0 mt-0.5" />
          <div className="space-y-1 min-w-0">
            {desc && (
              <p className="text-sm text-foreground">{desc}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {readOnlyReason || t('This cron expression cannot be edited visually. Edit in YAML tab for full control.')}
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Mode tabs */}
      <div className="flex items-center gap-0.5 bg-secondary rounded-lg p-0.5 w-fit">
        <button
          type="button"
          onClick={() => handleModeSwitch('interval')}
          disabled={disabled}
          className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
            mode === 'interval'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
        >
          {t('By interval')}
        </button>
        <button
          type="button"
          onClick={() => handleModeSwitch('cron')}
          disabled={disabled}
          className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
            mode === 'cron'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
        >
          {t('By time')}
        </button>
      </div>

      {/* Interval mode */}
      {mode === 'interval' && (
        <div className="flex flex-wrap gap-1.5">
          {filteredPresets.map(preset => (
            <button
              key={preset.value}
              type="button"
              onClick={() => handleIntervalSelect(preset.value)}
              disabled={disabled}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                value.type === 'every' && value.every === preset.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80'
              } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}

      {/* Cron mode */}
      {mode === 'cron' && (
        <CronEditor
          state={pickerState}
          onChange={handlePickerChange}
          disabled={disabled}
        />
      )}

      {/* Live preview */}
      {mode === 'cron' && previewText && (
        <p className="text-xs text-muted-foreground px-1">
          {previewText}
        </p>
      )}
    </div>
  )
}

// ============================================
// CronEditor — internal sub-component
// ============================================

function CronEditor({
  state,
  onChange,
  disabled,
}: {
  state: CronPickerState
  onChange: (state: CronPickerState) => void
  disabled: boolean
}) {
  const { t } = useTranslation()

  const handleRepeatTypeChange = useCallback((repeatType: CronPickerState['repeatType']) => {
    const next: CronPickerState = { ...state, repeatType }
    if (repeatType === 'weekly' && !next.weekDays?.length) {
      next.weekDays = [1]
    }
    if (repeatType === 'monthly' && !next.monthDays?.length) {
      next.monthDays = [1]
    }
    onChange(next)
  }, [state, onChange])

  const toggleWeekDay = useCallback((day: number) => {
    const current = new Set(state.weekDays ?? [])
    if (current.has(day)) {
      current.delete(day)
    } else {
      current.add(day)
    }
    if (current.size === 0) return
    onChange({ ...state, weekDays: [...current] })
  }, [state, onChange])

  const toggleWorkdays = useCallback(() => {
    const current = new Set(state.weekDays ?? [])
    const isWorkdays = [1, 2, 3, 4, 5].every(d => current.has(d)) && current.size === 5
    if (isWorkdays) {
      onChange({ ...state, weekDays: [0, 1, 2, 3, 4, 5, 6] })
    } else {
      onChange({ ...state, weekDays: [1, 2, 3, 4, 5] })
    }
  }, [state, onChange])

  const toggleMonthDay = useCallback((day: number) => {
    const current = new Set(state.monthDays ?? [])
    if (current.has(day)) {
      current.delete(day)
    } else {
      current.add(day)
    }
    if (current.size === 0) return
    onChange({ ...state, monthDays: [...current] })
  }, [state, onChange])

  const isWorkdaysSelected = useMemo(() => {
    const s = new Set(state.weekDays ?? [])
    return [1, 2, 3, 4, 5].every(d => s.has(d)) && s.size === 5
  }, [state.weekDays])

  return (
    <div className="space-y-3">
      {/* Repeat type */}
      <div className="space-y-1.5">
        <span className="text-xs text-muted-foreground">{t('Repeat')}</span>
        <div className="flex flex-wrap gap-1.5">
          {([
            { value: 'daily' as const, label: t('Every day') },
            { value: 'weekly' as const, label: t('By week') },
            { value: 'monthly' as const, label: t('By month') },
          ]).map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleRepeatTypeChange(opt.value)}
              disabled={disabled}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                state.repeatType === opt.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Weekly: weekday selection */}
      {state.repeatType === 'weekly' && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{t('Days')}</span>
            <button
              type="button"
              onClick={toggleWorkdays}
              disabled={disabled}
              className={`text-xs px-2 py-0.5 rounded transition-colors ${
                isWorkdaysSelected
                  ? 'text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('Weekdays')}
            </button>
          </div>
          <div className="flex flex-wrap gap-1 w-fit">
            {WEEKDAY_KEYS.map(day => (
              <button
                key={day}
                type="button"
                onClick={() => toggleWeekDay(day)}
                disabled={disabled}
                className={`w-9 h-8 text-xs rounded-lg transition-all duration-150 ${
                  (state.weekDays ?? []).includes(day)
                    ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/25'
                    : 'border border-border-faint text-muted-foreground hover:border-primary/50 hover:text-foreground'
                }`}
              >
                {t(WEEKDAY_LABELS[day])}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Monthly: day-of-month grid */}
      {state.repeatType === 'monthly' && (
        <div className="space-y-1.5">
          <span className="text-xs text-muted-foreground">{t('Days of month')}</span>
          <div className="grid grid-cols-7 gap-1 w-fit">
            {Array.from({ length: 31 }, (_, i) => i + 1).map(day => (
              <button
                key={day}
                type="button"
                onClick={() => toggleMonthDay(day)}
                disabled={disabled}
                className={`w-8 h-8 text-xs rounded-lg transition-all duration-150 ${
                  (state.monthDays ?? []).includes(day)
                    ? 'bg-primary text-primary-foreground shadow-sm shadow-primary/25'
                    : 'border border-border-faint text-muted-foreground hover:border-primary/50 hover:text-foreground'
                }`}
              >
                {day}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Single time picker */}
      <div className="space-y-1.5">
        <span className="text-xs text-muted-foreground">{t('Time')}</span>
        <div className="flex items-center gap-1">
          <HourPicker
            value={state.hour}
            onChange={h => onChange({ ...state, hour: h })}
            disabled={disabled}
          />
          <span className="text-sm text-muted-foreground font-medium select-none">:</span>
          <MinutePicker
            value={state.minute}
            onChange={m => onChange({ ...state, minute: m })}
            disabled={disabled}
          />
        </div>
      </div>
    </div>
  )
}

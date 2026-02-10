/**
 * AskUserQuestionCard - Renders structured questions from AI for user input
 *
 * Supports:
 * - Single/multiple questions (1-4)
 * - Single select (radio) and multi-select (checkbox) modes
 * - "Other" option with custom text input
 * - Always shows submit button for visual consistency
 * - Hidden after answered, only visible in active and cancelled states
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { Check, MessageSquareMore, X } from 'lucide-react'
import type { PendingQuestion } from '../../types'

// Tailwind can't detect dynamic class names (e.g. `rounded-${x}`), so we use a helper
const indicatorShape = (isMulti: boolean) => isMulti ? 'rounded-sm' : 'rounded-full'

interface AskUserQuestionCardProps {
  pendingQuestion: PendingQuestion
  onAnswer: (answers: Record<string, string>) => void
}

export function AskUserQuestionCard({ pendingQuestion, onAnswer }: AskUserQuestionCardProps) {
  const { questions, status } = pendingQuestion

  // Per-question selections (before submit)
  const [selections, setSelections] = useState<Record<string, string | string[]>>({})
  // "Other" expanded state per question
  const [otherExpanded, setOtherExpanded] = useState<Record<string, boolean>>({})
  // "Other" text per question
  const [otherTexts, setOtherTexts] = useState<Record<string, string>>({})
  // Ref for auto-focus on "other" input
  const otherInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

  // Check if all questions have been answered
  const allAnswered = questions.every((_, idx) => {
    const key = String(idx)
    const sel = selections[key]
    if (otherExpanded[key]) {
      return (otherTexts[key] || '').trim().length > 0
    }
    if (Array.isArray(sel)) {
      return sel.length > 0
    }
    return !!sel
  })

  // Build final answers record
  const buildAnswers = useCallback((): Record<string, string> => {
    const result: Record<string, string> = {}
    questions.forEach((_, idx) => {
      const key = String(idx)
      if (otherExpanded[key]) {
        result[key] = otherTexts[key]?.trim() || ''
      } else {
        const sel = selections[key]
        if (Array.isArray(sel)) {
          result[key] = sel.join(', ')
        } else {
          result[key] = sel as string || ''
        }
      }
    })
    return result
  }, [questions, selections, otherExpanded, otherTexts])

  // Handle option click for single-select
  const handleSingleSelect = useCallback((questionIdx: number, label: string) => {
    if (status !== 'active') return
    const key = String(questionIdx)
    setOtherExpanded(prev => ({ ...prev, [key]: false }))
    setSelections(prev => ({ ...prev, [key]: label }))
  }, [status])

  // Handle option click for multi-select
  const handleMultiSelect = useCallback((questionIdx: number, label: string) => {
    if (status !== 'active') return
    const key = String(questionIdx)
    setSelections(prev => {
      const current = (prev[key] as string[]) || []
      const next = current.includes(label)
        ? current.filter(l => l !== label)
        : [...current, label]
      return { ...prev, [key]: next }
    })
    // Clear "other" if selecting a normal option
    setOtherExpanded(prev => ({ ...prev, [key]: false }))
  }, [status])

  // Handle "Other" click
  const handleOtherClick = useCallback((questionIdx: number) => {
    if (status !== 'active') return
    const key = String(questionIdx)
    setOtherExpanded(prev => ({ ...prev, [key]: true }))
    setSelections(prev => ({ ...prev, [key]: '' }))
    // Focus input after render
    setTimeout(() => {
      otherInputRefs.current[key]?.focus()
    }, 0)
  }, [status])

  // Handle submit
  const handleSubmit = useCallback(() => {
    if (!allAnswered || status !== 'active') return
    onAnswer(buildAnswers())
  }, [allAnswered, status, onAnswer, buildAnswers])

  // Handle Enter key on "Other" input
  const handleOtherKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (allAnswered) {
        handleSubmit()
      }
    }
  }, [allAnswered, handleSubmit])

  // Auto-scroll into view when card mounts
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (status === 'active') {
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [status])

  // Don't render after answered
  if (status === 'answered') return null

  const isCancelled = status === 'cancelled'

  return (
    <div
      ref={cardRef}
      className={`
        ask-question-card mt-3 rounded-xl border overflow-hidden
        transition-all duration-300
        ${isCancelled ? 'border-border/50 bg-card/30 opacity-50' : 'border-primary/40 bg-gradient-to-br from-primary/5 via-background to-primary/3 animate-fade-in'}
      `}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/30">
        <MessageSquareMore
          size={16}
          className={isCancelled ? 'text-muted-foreground' : 'text-primary'}
        />
        <span className="text-xs font-medium text-muted-foreground">
          {isCancelled ? 'Cancelled' : 'Waiting for your response'}
        </span>
        {isCancelled && (
          <X size={14} className="text-muted-foreground/50 ml-auto" />
        )}
      </div>

      {/* Questions */}
      <div className="px-4 py-3 space-y-4">
        {questions.map((q, qIdx) => {
          const key = String(qIdx)
          const isMulti = q.multiSelect
          const selectedValue = selections[key]
          const isOtherActive = otherExpanded[key]

          return (
            <div key={qIdx} className="space-y-2">
              {/* Header chip + question text */}
              <div className="space-y-1.5">
                <span className="inline-block px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider rounded-md bg-primary/15 text-primary/80">
                  {q.header}
                </span>
                <p className="text-sm font-medium text-foreground">{q.question}</p>
              </div>

              {/* Options */}
              <div className="space-y-1.5">
                {q.options.map((opt, optIdx) => {
                  const isSelected = isMulti
                    ? (selectedValue as string[] || []).includes(opt.label)
                    : selectedValue === opt.label && !isOtherActive

                  return (
                    <button
                      key={optIdx}
                      disabled={isCancelled}
                      onClick={() => isMulti ? handleMultiSelect(qIdx, opt.label) : handleSingleSelect(qIdx, opt.label)}
                      className={`
                        w-full text-left px-3 py-2 rounded-lg border transition-all duration-150
                        ${isSelected
                          ? 'border-primary/50 bg-primary/10 text-foreground'
                          : isCancelled
                            ? 'border-border/30 bg-transparent text-muted-foreground/50 cursor-default'
                            : 'border-border/40 bg-transparent text-foreground/80 hover:border-primary/30 hover:bg-primary/5 cursor-pointer'
                        }
                      `}
                    >
                      <div className="flex items-start gap-2.5">
                        {/* Radio/Checkbox indicator */}
                        <div className={`
                          mt-0.5 flex-shrink-0 w-4 h-4 ${indicatorShape(isMulti)}
                          border transition-all duration-150 flex items-center justify-center
                          ${isSelected
                            ? 'border-primary bg-primary'
                            : 'border-muted-foreground/30'
                          }
                        `}>
                          {isSelected && <Check size={10} className="text-primary-foreground" strokeWidth={3} />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">{opt.label}</div>
                          {opt.description && (
                            <div className="text-xs text-muted-foreground mt-0.5">{opt.description}</div>
                          )}
                        </div>
                      </div>
                    </button>
                  )
                })}

                {/* "Other" option - only in active state */}
                {!isCancelled && (
                  <div>
                    <button
                      onClick={() => handleOtherClick(qIdx)}
                      className={`
                        w-full text-left px-3 py-2 rounded-lg border transition-all duration-150
                        ${isOtherActive
                          ? 'border-primary/50 bg-primary/10 text-foreground'
                          : 'border-border/40 bg-transparent text-foreground/80 hover:border-primary/30 hover:bg-primary/5 cursor-pointer'
                        }
                      `}
                    >
                      <div className="flex items-start gap-2.5">
                        <div className={`
                          mt-0.5 flex-shrink-0 w-4 h-4 ${indicatorShape(isMulti)}
                          border transition-all duration-150 flex items-center justify-center
                          ${isOtherActive
                            ? 'border-primary bg-primary'
                            : 'border-muted-foreground/30'
                          }
                        `}>
                          {isOtherActive && <Check size={10} className="text-primary-foreground" strokeWidth={3} />}
                        </div>
                        <span className="text-sm text-muted-foreground">Other...</span>
                      </div>
                    </button>
                    {isOtherActive && (
                      <div className="mt-1.5 ml-[26px]">
                        <input
                          ref={el => { otherInputRefs.current[key] = el }}
                          type="text"
                          value={otherTexts[key] || ''}
                          onChange={e => setOtherTexts(prev => ({ ...prev, [key]: e.target.value }))}
                          onKeyDown={handleOtherKeyDown}
                          placeholder="Type your answer..."
                          className="w-full px-3 py-1.5 text-sm bg-background border border-border/50 rounded-md
                            focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20
                            placeholder:text-muted-foreground/40 transition-all duration-150"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Submit button */}
      {!isCancelled && (
        <div className="px-4 py-3 border-t border-border/30 flex justify-end">
          <button
            disabled={!allAnswered}
            onClick={handleSubmit}
            className={`
              flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium
              transition-all duration-200
              ${allAnswered
                ? 'bg-primary text-primary-foreground hover:bg-primary/90 active:scale-[0.98]'
                : 'bg-muted/30 text-muted-foreground cursor-not-allowed'
              }
            `}
          >
            <Check size={14} />
            Submit
          </button>
        </div>
      )}
    </div>
  )
}

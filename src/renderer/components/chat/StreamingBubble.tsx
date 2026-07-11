/**
 * StreamingBubble - Displays streaming content with scroll-up animation
 *
 * Extracted from MessageList.tsx for reuse across chat surfaces
 * (main conversation chat, App/digital-human chat, etc.)
 *
 * Problem: `content` (streamingContent) is cumulative - it appends all text from
 * the start of generation. When tool_use happens mid-stream, we need to:
 * 1. "Snapshot" the current content
 * 2. Scroll the snapshot up (out of view)
 * 3. Display only the NEW content after the tool call
 *
 * Solution: Snapshot-based content segmentation
 * - segments[]: Array of snapshots (independent, not cumulative)
 * - displayContent: content.slice(lastSnapshot.length) - extracts only new part
 * - CSS translateY: Scrolls history out of the viewport
 *
 * Timing is critical: We wait for new content to arrive BEFORE scrolling,
 * otherwise user sees empty space during the tool call.
 *
 * @see docs/streaming-scroll-animation.md for detailed implementation notes
 */

import { useState, useEffect, useRef } from 'react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { useTranslation } from '../../i18n'
import type { Thought } from '../../types'

interface StreamingBubbleProps {
  content: string
  isStreaming: boolean
  thoughts: Thought[]
  textBlockVersion?: number
}

export function StreamingBubble({
  content,
  isStreaming,
  thoughts,
  textBlockVersion = 0
}: StreamingBubbleProps) {
  // DOM refs for measuring heights
  const historyRef = useRef<HTMLDivElement>(null)  // Contains all past segments
  const currentRef = useRef<HTMLDivElement>(null)  // Contains current (new) content
  const { t } = useTranslation()

  // State for scroll animation
  const [segments, setSegments] = useState<string[]>([])     // Saved content snapshots
  const [scrollOffset, setScrollOffset] = useState(0)        // translateY offset in px
  const [currentHeight, setCurrentHeight] = useState(0)      // Viewport height = current content height
  const [activeSnapshotLen, setActiveSnapshotLen] = useState(0)  // Length to slice from (state for sync rendering)

  // Refs for tracking (don't trigger re-renders)
  const prevThoughtsLenRef = useRef(0)           // Previous thoughts array length
  const pendingSnapshotRef = useRef<string | null>(null)  // Content waiting to be saved
  const prevTextBlockVersionRef = useRef(textBlockVersion)  // Track version changes

  // GPU perf: only enable CSS transitions during segment changes (tool_use scroll animation).
  // During normal streaming, height changes every ~100ms — transition-[height] would cause
  // continuous overlapping CSS transitions, each triggering per-frame layout recalc.
  const [isSegmentAnimating, setIsSegmentAnimating] = useState(false)
  const segmentAnimTimerRef = useRef<ReturnType<typeof setTimeout>>()

  /**
   * Step 0: Reset on new text block (100% reliable signal from SDK)
   * When textBlockVersion changes, it means a new content_block_start (type='text') arrived.
   * This is the precise signal to reset activeSnapshotLen.
   */
  useEffect(() => {
    if (textBlockVersion !== prevTextBlockVersionRef.current) {
      // Advance first so the effect can't re-run for the same version.
      prevTextBlockVersionRef.current = textBlockVersion
      // Skip if already clean: state setters are in the dep array, so an
      // unconditional reset here would loop.
      if (activeSnapshotLen === 0 && segments.length === 0 && scrollOffset === 0) return
      console.log(`[StreamingBubble] 🆕 New text block detected: version → ${textBlockVersion}`)
      // Reset all state for new text block
      setActiveSnapshotLen(0)
      setSegments([])
      setScrollOffset(0)
      setIsSegmentAnimating(false)
      clearTimeout(segmentAnimTimerRef.current)
      pendingSnapshotRef.current = null
    }
  }, [textBlockVersion, activeSnapshotLen, segments.length, scrollOffset])

  /**
   * Step 1: Detect tool_use and mark content as pending
   * When a new tool_use thought appears, we mark the current content
   * as "pending" - it will be saved when new content arrives.
   */
  useEffect(() => {
    const prevLen = prevThoughtsLenRef.current
    const currLen = thoughts.length

    if (currLen > prevLen) {
      const newThought = thoughts[currLen - 1]
      // On tool_use, mark current content as pending (will be saved when new content arrives)
      if (newThought?.type === 'tool_use' && content && content.length > activeSnapshotLen) {
        pendingSnapshotRef.current = content
      }
    }
    prevThoughtsLenRef.current = currLen
  }, [thoughts, content, activeSnapshotLen])

  /**
   * Step 2: Save snapshot when new content arrives
   * We wait until new content appears (content grows beyond pending)
   * before saving the snapshot. This ensures smooth transition.
   *
   * Key: Update segments first, then update activeSnapshotLen in next effect.
   * This ensures the history DOM renders BEFORE we slice the display content.
   */
  useEffect(() => {
    const pending = pendingSnapshotRef.current
    if (pending && content && content.length > pending.length) {
      // New content has arrived, now save the snapshot
      setSegments(prev => [...prev, pending])
      pendingSnapshotRef.current = null
    }
  }, [content])

  /**
   * Step 2b: Update slice position AFTER segments are in DOM
   * This runs after segments update, ensuring history is visible before we slice
   */
  useEffect(() => {
    if (segments.length > 0) {
      // Calculate total length of all segments
      const totalLen = segments.reduce((sum, seg) => sum + seg.length, 0)
      if (totalLen !== activeSnapshotLen) {
        setActiveSnapshotLen(totalLen)
      }
    }
  }, [segments, activeSnapshotLen])

  /**
   * Step 3: Reset state on new conversation
   * Note: New text block reset is now handled by Step 0 (textBlockVersion change)
   */
  useEffect(() => {
    if (!content && thoughts.length === 0) {
      // Full reset for new conversation
      console.log(`[StreamingBubble] 🔄 Full reset (new conversation)`)
      setSegments([])
      setScrollOffset(0)
      setCurrentHeight(0)
      setActiveSnapshotLen(0)
      setIsSegmentAnimating(false)
      clearTimeout(segmentAnimTimerRef.current)
      prevThoughtsLenRef.current = 0
      prevTextBlockVersionRef.current = 0
    }
  }, [content, thoughts.length])

  /**
   * Step 4: Measure current content height (throttled)
   * Only update height every 100ms to avoid excessive measurements during streaming.
   * Viewport height = current content height only (not history)
   */
  const heightMeasureRef = useRef<number>(0)
  useEffect(() => {
    if (currentRef.current) {
      // Throttle: only measure every 100ms
      const now = Date.now()
      if (now - heightMeasureRef.current < 100) return
      heightMeasureRef.current = now

      requestAnimationFrame(() => {
        if (currentRef.current) {
          setCurrentHeight(currentRef.current.scrollHeight)
        }
      })
    }
  }, [content, segments.length])

  /**
   * Step 5: Calculate scroll offset when segments change
   * scrollOffset = total height of history segments
   * This value is used for translateY(-scrollOffset)
   *
   * Also enables CSS transitions for the duration of the scroll animation,
   * then disables them to avoid continuous layout thrashing during streaming.
   */
  useEffect(() => {
    if (segments.length > 0 && historyRef.current) {
      // Enable transitions for segment scroll animation
      setIsSegmentAnimating(true)
      clearTimeout(segmentAnimTimerRef.current)
      segmentAnimTimerRef.current = setTimeout(() => setIsSegmentAnimating(false), 350)

      // Wait for DOM to update
      requestAnimationFrame(() => {
        if (historyRef.current) {
          setScrollOffset(historyRef.current.scrollHeight)
        }
      })
    }
  }, [segments])

  if (!content) return null

  // Calculate what to show in current content area
  // activeSnapshotLen is updated AFTER segments render, ensuring no content loss
  const displayContent = activeSnapshotLen > 0 && content.length >= activeSnapshotLen
    ? content.slice(activeSnapshotLen)
    : content

  const containerHeight = currentHeight > 0 ? currentHeight : 'auto'

  return (
    <div className="rounded-2xl px-4 py-3 message-assistant message-working w-full overflow-hidden">
      {/* Working indicator */}
      <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-border/30 working-indicator-fade">
        <span className="text-xs text-muted-foreground/70">{t('Halo is working')}</span>
      </div>

      {/* Viewport - height matches current content only
           CSS transitions only enabled during segment scroll animation (GPU perf).
           During normal streaming, height changes are instant to avoid layout thrashing. */}
      <div
        className={`overflow-hidden ${isSegmentAnimating ? 'transition-[height] duration-300' : ''}`}
        style={{ height: containerHeight }}
      >
        {/* Scrollable container */}
        <div
          className={isSegmentAnimating ? 'transition-transform duration-300' : ''}
          style={{ transform: `translateY(-${scrollOffset}px)` }}
        >
          {/* History segments - will be scrolled out of view */}
          <div ref={historyRef}>
            {segments.map((seg, i) => (
              <div key={i} className="pb-4 break-words leading-relaxed">
                <MarkdownRenderer content={seg} mode="streaming" />
              </div>
            ))}
          </div>

          {/* Current content - always visible, shows only NEW part after snapshots */}
          <div ref={currentRef} className="break-words leading-relaxed">
            <MarkdownRenderer content={displayContent} mode="streaming" />
            {isStreaming && (
              <span className="inline-block w-0.5 h-5 ml-0.5 bg-primary streaming-cursor align-middle" />
            )}
            {!isStreaming && (
              <span className="waiting-dots ml-1 text-muted-foreground/60" />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

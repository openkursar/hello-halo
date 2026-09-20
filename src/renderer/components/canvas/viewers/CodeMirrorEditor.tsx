/**
 * CodeMirror Editor Component
 *
 * A React wrapper for CodeMirror 6 with:
 * - Virtual scrolling for large files
 * - Read-only mode by default
 * - Optional edit mode with undo/redo
 * - Theme integration with Halo (auto light/dark)
 * - Scroll position preservation
 *
 * Performance optimizations:
 * - Uses refs to avoid recreating extensions on callback changes
 * - Memoized with React.memo to prevent unnecessary re-renders
 * - Stable extensions array to avoid reinitializing CodeMirror
 *
 * This is the core component - CodeViewer wraps this with UI chrome.
 */

import {
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
  useCallback,
  useMemo,
  memo,
} from 'react'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import {
  createEditorState,
  setReadOnly,
  setLanguage,
  getContent,
  setContent,
  hasChanges,
} from '../../../lib/codemirror-setup'

// ============================================
// Types
// ============================================

export interface CodeMirrorEditorProps {
  /** Document content */
  content: string
  /** Programming language for syntax highlighting */
  language?: string
  /** Read-only mode (default: true) */
  readOnly?: boolean
  /** Called when content changes (only in edit mode) */
  onChange?: (content: string) => void
  /** Called when scroll position changes */
  onScroll?: (position: number) => void
  /** Initial scroll position to restore */
  scrollPosition?: number
  /** CSS class name for the container */
  className?: string
  /** Tints the editor background to signal it's writable (prototype:
   * `.canvas.editing .cc-code`) */
  isEditing?: boolean
}

export interface CodeMirrorEditorRef {
  /** Get the current document content */
  getContent: () => string
  /** Set the document content */
  setContent: (content: string) => void
  /** Check if content has been modified */
  hasChanges: () => boolean
  /** Set read-only mode */
  setReadOnly: (readOnly: boolean) => void
  /** Focus the editor */
  focus: () => void
  /** Get the scroll position */
  getScrollPosition: () => number
  /** Set the scroll position */
  setScrollPosition: (position: number) => void
  /** Get the EditorView instance */
  getView: () => EditorView | null
}

// ============================================
// Component
// ============================================

export const CodeMirrorEditor = memo(
  forwardRef<CodeMirrorEditorRef, CodeMirrorEditorProps>(function CodeMirrorEditor(
    {
      content,
      language,
      readOnly = true,
      onChange,
      onScroll,
      scrollPosition,
      className = '',
      isEditing = false,
    },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const originalContentRef = useRef<string>(content)
    const lastScrollPositionRef = useRef<number>(0)

    // Keep refs up to date with latest callbacks
    const onChangeRef = useRef(onChange)
    const onScrollRef = useRef(onScroll)

    useEffect(() => {
      onChangeRef.current = onChange
    }, [onChange])

    useEffect(() => {
      onScrollRef.current = onScroll
    }, [onScroll])

    // Build extensions array - stable across re-renders using refs
    const extensions = useMemo(
      () => [
        // Update listener for content changes
        EditorView.updateListener.of((update) => {
          if (update.docChanged && onChangeRef.current) {
            onChangeRef.current(update.state.doc.toString())
          }
        }),

        // Scroll listener
        EditorView.domEventHandlers({
          scroll: (event, view) => {
            const scrollTop = view.scrollDOM.scrollTop
            lastScrollPositionRef.current = scrollTop
            if (onScrollRef.current) {
              onScrollRef.current(scrollTop)
            }
            return false
          },
        }),
      ],
      [] // Stable - uses refs for callbacks
    )

    // Initialize editor once on mount
    useEffect(() => {
      if (!containerRef.current) return

      // Create initial state
      const state = createEditorState({
        doc: content,
        language,
        readOnly,
        extensions,
      })

      // Create view
      const view = new EditorView({
        state,
        parent: containerRef.current,
      })

      viewRef.current = view
      originalContentRef.current = content

      // Restore scroll position if provided
      if (scrollPosition !== undefined && scrollPosition > 0) {
        // Use requestAnimationFrame to ensure DOM is ready
        requestAnimationFrame(() => {
          view.scrollDOM.scrollTop = scrollPosition
        })
      }

      return () => {
        view.destroy()
        viewRef.current = null
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []) // Intentionally empty - initialize once, update via separate effects

    // Update content when prop changes
    useEffect(() => {
      const view = viewRef.current
      if (!view) return

      const currentContent = view.state.doc.toString()
      if (currentContent !== content) {
        setContent(view, content)
        originalContentRef.current = content
      }
    }, [content])

    // Update language when prop changes
    useEffect(() => {
      const view = viewRef.current
      if (!view) return

      setLanguage(view, language)
    }, [language])

    // Update read-only mode when prop changes
    useEffect(() => {
      const view = viewRef.current
      if (!view) return

      setReadOnly(view, readOnly)

      // If switching to read-only, update original content reference
      if (readOnly) {
        originalContentRef.current = view.state.doc.toString()
      }
    }, [readOnly])

    // Expose methods via ref
    useImperativeHandle(
      ref,
      () => ({
        getContent: () => {
          const view = viewRef.current
          return view ? getContent(view) : content
        },

        setContent: (newContent: string) => {
          const view = viewRef.current
          if (view) {
            setContent(view, newContent)
          }
        },

        hasChanges: () => {
          const view = viewRef.current
          return view ? hasChanges(view, originalContentRef.current) : false
        },

        setReadOnly: (isReadOnly: boolean) => {
          const view = viewRef.current
          if (view) {
            setReadOnly(view, isReadOnly)
            if (isReadOnly) {
              originalContentRef.current = view.state.doc.toString()
            }
          }
        },

        focus: () => {
          const view = viewRef.current
          if (view) {
            view.focus()
          }
        },

        getScrollPosition: () => {
          const view = viewRef.current
          return view ? view.scrollDOM.scrollTop : lastScrollPositionRef.current
        },

        setScrollPosition: (position: number) => {
          const view = viewRef.current
          if (view) {
            view.scrollDOM.scrollTop = position
          }
        },

        getView: () => viewRef.current,
      }),
      [content]
    )

    return (
      <div
        ref={containerRef}
        className={`codemirror-container h-full w-full overflow-hidden ${isEditing ? 'is-editing' : ''} ${className}`}
      />
    )
  })
)

CodeMirrorEditor.displayName = 'CodeMirrorEditor'

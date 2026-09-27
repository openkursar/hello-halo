/**
 * GoalEditor — the canvas tab for editing a conversation's goal.
 *
 * A structured form rather than a document: the engine keeps no per-criterion
 * state, so a markdown checklist would promise ticks that never come, and free
 * text would not round-trip. Saving replaces the goal without starting a turn.
 *
 * The form lives in the tab (as JSON in `content`, with `isDirty`), not in this
 * component: the canvas mounts only the visible tab, and edits must survive
 * switching away. `base` is the goal the fields were last reconciled with, so a
 * change that lands meanwhile is noticed even while the editor was not mounted.
 */

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { AlertTriangle, Check, GripVertical, Info, Loader2, Plus, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { canvasLifecycle, type TabState } from '../../services/canvas-lifecycle'
import { useChatStore } from '../../stores/chat.store'
import { useConversationGoal, useGoalStore, useGoalSupported, type Goal } from '../../stores/goal.store'
import { GoalStatusIcon, goalStatusLabel } from './GoalStatus'
import { saveGoal } from './goal-actions'
import { useClearGoal } from './useClearGoal'
import { useConversationRunning, useTimeAgo } from './hooks'

interface Row {
  id: number
  text: string
}

interface EditorState {
  objective: string
  rows: Row[]
  base: Goal | null
}

interface StoredEditorState {
  objective: string
  doneWhen: string[]
  base: Goal | null
}

let rowSeq = 0
const newRow = (text = ''): Row => ({ id: ++rowSeq, text })

/** Rows keep their ids by position so inputs are not remounted and focus stays where it was. */
function fromGoal(goal: Goal | null, rows: Row[] = []): EditorState {
  return {
    objective: goal?.objective ?? '',
    rows: (goal?.doneWhen ?? []).map((c, i) => (rows[i] ? { id: rows[i].id, text: c } : newRow(c))),
    base: goal,
  }
}

function restore(content: string | undefined): EditorState | null {
  if (!content) return null
  try {
    const stored = JSON.parse(content) as StoredEditorState
    return { objective: stored.objective, rows: stored.doneWhen.map((c) => newRow(c)), base: stored.base }
  } catch {
    console.warn('[GoalEditor] Unreadable editor state in tab; starting from the current goal')
    return null
  }
}

function serialize(state: EditorState): string {
  const stored: StoredEditorState = { objective: state.objective, doneWhen: state.rows.map((r) => r.text), base: state.base }
  return JSON.stringify(stored)
}

function fieldsOf(state: EditorState): { objective: string; doneWhen: string[] } {
  return {
    objective: state.objective.trim(),
    doneWhen: state.rows.map((r) => r.text.trim()).filter(Boolean),
  }
}

function sameFields(a: { objective: string; doneWhen: string[] }, goal: Goal | null): boolean {
  const b = goal ?? { objective: '', doneWhen: [] }
  return a.objective === b.objective.trim() &&
    a.doneWhen.length === b.doneWhen.length &&
    a.doneWhen.every((c, i) => c === b.doneWhen[i])
}

/** Same goal as far as the user can tell: text, criteria and status. */
function sameContent(a: Goal | null, b: Goal | null): boolean {
  if (!a || !b) return a === b
  return a.status === b.status && sameFields({ objective: a.objective.trim(), doneWhen: a.doneWhen }, b)
}

const isDirty = (state: EditorState) => !sameFields(fieldsOf(state), state.base)

const BUTTON = 'h-9 sm:h-8 px-3 rounded-md text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50'
const SECONDARY_BUTTON = `${BUTTON} border border-border bg-secondary text-foreground hover:bg-surface-hover`
const PRIMARY_BUTTON = `${BUTTON} bg-primary text-primary-foreground hover:bg-primary-hover disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed`

export function GoalEditor({ tab }: { tab: TabState }) {
  const target = tab.goal
  const supported = useGoalSupported()
  if (!target || !supported) return <GoalUnavailable tabId={tab.id} />
  return <GoalEditorForm tab={tab} spaceId={target.spaceId} conversationId={target.conversationId} />
}

function GoalUnavailable({ tabId }: { tabId: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{t('This goal is no longer available.')}</p>
      <button
        type="button"
        className={SECONDARY_BUTTON}
        onClick={() => {
          canvasLifecycle.markTabSaved(tabId)
          void canvasLifecycle.closeTab(tabId)
        }}
      >
        {t('Close')}
      </button>
    </div>
  )
}

function GoalEditorForm({ tab, spaceId, conversationId }: { tab: TabState; spaceId: string; conversationId: string }) {
  const { t } = useTranslation()
  const goal = useConversationGoal(conversationId)
  const running = useConversationRunning(conversationId)
  const conversation = useChatStore((s) => s.spaceStates.get(spaceId)?.conversations.find((c) => c.id === conversationId))
  const seenConversationRef = useRef(false)
  if (conversation) seenConversationRef.current = true
  const deleted = seenConversationRef.current && !conversation

  const [state, setState] = useState<EditorState | null>(() => restore(tab.content) ?? (goal !== undefined ? fromGoal(goal) : null))
  const [saving, setSaving] = useState(false)
  const [attemptedSave, setAttemptedSave] = useState(false)
  const [savedFlash, setSavedFlash] = useState(0)
  const [refreshFlash, setRefreshFlash] = useState(0)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ id: number | 'objective'; at: 'start' | 'end' } | null>(null)
  /** The base the other version was opened against; a resolved conflict hides it. */
  const [previewBase, setPreviewBase] = useState<Goal | null | undefined>(undefined)

  const objectiveRef = useRef<HTMLTextAreaElement>(null)
  const rowRefs = useRef(new Map<number, HTMLInputElement>())
  const { requestClear, confirmDialog } = useClearGoal(spaceId, conversationId, running)
  const timeAgo = useTimeAgo(goal?.updatedAt)

  useEffect(() => {
    if (goal === undefined) void useGoalStore.getState().load(spaceId, conversationId)
  }, [goal, spaceId, conversationId])

  // Reconcile with the goal main reports: follow it while the fields are
  // clean, and leave a dirty form alone so the banner can ask.
  const stateRef = useRef(state)
  stateRef.current = state
  useEffect(() => {
    if (goal === undefined) return
    const current = stateRef.current
    if (!current) {
      setState(fromGoal(goal))
    } else if (sameContent(goal, current.base)) {
      if (current.base !== goal) setState({ ...current, base: goal })
    } else if (!isDirty(current)) {
      setState(fromGoal(goal, current.rows))
      setRefreshFlash((n) => n + 1)
    } else if (goal?.status === 'active' && sameFields(fieldsOf(current), goal)) {
      // The change is the one these fields already hold, e.g. this editor's own save.
      setState({ ...current, base: goal })
    }
  }, [goal])

  // The canvas Refresh re-reads the goal from main; a dirty form then reconciles as for any other change.
  useEffect(() => canvasLifecycle.setRefreshHandler('goal', async (refreshed) => {
    if (refreshed.id !== tab.id) return
    await useGoalStore.getState().load(spaceId, conversationId)
    if (stateRef.current && !isDirty(stateRef.current)) setRefreshFlash((n) => n + 1)
  }), [tab.id, spaceId, conversationId])

  // Mirror the form into the tab so it outlives this component and drives the dirty dot.
  useEffect(() => {
    if (!state) return
    const content = serialize(state)
    const dirty = isDirty(state)
    if (content === tab.content && dirty === tab.isDirty) return
    if (dirty) canvasLifecycle.updateTabContent(tab.id, content)
    else canvasLifecycle.markTabSaved(tab.id, content)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  useEffect(() => {
    if (!focusRequest) return
    const el = focusRequest.id === 'objective' ? objectiveRef.current : rowRefs.current.get(focusRequest.id)
    if (el) {
      el.focus()
      const pos = focusRequest.at === 'start' ? 0 : el.value.length
      el.setSelectionRange(pos, pos)
    }
    setFocusRequest(null)
  }, [focusRequest])

  useEffect(() => {
    const el = objectiveRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [state?.objective])

  useEffect(() => {
    if (!savedFlash) return
    const id = setTimeout(() => setSavedFlash(0), 2000)
    return () => clearTimeout(id)
  }, [savedFlash])

  if (deleted) return <GoalUnavailable tabId={tab.id} />
  if (!state) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="animate-spin text-muted-foreground" aria-label={t('Loading...')} />
      </div>
    )
  }

  const latest = goal ?? null
  const dirty = isDirty(state)
  const fields = fieldsOf(state)
  const conflict = dirty && goal !== undefined && !sameContent(latest, state.base)
  const finished = !!latest && latest.status !== 'active'
  const showingLatest = conflict && previewBase === state.base
  const objectiveMissing = !fields.objective
  const canSave = !saving && !objectiveMissing && (dirty || finished)

  const update = (patch: Partial<EditorState>) => setState((s) => (s ? { ...s, ...patch } : s))
  const setRows = (rows: Row[]) => update({ rows })

  const closeTab = () => {
    canvasLifecycle.markTabSaved(tab.id)
    void canvasLifecycle.closeTab(tab.id)
  }

  const save = async () => {
    setAttemptedSave(true)
    if (objectiveMissing) {
      setFocusRequest({ id: 'objective', at: 'end' })
      return
    }
    if (!canSave) return
    setSaving(true)
    const ok = await saveGoal(spaceId, conversationId, fields)
    setSaving(false)
    if (!ok) return
    setAttemptedSave(false)
    // Tidy what was saved (trimmed, blank rows gone) in place; edits typed while saving stay.
    const saved = useGoalStore.getState().byConversation.get(conversationId) ?? null
    setState((s) => {
      if (!s || !sameFields(fieldsOf(s), saved)) return s
      const kept = s.rows.filter((r) => r.text.trim())
      return fromGoal(saved, kept)
    })
    setSavedFlash((n) => n + 1)
  }

  const cancel = () => {
    if (dirty) setState(fromGoal(latest, state.rows))
    else closeTab()
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    // Keys from a dialog portal bubble here through React but are not ours.
    if (!e.currentTarget.contains(e.target as Node)) return
    if (e.nativeEvent.isComposing) return
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      e.stopPropagation()
      void save()
      return
    }
    // Esc closes; with unsaved edits the canvas close guard asks first.
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      e.stopPropagation()
      void canvasLifecycle.closeTab(tab.id)
    }
  }

  const insertRowAfter = (index: number) => {
    const row = newRow()
    const rows = [...state.rows]
    rows.splice(index + 1, 0, row)
    setRows(rows)
    setFocusRequest({ id: row.id, at: 'end' })
  }

  const removeRow = (index: number, focus: 'previous' | 'none') => {
    const rows = state.rows.filter((_, i) => i !== index)
    setRows(rows)
    if (focus === 'previous') {
      const previous = rows[index - 1]
      setFocusRequest(previous ? { id: previous.id, at: 'end' } : { id: 'objective', at: 'end' })
    }
  }

  const moveRow = (from: number, to: number) => {
    if (to < 0 || to >= state.rows.length || from === to) return
    const rows = [...state.rows]
    const [row] = rows.splice(from, 1)
    rows.splice(to, 0, row)
    setRows(rows)
    setFocusRequest({ id: row.id, at: 'end' })
  }

  const handleRowKeyDown = (e: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.nativeEvent.isComposing) return
    const row = state.rows[index]
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      insertRowAfter(index)
    } else if (e.key === 'Backspace' && row.text === '') {
      e.preventDefault()
      removeRow(index, 'previous')
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      moveRow(index, e.key === 'ArrowUp' ? index - 1 : index + 1)
    }
  }

  const handleDrop = (e: DragEvent, index: number) => {
    e.preventDefault()
    if (dragIndex !== null) moveRow(dragIndex, index)
    setDragIndex(null)
    setDropIndex(null)
  }

  const bannerText = !conflict
    ? null
    : !latest
      ? t('This goal was cleared.')
      : latest.status === 'complete' && state.base?.status !== 'complete'
        ? t('Halo marked this goal achieved.')
        : latest.updatedBy === 'agent'
          ? t('Halo updated this goal while you were editing.')
          : t('This goal was changed while you were editing.')

  const takeLatest = () => {
    if (!latest) closeTab()
    else setState(fromGoal(latest, state.rows))
  }

  const keepMine = () => update({ base: latest })

  // What the other version changes, shown on request so the choice isn't blind.
  const latestPreview = showingLatest && latest ? (
    <div className="mt-2 rounded-lg border border-border bg-card px-3 py-2.5">
      <p className="text-sm whitespace-pre-wrap break-words text-foreground">{latest.objective}</p>
      {(latest.doneWhen.length > 0 || fields.doneWhen.length > 0) && (
        <ul className="mt-2 space-y-0.5 text-sm">
          {latest.doneWhen.map((criterion, i) => {
            const added = !fields.doneWhen.includes(criterion.trim())
            return (
              <li key={`latest-${i}`} className={`flex gap-1.5 break-words ${added ? 'text-primary' : 'text-foreground/90'}`}>
                <span aria-hidden className="shrink-0 w-3 text-center">{added ? '+' : '•'}</span>
                <span>
                  <span aria-hidden>{criterion}</span>
                  <span className="sr-only">{added ? t('Added: {{criterion}}', { criterion }) : criterion}</span>
                </span>
              </li>
            )
          })}
          {fields.doneWhen.filter((c) => !latest.doneWhen.some((l) => l.trim() === c)).map((criterion, i) => (
            <li key={`dropped-${i}`} className="flex gap-1.5 break-words text-muted-foreground line-through">
              <span aria-hidden className="shrink-0 w-3 text-center">•</span>
              <span>
                <span aria-hidden>{criterion}</span>
                <span className="sr-only">{t('Not in this version: {{criterion}}', { criterion })}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  ) : null

  const attribution = !latest
    ? t('No goal set')
    : finished
      ? timeAgo
      : `${latest.updatedBy === 'agent' ? t('Set by Halo') : t('Set by you')} · ${timeAgo}`
  const primaryLabel = finished ? t('Reopen goal') : t('Save goal')

  const actions = (
    <>
      <button type="button" onClick={cancel} className={SECONDARY_BUTTON} title={dirty ? t('Discard changes') : t('Close')}>
        {t('Cancel')}
      </button>
      <button
        type="button"
        onClick={() => void save()}
        disabled={!canSave}
        className={PRIMARY_BUTTON}
        title={`${primaryLabel} — ${navigator.platform.toLowerCase().includes('mac') ? '⌘S' : 'Ctrl+S'}`}
      >
        {saving ? <Loader2 size={14} className="animate-spin" aria-label={t('Saving...')} /> : primaryLabel}
      </button>
    </>
  )

  return (
    <div className="flex h-full flex-col" onKeyDown={handleKeyDown}>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 sm:px-8 py-5 sm:py-8">
          {/* Header */}
          <div
            key={refreshFlash}
            className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg text-xs text-muted-foreground
              ${refreshFlash ? 'animate-[pulse-highlight_600ms_ease-in-out_1]' : ''}`}
          >
            {latest ? (
              <>
                <GoalStatusIcon goal={latest} running={running} size={15} />
                <span className="font-medium text-foreground">{goalStatusLabel(latest, running, t)}</span>
                <span aria-hidden>·</span>
                <span>{attribution}</span>
              </>
            ) : (
              <span>{attribution}</span>
            )}
            {conversation && (
              <span className="min-w-0 truncate sm:ml-auto">
                {t('in "{{title}}"', { title: conversation.title })}
              </span>
            )}
            <span className="hidden sm:flex items-center gap-2 w-full sm:w-auto sm:ml-3">
              {actions}
            </span>
          </div>

          {/* Banners */}
          {bannerText && (
            <div className="mt-4 rounded-lg border border-primary/30 bg-primary/[0.06] px-3 py-2.5 text-sm">
              <div role="alert" className="flex flex-col sm:flex-row sm:items-center gap-2">
                <AlertTriangle size={15} className="hidden sm:block shrink-0 text-primary" aria-hidden />
                <span className="flex-1 text-foreground">{bannerText}</span>
                <div className="flex flex-wrap items-center gap-2">
                  {latest && (
                    <button
                      type="button"
                      onClick={() => setPreviewBase(showingLatest ? undefined : state.base)}
                      aria-expanded={showingLatest}
                      className="h-9 sm:h-8 px-2 rounded-md text-[13px] font-medium text-primary hover:bg-primary/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    >
                      {showingLatest
                        ? t('Hide')
                        : latest.updatedBy === 'agent' ? t("Show Halo's version") : t('Show the other version')}
                    </button>
                  )}
                  <button type="button" onClick={takeLatest} className={SECONDARY_BUTTON}>
                    {latest?.updatedBy === 'agent' ? t("Use Halo's version") : t('Discard my changes')}
                  </button>
                  <button type="button" onClick={keepMine} className={SECONDARY_BUTTON}>
                    {t('Keep mine')}
                  </button>
                </div>
              </div>
              {latestPreview}
            </div>
          )}
          {!bannerText && finished && (
            <div role="status" className="mt-4 rounded-lg border border-border bg-secondary/60 px-3 py-2.5 text-sm text-foreground">
              <div className="flex items-center gap-2">
                <Info size={15} className="shrink-0 text-muted-foreground" aria-hidden />
                {t('This goal is finished. Saving will reopen it as an active goal.')}
              </div>
              {latest?.note && (
                <p className="mt-1.5 pl-[23px] text-sm italic text-muted-foreground break-words">
                  {t('Note: {{note}}', { note: latest.note })}
                </p>
              )}
            </div>
          )}

          {/* Objective */}
          <label htmlFor={`${tab.id}-objective`} className="mt-6 block text-sm font-medium text-foreground">
            {t('Objective')}
          </label>
          <textarea
            id={`${tab.id}-objective`}
            ref={objectiveRef}
            value={state.objective}
            onChange={(e) => update({ objective: e.target.value })}
            placeholder={t('What should be true when this is done?')}
            rows={1}
            aria-invalid={objectiveMissing && (dirty || attemptedSave)}
            aria-describedby={`${tab.id}-objective-error`}
            className="mt-1.5 w-full resize-none overflow-hidden rounded-lg border border-border bg-card px-3 py-2 text-base sm:text-lg leading-snug text-foreground placeholder:text-subtle-foreground focus:outline-none focus:border-primary focus:ring-[3px] focus:ring-primary/[0.12]"
          />
          <p id={`${tab.id}-objective-error`} className="min-h-[1.25rem] pt-1 text-xs text-destructive" aria-live="polite">
            {objectiveMissing && (dirty || attemptedSave) ? t('Add an objective') : ''}
          </p>

          {/* Criteria */}
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-3">
            <span id={`${tab.id}-criteria`} className="text-sm font-medium text-foreground">{t('Done when')}</span>
            <span className="text-xs text-muted-foreground">{t('Concrete checks Halo can verify')}</span>
          </div>
          <ul className="mt-2 space-y-1.5" aria-labelledby={`${tab.id}-criteria`}>
            {state.rows.map((row, index) => (
              <li
                key={row.id}
                onDragOver={(e) => {
                  if (dragIndex === null) return
                  e.preventDefault()
                  setDropIndex(index)
                }}
                onDrop={(e) => handleDrop(e, index)}
                className={`group flex items-center gap-1.5 rounded-md ${dropIndex === index && dragIndex !== index ? 'ring-2 ring-primary/40' : ''} ${dragIndex === index ? 'opacity-50' : ''}`}
              >
                <span
                  draggable
                  onDragStart={(e) => {
                    setDragIndex(index)
                    e.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => {
                    setDragIndex(null)
                    setDropIndex(null)
                  }}
                  title={t('Drag to reorder (Alt+↑/↓)')}
                  className="hidden sm:flex shrink-0 cursor-grab items-center text-muted-foreground/50 hover:text-muted-foreground"
                  aria-hidden
                >
                  <GripVertical size={14} />
                </span>
                <span className="shrink-0 text-muted-foreground" aria-hidden>•</span>
                <input
                  ref={(el) => {
                    if (el) rowRefs.current.set(row.id, el)
                    else rowRefs.current.delete(row.id)
                  }}
                  value={row.text}
                  onChange={(e) => setRows(state.rows.map((r) => (r.id === row.id ? { ...r, text: e.target.value } : r)))}
                  onKeyDown={(e) => handleRowKeyDown(e, index)}
                  placeholder={t('e.g. The test suite passes')}
                  aria-label={t('Criterion {{number}}', { number: index + 1 })}
                  className="flex-1 min-w-0 h-9 rounded-md border border-transparent bg-transparent px-2 text-sm text-foreground placeholder:text-subtle-foreground hover:border-border focus:outline-none focus:border-primary focus:bg-card"
                />
                <button
                  type="button"
                  onClick={() => removeRow(index, 'none')}
                  aria-label={t('Remove criterion')}
                  title={t('Remove criterion')}
                  className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus-visible:opacity-100 hover:text-destructive hover:bg-destructive/10 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => insertRowAfter(state.rows.length - 1)}
            className="mt-1.5 inline-flex items-center gap-1.5 h-9 sm:h-8 px-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <Plus size={14} aria-hidden />
            {t('Add criterion')}
          </button>

          {/* Footer */}
          <div className="mt-8 flex flex-col sm:flex-row sm:items-center gap-3 border-t border-border pt-4">
            <p className="flex-1 flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info size={13} className="mt-px shrink-0" aria-hidden />
              {running ? t('Halo will see your changes at its next step.') : t('Halo will see your changes with your next message.')}
            </p>
            <span className="text-xs text-halo-success empty:-mt-3 sm:empty:mt-0" aria-live="polite">
              {savedFlash ? (
                <span className="inline-flex items-center gap-1"><Check size={13} aria-hidden />{t('Saved')}</span>
              ) : null}
            </span>
            {latest && (
              <button
                type="button"
                onClick={() => requestClear(latest, closeTab)}
                className="self-start sm:self-auto h-8 px-2.5 -ml-2.5 sm:ml-0 rounded-md text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
              >
                {latest.status === 'active' ? t('Clear goal') : t('Dismiss')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Mobile action bar */}
      <div className="sm:hidden flex justify-end gap-2 border-t border-border bg-background px-4 py-2.5">
        {actions}
      </div>
      {confirmDialog}
    </div>
  )
}

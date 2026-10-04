/**
 * Going back to the place a reference points at — the file, the diff, the
 * terminal output or the chat message — and lighting it up. When the content
 * changed since, the place is found again by its text; when it is gone, the
 * user is told so rather than shown somewhere else. A pending comment gone
 * back to is edited in its card there — or, when the place cannot be shown,
 * in the floating card beside the composer.
 */

import i18n from '../../i18n'
import { api } from '../../api'
import { isElectron } from '../../api/transport'
import { canvasLifecycle, type RevealTarget } from '../../services/canvas-lifecycle'
import { conversationKind, digitalHumanAppId, selectActiveConversationId, useChatStore } from '../../stores/chat.store'
import { useComposerReferencesStore } from '../../stores/composer-references.store'
import { useNotificationStore } from '../../stores/notification.store'
import { useSpaceStore } from '../../stores/space.store'
import { useTerminalStore } from '../../stores/terminal.store'
import { attachedPathName } from '../../../shared/attached-paths'
import { pathRelativeTo } from '../../../shared/content-reference'
import type { ContentReference, TerminalReferenceSource } from '../../../shared/types/content-reference'
import { revealInElement } from './adapters/dom-text'
import { openCommentCardAtComposer, openCommentCardAtTopOf } from './comment-markers'
import type { RevealOutcome } from './relocate'

const NOTICE_ID = 'reference-reveal'
/** How long a message switched to may take to appear before it counts as gone. */
const MESSAGE_WAIT_MS = 4000
/** How long a file opened for a comment is watched for failing to read. */
const LOAD_WAIT_MS = 10_000

function notify(title: string, variant: 'default' | 'warning' = 'warning'): void {
  useNotificationStore.getState().show({ id: NOTICE_ID, title, variant, duration: 4000 })
}

/** The standard notice after going back: nothing when found as it was. */
export function notifyRevealOutcome(outcome: RevealOutcome): void {
  if (outcome === 'moved') notify(i18n.t('Content moved — showing where it is now'), 'default')
  else if (outcome === 'lost') notify(i18n.t('Content has changed — showing where it was'))
}

export function notifyTerminalOutputMissing(): void {
  notify(i18n.t("Couldn't find this output in the terminal"))
}

function currentSpace() {
  return useSpaceStore.getState().currentSpace
}

/** True only for a file of the current space that is known not to exist (outside it, nobody can tell). */
async function isMissingSpaceFile(path: string): Promise<boolean> {
  const space = currentSpace()
  if (!space) return false
  const root = space.workingDir || space.path
  if (pathRelativeTo(path, root) === null) return false
  try {
    const response = await api.resolveArtifactPaths(space.id, [path])
    return response.success === true && !!response.data?.[0] && response.data[0].absolutePath === null
  } catch {
    return false
  }
}

/** Whether the tab's content comes in: false when it cannot be read, or the tab is closed first. */
async function contentLoads(tabId: string): Promise<boolean> {
  const deadline = Date.now() + LOAD_WAIT_MS
  for (;;) {
    const tab = canvasLifecycle.getTab(tabId)
    if (!tab) return false
    if (!tab.isLoading) return !tab.error
    if (Date.now() > deadline) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/**
 * Opens `path` at the place `target` names, or says the file no longer exists
 * instead of opening it — for a viewer that cannot show the place itself. A
 * comment whose file is gone, opens outside the canvas or cannot be read
 * opens beside the composer.
 */
export async function revealFileAt(path: string, target: RevealTarget = {}): Promise<void> {
  if (await isMissingSpaceFile(path)) {
    notify(i18n.t('{{name}} no longer exists', { name: attachedPathName(path) }))
    if (target.commentId) openCommentCardAtComposer(target.commentId)
    return
  }
  // A request naming no place would be reported as content that changed.
  const tabId = await canvasLifecycle.openFile(path, target.range || target.quote ? { reveal: target } : undefined)
  if (target.commentId && !(tabId && await contentLoads(tabId))) openCommentCardAtComposer(target.commentId)
}

async function revealTerminal(source: TerminalReferenceSource, target: RevealTarget): Promise<void> {
  const sessionId = source.sessionId
  const open = sessionId
    ? canvasLifecycle.getTabs().find(tab => tab.type === 'terminal' && tab.terminalSessionId === sessionId)
    : undefined
  const session = sessionId ? useTerminalStore.getState().sessions.get(sessionId) : undefined
  if (!sessionId || (!open && (!session || session.state !== 'running'))) {
    notify(i18n.t('That terminal is closed'))
    if (target.commentId) openCommentCardAtComposer(target.commentId)
    return
  }
  // The request rides on the tab from the start, so the viewer mounts knowing whether to take focus.
  await canvasLifecycle.openTerminal(sessionId, session?.title || source.title, { reveal: target })
}

function waitForElement(selector: string, timeoutMs: number): Promise<Element | null> {
  const deadline = Date.now() + timeoutMs
  return new Promise(resolve => {
    const check = () => {
      const element = document.querySelector(selector)
      if (element) resolve(element)
      else if (Date.now() > deadline) resolve(null)
      else setTimeout(check, 100)
    }
    check()
  })
}

/** Makes `conversationId` the active conversation; false when it cannot be (deleted, or not of this space). */
async function showConversation(conversationId: string): Promise<boolean> {
  const chat = useChatStore.getState()
  if (selectActiveConversationId(chat) === conversationId) return true
  const spaceId = chat.currentSpaceId
  const appId = digitalHumanAppId(conversationId)
  if (conversationKind(conversationId) === 'digital-human' && appId && spaceId) {
    chat.selectAppChatConversation(spaceId, appId, conversationId)
  } else {
    await chat.selectConversation(conversationId)
  }
  return selectActiveConversationId(useChatStore.getState()) === conversationId
}

/**
 * Brings the chat to `messageId` — switching conversation, and leaving a
 * maximized or full-screen canvas, when needed — and lights up the passage
 * `quote` in it (or the whole message); with `commentId`, the comment on the
 * passage opens: beside it, at the top of the message when the passage is no
 * longer there, or beside the composer — back in the conversation it was
 * written in — when the message is gone. False when the message is gone.
 */
export async function revealMessage(conversationId: string, messageId: string, quote?: string, options: { commentId?: string } = {}): Promise<boolean> {
  const target = useComposerReferencesStore.getState().target
  if (target && !target.visible) target.reveal()
  const from = selectActiveConversationId(useChatStore.getState())
  const gone = async () => {
    notify(i18n.t('That message is no longer available'))
    if (!options.commentId) return
    if (from && from !== conversationId) await showConversation(from)
    openCommentCardAtComposer(options.commentId)
  }

  if (!(await showConversation(conversationId))) {
    await gone()
    return false
  }

  // The transcript mounts a message from unloaded history and scrolls to it.
  window.dispatchEvent(new CustomEvent('search:navigate-to-message', { detail: { messageId, query: '' } }))
  const element = await waitForElement(`[data-message-id="${CSS.escape(messageId)}"]`, MESSAGE_WAIT_MS)
  if (!element) {
    await gone()
    return false
  }
  if (quote) {
    const content = element.querySelector<HTMLElement>('[data-message-content]') ?? (element as HTMLElement)
    if (!revealInElement(content, quote, options)) {
      notifyRevealOutcome('lost')
      if (options.commentId) openCommentCardAtTopOf(options.commentId, content)
    }
  }
  return true
}

/**
 * Opens what `ref` points at and lights it up. With `keepFocus` (asked from
 * the composer) the place is shown without taking the caret away; with
 * `focusComment`, a pending comment's card there takes the focus instead, to
 * be edited.
 */
export async function revealReference(ref: ContentReference, options: { keepFocus?: boolean; focusComment?: boolean } = {}): Promise<void> {
  const { source } = ref
  const commentId = options.focusComment && ref.note ? ref.id : undefined
  const focus = commentId ? { commentId } : options.keepFocus ? { keepFocus: true } : {}
  switch (source.kind) {
    case 'file':
      await revealFileAt(source.path, {
        range: ref.range, quote: ref.quote, ...(source.precision === 'passage' ? { passage: true } : {}), ...focus,
      })
      return
    case 'diff': {
      const space = currentSpace()
      if (source.repo && space) {
        await canvasLifecycle.openChanges(
          { kind: 'git', spaceId: space.id, repoRoot: source.repo.root },
          { reveal: { path: source.path, side: source.side, range: ref.range, quote: ref.quote, ...focus } },
        )
        return
      }
      // A reply's edits have no tab to return to; the file shows where the text is now.
      await revealFileAt(source.path, { range: ref.range, quote: ref.quote, ...focus })
      return
    }
    case 'terminal':
      await revealTerminal(source, { quote: ref.quote, ...focus })
      return
    case 'message':
      await revealMessage(source.conversationId, source.messageId, source.whole ? undefined : ref.quote, { commentId })
      return
    case 'path':
      if (isElectron()) void api.showArtifactInFolder(source.path)
      return
  }
}

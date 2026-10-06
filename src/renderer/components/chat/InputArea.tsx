/**
 * Input Area - Enhanced message input with bottom toolbar
 *
 * Layout (following industry standard):
 * ┌──────────────────────────────────────────────────────┐
 * │ [Image previews] [Reference cards]                   │
 * │ ┌──────────────────────────────────────────────────┐ │
 * │ │ Textarea                                         │ │
 * │ └──────────────────────────────────────────────────┘ │
 * │ [Recipient] [+] [Thinking] [Knowledge] ──── [Send]   │
 * │      Bottom toolbar: always visible, expandable     │
 * └──────────────────────────────────────────────────────┘
 *
 * Features:
 * - Auto-resize textarea
 * - Keyboard shortcuts (Enter to send, Shift+Enter newline)
 * - Image paste/drop support with compression
 * - Extended thinking mode toggle (theme-colored)
 * - Bottom toolbar for future extensibility
 */

import { memo, useState, useRef, useEffect, useMemo, useCallback, KeyboardEvent, ClipboardEvent, DragEvent } from 'react'
import { Plus, Paperclip, Loader2, AlertCircle, MessagesSquare, Bot, Target } from 'lucide-react'
import { useAppStore } from '../../stores/app.store'
import { useChatStore } from '../../stores/chat.store'
import { useOnboardingStore } from '../../stores/onboarding.store'
import { getOnboardingPrompt } from '../onboarding/onboardingData'
import { LiveSessionsHeader } from './LiveSessionsHeader'
import { ComposerMenu, type ComposerMenuSection } from './composer-menu/ComposerMenu'
import { useComposerToolsets } from './composer-menu/useComposerToolsets'
import { sortToolsets, toolsetDescription, toolsetIcon, toolsetLabel } from './composer-menu/toolset-display'
import type { ToolsetStatus } from '../../stores/toolsets.store'
import { canAttachPath, type AttachedPath, type PickedLocalEntry } from '../../../shared/attached-paths'
import { MAX_UPLOAD_FILE_SIZE } from '../../../shared/constants/artifact-upload'
import type { ContentReference } from '../../../shared/types/content-reference'
import { useComposerReferences, useComposerReferencesStore } from '../../stores/composer-references.store'
import { useSpaceStore } from '../../stores/space.store'
import { commitCommentEdits, ComposerReferenceChips, notifyReferenceLimit, useHasNewCommentText } from '../references'
import { api } from '../../api'
import { isElectron } from '../../api/transport'
import { ImageAttachmentPreview } from './ImageAttachmentPreview'
import { KnowledgeBaseButton } from './KnowledgeBaseButton'
import { processImage, isValidImageType, formatFileSize } from '../../utils/imageProcessor'
import { startDigitalHumanConversation } from '../../utils/conversation-navigation'
import type { ImageAttachment } from '../../types'
import type { FileQueryItem } from '../../../shared/types/artifact'
import { normalizePathLike } from '../../../shared/file-path-match'
import { useFileMentionQuery } from '../../hooks/useFileMentionQuery'
import { getCurrentSource, resolveModelVision } from '../../types'
import { useTranslation } from '../../i18n'
import { SlashCommandMenu, filterSlashCommands } from './SlashCommandMenu'
import type { SlashCommandItem } from '../../types/slash-command'
import { ConversationMentionRow } from './cross-conversation'
import type { ConversationMentionCandidate } from './cross-conversation'
import { decideConversationMentionCandidates } from './mentionMenuDecision'
import { formatConversationReference } from '../../../shared/conversation-reference'
import { DigitalHumanSelector, type DigitalHumanSelectorConfig } from './DigitalHumanSelector'
import { AutomationAvatar } from '../apps/AutomationAvatar'
import {
  lenBucket,
  takeComposerOrigin,
  takeEntry,
  trackHome,
  trackHomeThrottled,
  type ComposerOrigin,
} from '../../services/home-telemetry'
import type { GoalComposerConfig } from '../goal'

// ── mention helpers ──
//
// One trigger, "@", for everything the user can point at: a digital human, a
// file, another conversation. What they type filters across all three and the
// menu groups the survivors by kind. A second symbol would only ask the user
// to memorise which character addresses what, which is our problem to solve,
// not theirs.

interface MentionMatch {
  query: string
  start: number
  end: number
}

function getMentionMatch(value: string, cursorPosition: number): MentionMatch | null {
  const beforeCursor = value.slice(0, cursorPosition)
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/)
  if (!match || match.index === undefined) return null
  return { query: match[2] || '', start: match.index + match[1].length, end: cursorPosition }
}

function formatArtifactReference(relativePath: string): string {
  return `\`${relativePath}\``
}

// A picked conversation is inserted as the shared reference form
// (`shared/conversation-reference.ts`): the same string the user sees is what
// gets sent, so nothing is rewritten behind their back on send.

/**
 * One row of the @ menu. The menu is a single mechanism over several candidate
 * kinds — adding a kind means adding a variant here, never a second picker.
 *
 * `text` is what picking the row inserts. A digital human has none: picking one
 * switches who the message goes to and leaves no trace in the text.
 */
type MentionCandidate =
  | { kind: 'digitalHuman'; key: string; text: null; appId: string; name: string; paused: boolean }
  | { kind: 'conversation'; key: string; text: string; conversation: ConversationMentionCandidate }
  | { kind: 'artifact'; key: string; text: string; artifact: FileQueryItem }

/**
 * Section heading shown above each kind's rows.
 *
 * A switch, not a lookup table: the extractor only collects literals written
 * inside `t(...)`, so a table of bare strings ships an untranslated heading.
 */
function mentionGroupLabel(kind: MentionCandidate['kind'], t: (key: string) => string): string {
  switch (kind) {
    case 'digitalHuman': return t('Digital humans')
    case 'conversation': return t('Conversations')
    case 'artifact': return t('Files')
  }
}

type MentionTelemetryType = 'digital_human' | 'file' | 'conversation'

const MENTION_TELEMETRY_TYPE: Record<MentionCandidate['kind'], MentionTelemetryType> = {
  digitalHuman: 'digital_human',
  artifact: 'file',
  conversation: 'conversation',
}

/**
 * Rows per group on a bare "@", before the user types anything to narrow.
 *
 * Browsing and searching want opposite things. A bare "@" is a question about
 * what kinds of things can be addressed at all, so every group must reach the
 * screen — one long group running past the fold reads as "digital humans are
 * the only option". Once a query exists the user knows what they are after,
 * and the cap would only hide matches, so it lifts.
 */
const MENTION_GROUP_PREVIEW_LIMIT = 4
/** Most file matches the @ menu asks the index for. */
const MENTION_FILE_LIMIT = 50

/** One kind's rows, plus where they start in the flat keyboard-navigation order. */
interface MentionGroup {
  kind: MentionCandidate['kind']
  candidates: MentionCandidate[]
  /**
   * True when the preview limit dropped rows, which the heading then says.
   * Deliberately a flag and not a count: the source lists are themselves
   * capped, so any number shown would understate what typing reveals.
   */
  truncated: boolean
  startIndex: number
}

/** What a send carries besides text, images and the thinking switch. */
export interface ComposerSendOptions {
  /** The cards in the composer, in order (their numbers). */
  references?: ContentReference[]
}

interface InputAreaProps {
  /** Resolving false means nothing was sent: the text, images and cards come back. */
  onSend: (content: string, images?: ImageAttachment[], thinkingEnabled?: boolean, options?: ComposerSendOptions) => void | Promise<void | boolean>
  /**
   * Called when user submits a message while generation is in progress (mid-turn inject).
   * Resolving false means nothing was added: the text and cards come back.
   */
  onInject?: (content: string, references?: ContentReference[]) => Promise<void | boolean>
  /** Stop the current generation. Omit for inject-only inputs that cannot stop the
   *  underlying process (e.g. the automation run-detail supplement input); the Stop
   *  button is then hidden. */
  onStop?: () => void
  isGenerating: boolean
  placeholder?: string
  isCompact?: boolean
  toolbarSlot?: React.ReactNode
  /** Controls placed just left of the send button (e.g. model and quota). */
  sendSlot?: React.ReactNode
  /** Available slash commands for the "/" quick-input autocomplete */
  slashCommands?: SlashCommandItem[]
  /** Space whose files the @ menu offers (queried on demand); omitted = no Files group. */
  mentionSpaceId?: string
  /**
   * Conversations available in the @ menu. Omitted by surfaces that cannot
   * deliver across conversations (digital-human / team chat), which then show
   * no Conversations group.
   */
  mentionConversations?: ConversationMentionCandidate[]
  /**
   * Hide the Capabilities group of the "+" panel (the toolset broker's
   * switches). Digital-human chat sets this: a digital human's tools are
   * governed by its own Capabilities panel, not the broker, so the switches
   * would be inert and misleading here.
   */
  hideToolsetControls?: boolean
  /**
   * Hide the knowledge base loader button. Digital-human chat sets this: an
   * app's knowledge bases are bound via its config panel (AppKnowledgeSection),
   * not per-conversation attach — the button's space-conversation logic would
   * silently no-op here.
   */
  hideKnowledgeControls?: boolean
  /**
   * Drop the docked-input styling (top border, full-bleed background) for
   * contexts where this renders as a standalone card instead of pinned to
   * the bottom of a message list — e.g. the chat empty state's centered
   * composer.
   */
  standalone?: boolean
  /**
   * Digital-human "recipient" dropdown, docked at the input's left
   * edge. Only the main conversation board sets this — other InputArea
   * consumers (digital-human chat itself, the run-detail inject box) omit it
   * and the control simply doesn't render.
   */
  digitalHumanSelector?: DigitalHumanSelectorConfig
  /**
   * Enables per-conversation draft persistence: unsent text is stashed
   * in chat.store's in-memory composerDrafts map under this key and restored
   * on mount, so switching the digital-human selector away and back doesn't
   * lose what was typed. Callers MUST remount this component (`key={draftKey}`)
   * when the key changes — drafts are read once, at mount, via lazy useState.
   */
  draftKey?: string
  /**
   * Conversation goal: the "+" menu row, goal mode, and the shelf above the
   * card. Only the space conversation board sets this, and only for engines
   * that keep goals.
   */
  goal?: GoalComposerConfig
}

// Draft attachments stay in memory; image data must not fill browser storage.
// The cards live in the composer-references store under the same key.
interface InputDraft { content: string; images: ImageAttachment[] }
const inputDrafts = new Map<string, InputDraft>()
// A failed send can settle after its original input has been replaced.
const draftRecoverySubscribers = new Map<string, Set<(draft: InputDraft) => void>>()
// Cards of a composer with no draft key live under a key of its own, gone with it.
let composerInstanceSeq = 0

// Image constraints
const MAX_IMAGE_SIZE = 20 * 1024 * 1024  // 20MB max per image (before compression)
const MAX_IMAGES = 10  // Max images per message

function base64ToFile(data: string, name: string, mediaType: string): File {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new File([bytes], name, { type: mediaType })
}

/**
 * Every composer send thinks. How hard is the conversation's (or digital
 * human's) own level, resolved in main; without one, the model's configured
 * effort.
 */
const THINKING_ENABLED = true

// Error message type
interface ImageError {
  id: string
  message: string
}

// Memoized: the composer is large and its parent re-renders on every turn-state change.
export const InputArea = memo(function InputArea({ onSend, onInject, onStop, isGenerating, placeholder, isCompact = false, toolbarSlot, sendSlot, draftKey, slashCommands = [], mentionSpaceId, mentionConversations = [], hideToolsetControls = false, hideKnowledgeControls = false, standalone = false, digitalHumanSelector, goal }: InputAreaProps) {
  const { t } = useTranslation()
  const sendKeyMode = useAppStore(state => state.config?.chat?.sendKeyMode ?? 'enter')

  // Vision support detection — images are always accepted; for non-vision
  // models the backend persists them to files and routes them through the
  // on-device OCR tool, so this flag only drives the informational hint.
  // Shares `resolveModelVision` with the backend so the hint can never claim
  // OCR while the request still ships image blocks.
  const aiSources = useAppStore(state => state.config?.aiSources)
  const visionEnabled = useMemo(() => {
    if (!aiSources) return true
    const source = getCurrentSource(aiSources)
    if (!source) return true
    return resolveModelVision(source, source.model)
  }, [aiSources])
  const currentDraftKey = useRef(draftKey)
  currentDraftKey.current = draftKey
  const [content, setContent] = useState(() => draftKey ? inputDrafts.get(draftKey)?.content ?? '' : '')
  const [isFocused, setIsFocused] = useState(false)
  const [images, setImages] = useState<ImageAttachment[]>(() => draftKey ? inputDrafts.get(draftKey)?.images ?? [] : [])
  const [instanceKey] = useState(() => `composer-${++composerInstanceSeq}`)
  const referenceKey = draftKey ?? instanceKey
  const references = useComposerReferences(referenceKey)
  const writingComment = useHasNewCommentText(referenceKey)
  useEffect(() => {
    if (draftKey) return
    return () => { useComposerReferencesStore.getState().take(instanceKey) }
  }, [draftKey, instanceKey])
  useEffect(() => {
    if (!draftKey) return
    const restore = (draft: InputDraft) => {
      setContent(current => current || draft.content)
      setImages(current => current.length ? current : draft.images)
    }
    const listeners = draftRecoverySubscribers.get(draftKey) ?? new Set<(draft: InputDraft) => void>()
    listeners.add(restore)
    draftRecoverySubscribers.set(draftKey, listeners)
    const saved = inputDrafts.get(draftKey)
    if (saved) restore(saved)
    return () => {
      listeners.delete(restore)
      if (!listeners.size) draftRecoverySubscribers.delete(draftKey)
    }
  }, [draftKey])
  useEffect(() => {
    if (draftKey) {
      if (content || images.length) inputDrafts.set(draftKey, { content, images })
      else inputDrafts.delete(draftKey)
    }
  }, [draftKey, content, images])
  const [isDragOver, setIsDragOver] = useState(false)
  const [isProcessingImages, setIsProcessingImages] = useState(false)
  // Files a remote client is still uploading into the space (see uploadFiles).
  // Their cards are not in the message yet, so no way of sending goes out until they land.
  const [uploadingCount, setUploadingCount] = useState(0)
  const uploading = uploadingCount > 0
  const [imageError, setImageError] = useState<ImageError | null>(null)
  const [showAttachMenu, setShowAttachMenu] = useState(false)  // Attachment menu visibility
  // Slash-command autocomplete
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  // Set only by the pendingComposerInput prefill path (see its effect below)
  // to show a confirmation menu independent of the session's live command
  // list. Cleared the moment the user actually types, falling back to the
  // normal session-derived filtering.
  const [slashPreviewOverride, setSlashPreviewOverride] = useState<SlashCommandItem | null>(null)
  // @ mention autocomplete; cursorPos is tracked as state for correct useMemo deps
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false)
  // Opened by typing with only files as a possible kind: the menu stays hidden
  // until the space turns out to have files, so "@" in an empty space is inert.
  const [mentionFilesOnly, setMentionFilesOnly] = useState(false)
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0)
  const [cursorPos, setCursorPos] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const plusTriggerRef = useRef<HTMLButtonElement>(null)
  const goalMode = !!goal?.active
  // A remote client's files are not on the host, so only uploaded images make sense there.
  const canAttachLocalPaths = isElectron()

  // ── References (shown as chips; their counts bump as references arrive) ──
  const spaceRoot = useSpaceStore(state => (state.currentSpace ? state.currentSpace.workingDir || state.currentSpace.path : undefined))
  const focusText = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  }, [])

  // A selection elsewhere added a reference here, and may want the caret here too.
  const signal = useComposerReferencesStore(state => (state.signal?.key === referenceKey ? state.signal : null))
  useEffect(() => {
    if (!signal) return
    useComposerReferencesStore.getState().consumeSignal(signal.seq)
    if (signal.focus === 'text') requestAnimationFrame(focusText)
  }, [signal, focusText])

  // Opened by an AI request rather than by the user: the panel then leaves the keyboard to the composer.
  const [attachMenuByRequest, setAttachMenuByRequest] = useState(false)
  const openAttachMenu = useCallback((byRequest = false) => {
    setSlashMenuOpen(false)
    setMentionMenuOpen(false)
    setAttachMenuByRequest(byRequest)
    setShowAttachMenu(true)
  }, [])
  const openAttachMenuForRequest = useCallback(() => openAttachMenu(true), [openAttachMenu])
  const toolsets = useComposerToolsets({
    enabled: !hideToolsetControls,
    panelOpen: showAttachMenu,
    onRequested: openAttachMenuForRequest,
  })

  useEffect(() => {
    if (goalMode) textareaRef.current?.focus()
  }, [goalMode])

  // A starting turn takes the panel's Add and Context rows away: close it rather than reshape it under the pointer.
  useEffect(() => {
    if (isGenerating) setShowAttachMenu(false)
  }, [isGenerating])

  // Only the home composer wires the recipient selector, so it also scopes
  // the home.composer.* events.
  const isHomeComposer = !!digitalHumanSelector
  // What produced the current draft, credited to its send.
  const composerOriginRef = useRef<ComposerOrigin | null>(null)
  const mentionInsertedRef = useRef(false)

  // Consume a composer prefill requested for this space (e.g. a skill's slash
  // command from the store's "Use" action, or SkillsTab's row click): fill
  // the box once, focus, cursor to end. Cleared immediately so it never
  // re-fires or leaks into another space.
  const pendingComposerInput = useChatStore(state => state.pendingComposerInput)
  const currentSpaceId = useChatStore(state => state.currentSpaceId)
  useEffect(() => {
    if (!pendingComposerInput || pendingComposerInput.spaceId !== currentSpaceId) return
    const text = pendingComposerInput.text
    const slashPreview = pendingComposerInput.slashPreview
    useChatStore.setState({ pendingComposerInput: null })
    composerOriginRef.current = takeComposerOrigin()
    setContent(text)
    // A prefilled slash command (skill "use" actions always fill one) opens
    // the same autocomplete menu the user would see typing it — it's the
    // only surface that shows the skill's argument hint, and it doubles as
    // a quick confirm of what actually got filled. The live-typing handler
    // below gates on "no space yet" to avoid opening while typing plain
    // text that starts with '/'; that concern doesn't apply here since this
    // path only ever fills a real, known command.
    if (text.startsWith('/')) {
      setSlashMenuOpen(true)
      setSlashSelectedIndex(0)
      // Show it even if the current session hasn't announced this command
      // (new empty conversation, or a skill the SDK didn't load for this
      // session) — see slashPreviewOverride's declaration for why that's safe.
      setSlashPreviewOverride(slashPreview ? {
        id: `preview-${slashPreview.command}`,
        command: slashPreview.command,
        label: slashPreview.label,
        description: slashPreview.description,
        category: 'skill',
      } : null)
    }
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`
    })
  }, [pendingComposerInput, currentSpaceId])

  // Auto-clear error after 3 seconds
  useEffect(() => {
    if (imageError) {
      const timer = setTimeout(() => setImageError(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [imageError])

  // Show error to user
  const showError = (message: string) => {
    setImageError({ id: `err-${Date.now()}`, message })
  }

  // Onboarding state
  const { isActive: isOnboarding, currentStep } = useOnboardingStore()
  const isOnboardingSendStep = isOnboarding && currentStep === 'send-message'

  // In onboarding send step, show prefilled prompt
  const onboardingPrompt = getOnboardingPrompt(t)
  const displayContent = isOnboardingSendStep ? onboardingPrompt : content

  // Process file to ImageAttachment with professional compression
  const processFileWithCompression = async (file: File): Promise<ImageAttachment | null> => {
    // Validate type
    if (!isValidImageType(file)) {
      showError(t('Unsupported image format: {{type}}', { type: file.type || t('Unknown') }))
      return null
    }

    // Validate size (before compression)
    if (file.size > MAX_IMAGE_SIZE) {
      showError(t('Image too large ({{size}}), max 20MB', { size: formatFileSize(file.size) }))
      return null
    }

    try {
      // Use professional image processor for compression
      const processed = await processImage(file)

      return {
        id: `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        type: 'image',
        mediaType: processed.mediaType,
        data: processed.data,
        name: file.name,
        size: processed.compressedSize
      }
    } catch (error) {
      console.error(`Failed to process image: ${file.name}`, error)
      showError(t('Failed to process image: {{name}}', { name: file.name }))
      return null
    }
  }

  // Add images (with limit check and loading state)
  const addImages = async (files: File[]) => {
    const remainingSlots = MAX_IMAGES - images.length
    if (remainingSlots <= 0) return

    const filesToProcess = files.slice(0, remainingSlots)

    // Show loading state during compression
    setIsProcessingImages(true)

    try {
      const newImages = await Promise.all(filesToProcess.map(processFileWithCompression))
      const validImages = newImages.filter((img): img is ImageAttachment => img !== null)

      if (validImages.length > 0) {
        setImages(prev => [...prev, ...validImages])
      }
    } finally {
      setIsProcessingImages(false)
    }
  }

  // Remove image
  const removeImage = (id: string) => {
    setImages(prev => prev.filter(img => img.id !== id))
  }

  /** Refused items are reported here, before any card appears, so nothing looks attached that will not be sent. */
  const reportUnattachable = (count: number, reason: 'no-local-path' | 'not-absolute') => {
    if (count === 0) return
    console.warn('[InputArea] Items not attached', { count, reason, desktop: canAttachLocalPaths })
    showError(canAttachLocalPaths
      ? t('{{count}} item(s) could not be attached: not a file or folder on this computer', { count })
      : t('{{count}} folder(s) could not be attached: only files can be uploaded from this device', { count }))
  }

  /** Local files and folders become path cards, numbered with the other cards. */
  const addPaths = (candidates: AttachedPath[]) => {
    const accepted = candidates.filter(p => canAttachPath(p.path))
    reportUnattachable(candidates.length - accepted.length, 'not-absolute')
    if (accepted.length === 0) return
    const { refused } = useComposerReferencesStore.getState().add(
      referenceKey,
      accepted.map(p => ({ source: { kind: 'path' as const, path: p.path, isDirectory: p.isDirectory } })),
    )
    if (refused === 'limit') notifyReferenceLimit()
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  /**
   * A remote client has no local path to hand over, so its files go into the
   * space's working directory first and are attached by the path they get there.
   */
  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return
    const spaceId = mentionSpaceId ?? currentSpaceId
    if (!spaceId) {
      showError(t('Open a space to attach files'))
      return
    }
    const tooLarge = (name: string) =>
      t('{{name}} is larger than {{limit}} and was not uploaded', { name, limit: formatFileSize(MAX_UPLOAD_FILE_SIZE) })
    const oversized = files.find(file => file.size > MAX_UPLOAD_FILE_SIZE)
    if (oversized) showError(tooLarge(oversized.name))
    const accepted = files.filter(file => file.size <= MAX_UPLOAD_FILE_SIZE)
    if (accepted.length === 0) return

    const uploaded: AttachedPath[] = []
    setUploadingCount(count => count + accepted.length)
    try {
      for (const file of accepted) {
        const result = await api.uploadArtifactFile(spaceId, file)
        if (result.success && result.data) {
          uploaded.push({ path: result.data.path, isDirectory: false })
        } else {
          console.warn('[InputArea] Upload failed', { code: result.code, error: result.error })
          showError(result.code === 'TOO_LARGE' ? tooLarge(file.name) : t('Could not upload {{name}}', { name: file.name }))
        }
      }
    } finally {
      setUploadingCount(count => count - accepted.length)
    }
    addPaths(uploaded)
  }

  /**
   * Splits dropped, pasted or picked files: images become image attachments (the
   * model sees them), everything else is attached by path — its local path on
   * the desktop, the path it is uploaded to elsewhere. Images beyond the
   * per-message limit go the same way rather than vanish.
   */
  const attachFiles = async (entries: Array<{ file: File; isDirectory: boolean }>) => {
    const imageFiles: File[] = []
    const byPath: AttachedPath[] = []
    const uploads: File[] = []
    let withoutPath = 0
    for (const { file, isDirectory } of entries) {
      const path = canAttachLocalPaths ? api.getPathForFile(file) : ''
      if (!isDirectory && isValidImageType(file) && images.length + imageFiles.length < MAX_IMAGES) {
        imageFiles.push(file)
      } else if (path) {
        byPath.push({ path, isDirectory })
      } else if (!canAttachLocalPaths && !isDirectory) {
        uploads.push(file)
      } else {
        withoutPath += 1
      }
    }
    reportUnattachable(withoutPath, 'no-local-path')
    addPaths(byPath)
    if (imageFiles.length > 0) await addImages(imageFiles)
    await uploadFiles(uploads)
  }

  // Handle paste event
  const handlePaste = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return

    const files: Array<{ file: File; isDirectory: boolean }> = []
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      // A copied file from the system file manager arrives with a path; a
      // screenshot or copied image arrives with bytes only. attachFiles
      // reports whatever it cannot take.
      if (file) files.push({ file, isDirectory: false })
    }

    if (files.length > 0) {
      e.preventDefault()
      await attachFiles(files)
    }
  }

  // Handle drag events
  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    if (!isDragOver) setIsDragOver(true)
  }

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }

  // Handle artifact drag-drop reference insertion
  const insertFileReference = (relativePath: string): void => {
    const target = { relativePath }
    const prefix = content && !content.endsWith(' ') && !content.endsWith('\n') ? ' ' : ''
    const nextContent = `${content}${prefix}${formatArtifactReference(target.relativePath)} `
    setContent(nextContent)
    handleMentionClose()

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        const len = nextContent.length
        textareaRef.current.setSelectionRange(len, len)
        setCursorPos(len)
      }
    })
  }

  // Dropped plain text counts as a file reference only when it names a file
  // of this space (the tree's own drags carry a dedicated type and skip this).
  const insertMatchingFileReference = async (rawPath: string): Promise<boolean> => {
    if (!mentionSpaceId) return false
    const normalizedPath = normalizePathLike(rawPath)
    if (!normalizedPath) return false
    const response = await api.queryArtifactFiles(mentionSpaceId, normalizedPath, 20)
    const target = response.data?.items.find(item => {
      const rp = normalizePathLike(item.relativePath)
      return rp === normalizedPath || rp.endsWith('/' + normalizedPath)
    })
    if (!target) return false
    insertFileReference(target.relativePath)
    return true
  }

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)

    // Everything is read before the first await: drop data is gone once the event returns.
    const treePath = e.dataTransfer.getData('text/halo-artifact-relative-path')
    const plainText = treePath ? '' : e.dataTransfer.getData('text/plain')
    const items = Array.from(e.dataTransfer.items ?? []).filter(item => item.kind === 'file')
    const files = Array.from(e.dataTransfer.files).map((file, index) => ({
      file,
      isDirectory: items[index]?.webkitGetAsEntry?.()?.isDirectory ?? false,
    }))

    // Check for artifact drag-drop first
    if (treePath.trim()) {
      insertFileReference(treePath.trim())
      return
    }
    try {
      if (plainText && files.length === 0 && await insertMatchingFileReference(plainText)) {
        return
      }
      if (files.length > 0) {
        await attachFiles(files)
      }
    } catch (error) {
      console.error('[InputArea] Drop failed:', error)
      showError(t('Could not add the dropped files'))
    }
  }

  // Handle file input change
  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length > 0) {
      await attachFiles(files.map(file => ({ file, isDirectory: false })))
    }
    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // "+" → Files and folders. The desktop opens the native picker; a remote
  // client picks files on its own device, which are uploaded into the space.
  const handleAttachClick = async () => {
    if (isHomeComposer) trackHome('home.composer.attach', { action: 'files' })
    if (!canAttachLocalPaths) {
      fileInputRef.current?.click()
      return
    }
    const res = await api.pickLocalEntries()
    if (!res.success) {
      console.warn('[InputArea] File picker failed', { error: res.error })
      showError(t('Could not open the file picker'))
      return
    }
    const picked: PickedLocalEntry[] = res.data ?? []
    const imageFiles: File[] = []
    const byPath: AttachedPath[] = []
    for (const entry of picked) {
      if (entry.image && images.length + imageFiles.length < MAX_IMAGES) {
        const name = entry.path.split(/[\\/]/).pop() || 'image'
        imageFiles.push(base64ToFile(entry.image.data, name, entry.image.mediaType))
      } else {
        byPath.push({ path: entry.path, isDirectory: entry.isDirectory })
      }
    }
    addPaths(byPath)
    if (imageFiles.length > 0) await addImages(imageFiles)
    textareaRef.current?.focus()
  }

  const handleAttachMenuToggle = () => {
    if (showAttachMenu) {
      closeAttachMenu('outside')
      return
    }
    if (isHomeComposer) trackHome('home.composer.attach', { action: 'open' })
    openAttachMenu()
  }

  const trackMentionOpen = (type?: MentionTelemetryType) => {
    if (isHomeComposer) trackHomeThrottled('mention-open', 1000, 'home.composer.mention', { action: 'open', type })
  }

  /**
   * Types the "@" for the user and opens the menu — mouse-only users get
   * there from the "+" menu, and see the "@" appear in the box, which teaches
   * the shortcut on the way. Deliberately not a separate picker: both "+"
   * entries land in this one menu, so the kinds can never drift apart into
   * two pickers with their own filtering and keyboard behavior.
   */
  const handleOpenMentionMenu = (via: 'digital_human' | 'conversation') => {
    if (isHomeComposer) trackHome('home.composer.attach', { action: via })
    trackMentionOpen(via)
    setShowAttachMenu(false)
    const cursor = textareaRef.current?.selectionStart ?? content.length
    const before = content.slice(0, cursor)
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
    const insertText = `${needsLeadingSpace ? ' ' : ''}@`
    const nextContent = before + insertText + content.slice(cursor)
    const nextCursor = cursor + insertText.length

    setContent(nextContent)
    setMentionMenuOpen(true)
    setMentionFilesOnly(false)
    setMentionSelectedIndex(0)

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(nextCursor, nextCursor)
        setCursorPos(nextCursor)
      }
    })
  }

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
    }
  }, [displayContent])

  // Focus on mount
  useEffect(() => {
    if (!isGenerating && !isOnboardingSendStep) {
      textareaRef.current?.focus()
    }
  }, [isGenerating, isOnboardingSendStep])

  // Slash-command helpers

  // Upper bound on filter length: the longest command label (e.g. "compact" = 7).
  // Computed once per commands list change — used to short-circuit onChange cheaply.
  const maxCommandLen = useMemo(
    () => slashCommands.reduce((max, c) => Math.max(max, c.label.length), 0),
    [slashCommands]
  )

  // `slashFilter` is the text typed after "/" — drives filtering and menu visibility.
  const slashFilter = slashMenuOpen && content.startsWith('/') ? content.slice(1) : ''

  // Pre-filtered, pre-sorted list — single source of truth for rendering and keyboard nav.
  // Only computed when the menu is open; returns [] otherwise (zero cost when closed).
  // A prefill override bypasses the session-derived list entirely (see its
  // declaration above for why).
  const filteredSlashCommands = useMemo(
    () => slashPreviewOverride
      ? [slashPreviewOverride]
      : (slashMenuOpen ? filterSlashCommands(slashCommands, slashFilter) : []),
    [slashCommands, slashFilter, slashMenuOpen, slashPreviewOverride]
  )

  // Depends on cursorPos, not just content, so moving the caret alone re-evaluates the match
  const mentionMatch = useMemo(
    () => getMentionMatch(content, cursorPos),
    [content, cursorPos]
  )

  // Ranked file matches, queried from the space's path index while the menu is open
  const {
    items: filteredMentionArtifacts,
    indexing: mentionFilesIndexing,
    available: mentionFilesAvailable,
  } = useFileMentionQuery(
    mentionSpaceId,
    mentionMatch?.query.trim() ?? '',
    mentionMenuOpen,
    MENTION_FILE_LIMIT
  )
  const mentionMenuVisible = mentionMenuOpen && (!mentionFilesOnly || mentionFilesAvailable)

  // A files-only menu counts as opened once it actually shows
  useEffect(() => {
    if (mentionMenuOpen && mentionFilesOnly && mentionFilesAvailable) trackMentionOpen()
  }, [mentionFilesAvailable]) // rising edge only; the other flags are read, not watched

  // A bare "@" deliberately lists everything (see mentionMenuDecision.ts), a
  // typed query narrows it. Matching logic lives there, shared with the
  // open/close decision below so the two can never disagree.
  const filteredMentionConversations = useMemo(() => {
    if (!mentionMenuOpen) return []
    return decideConversationMentionCandidates({
      query: mentionMatch?.query ?? '',
      conversations: mentionConversations,
    }).candidates
  }, [mentionConversations, mentionMatch, mentionMenuOpen])

  // A locked selector (generating, or messages queued) drops the people group
  // rather than the whole menu — files and conversations stay referenceable
  // mid-turn, while switching recipient stays impossible by every route.
  const filteredDigitalHumans = useMemo(() => {
    if (!mentionMenuOpen || !digitalHumanSelector || digitalHumanSelector.locked) return []
    const query = mentionMatch?.query.trim().toLowerCase() ?? ''
    const options = digitalHumanSelector.options
    return query ? options.filter(o => o.name.toLowerCase().includes(query)) : options
  }, [mentionMenuOpen, digitalHumanSelector, mentionMatch])

  // Menu order: people come first, since "@" reads as addressing someone
  // before it reads as pointing at something. Empty groups are dropped so a
  // heading never appears over nothing.
  const mentionGroups = useMemo<MentionGroup[]>(() => {
    const byKind: MentionCandidate[][] = [
      filteredDigitalHumans.map((option): MentionCandidate => ({
        kind: 'digitalHuman',
        key: `digital-human:${option.appId}`,
        text: null,
        appId: option.appId,
        name: option.name,
        paused: option.status === 'paused',
      })),
      filteredMentionConversations.map((conversation): MentionCandidate => ({
        kind: 'conversation',
        key: `conversation:${conversation.id}`,
        text: formatConversationReference(conversation.title, conversation.id),
        conversation,
      })),
      filteredMentionArtifacts.map((artifact): MentionCandidate => ({
        kind: 'artifact',
        key: `artifact:${artifact.path}:${artifact.type}`,
        text: formatArtifactReference(artifact.relativePath),
        artifact,
      })),
    ]

    const browsing = !mentionMatch?.query.trim()
    const groups: MentionGroup[] = []
    let startIndex = 0
    for (const all of byKind) {
      if (all.length === 0) continue
      const candidates = browsing ? all.slice(0, MENTION_GROUP_PREVIEW_LIMIT) : all
      groups.push({ kind: all[0].kind, candidates, truncated: candidates.length < all.length, startIndex })
      startIndex += candidates.length
    }
    return groups
  }, [filteredDigitalHumans, filteredMentionConversations, filteredMentionArtifacts, mentionMatch])

  // Flat view of the same rows — keyboard navigation walks one list across
  // group boundaries, so it can never disagree with what is rendered.
  const mentionCandidates = useMemo<MentionCandidate[]>(
    () => mentionGroups.flatMap(group => group.candidates),
    [mentionGroups]
  )

  const handleSlashClose = () => {
    setSlashMenuOpen(false)
    setSlashSelectedIndex(0)
  }

  const handleMentionClose = () => {
    setMentionMenuOpen(false)
    setMentionSelectedIndex(0)
  }

  const insertMention = (mentionText: string) => {
    const currentCursor = textareaRef.current?.selectionStart ?? content.length
    const match = getMentionMatch(content, currentCursor)
    if (!match) return

    const suffix = content.slice(match.end)
    const needsTrailingSpace = suffix.length === 0 || !/^\s/.test(suffix)
    const nextContent = `${content.slice(0, match.start)}${mentionText}${needsTrailingSpace ? ' ' : ''}${suffix}`
    const nextCursor = content.slice(0, match.start).length + mentionText.length + (needsTrailingSpace ? 1 : 0)

    setContent(nextContent)
    mentionInsertedRef.current = true
    handleMentionClose()

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(nextCursor, nextCursor)
        setCursorPos(nextCursor)
      }
    })
  }

  /**
   * Picking a digital human removes the "@query" span entirely — the only
   * effect is switching who this message goes to, which the selector chip
   * already shows, so leaving text behind would say it twice.
   *
   * It always starts a fresh session: "@" is "start talking to X", distinct
   * from the selector's "open X's existing conversation".
   */
  const selectDigitalHumanMention = async (appId: string) => {
    const currentCursor = textareaRef.current?.selectionStart ?? content.length
    const match = getMentionMatch(content, currentCursor)
    if (!match) return

    const prefix = content.slice(0, match.start)
    const nextCursor = prefix.length

    setContent(`${prefix}${content.slice(match.end)}`)
    handleMentionClose()

    const conversationId = await startDigitalHumanConversation(appId)
    if (conversationId) digitalHumanSelector?.onChange(appId, conversationId)

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(nextCursor, nextCursor)
        setCursorPos(nextCursor)
      }
    })
  }

  /** One entry point for the menu, so every kind stays keyboard- and click-equal. */
  const selectMentionCandidate = (candidate: MentionCandidate) => {
    // Shown so the user knows it exists, but its AI could not reach it.
    if (candidate.kind === 'conversation' && candidate.conversation.unavailable) return
    if (isHomeComposer) trackHome('home.composer.mention', { action: 'select', type: MENTION_TELEMETRY_TYPE[candidate.kind] })
    if (candidate.kind === 'digitalHuman') void selectDigitalHumanMention(candidate.appId)
    else insertMention(candidate.text)
  }

  const handleSlashSelect = (item: SlashCommandItem) => {
    if (isHomeComposer) {
      // Command names are never sent: non-skill commands include user-defined ones.
      trackHome('home.composer.slash', { action: 'select', kind: item.category })
    }
    // A command is not a goal.
    if (goalMode) goal?.exit()
    const newContent = item.command + ' '
    setContent(newContent)
    setSlashMenuOpen(false)
    setSlashSelectedIndex(0)
    // Resize textarea to fit the new (short) content and restore focus
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 180)}px`
        textareaRef.current.focus()
        // Place cursor at the end
        const len = textareaRef.current.value.length
        textareaRef.current.setSelectionRange(len, len)
      }
    })
  }

  const trackSend = (text: string, sentImages: ImageAttachment[], isInject: boolean) => {
    const origin = composerOriginRef.current
    const mentioned = mentionInsertedRef.current
    composerOriginRef.current = null
    mentionInsertedRef.current = false
    // The onboarding send is a scripted demo, not a real turn.
    if (!digitalHumanSelector || isOnboardingSendStep) return
    const appId = digitalHumanSelector.current ?? undefined
    trackHome('home.composer.send', {
      source: origin?.source ?? (text.startsWith('/') ? 'slash' : mentioned ? 'mention' : 'manual'),
      chip: origin?.source === 'chip' ? origin.chip : undefined,
      recipient: appId ? 'digital_human' : 'halo',
      appId,
      hasImages: sentImages.length > 0,
      imageCount: sentImages.length,
      isInject,
      lenBucket: lenBucket(text.length),
      entry: takeEntry(),
    })
  }

  // Handle send — routes to inject path when generation is in progress
  const handleSend = () => {
    if (uploading) return
    const textToSend = isOnboardingSendStep ? onboardingPrompt : content.trim()
    // Sending means the writing is done: comments still open in the content go in as written.
    commitCommentEdits(referenceKey)
    const referenceCount = useComposerReferencesStore.getState().drafts.get(referenceKey)?.length ?? 0
    // Resolving false (or failing) means nothing went out: what was taken comes back, in order.
    const handBackIfRefused = (result: unknown, sentImages: ImageAttachment[], sentReferences: ContentReference[], inject: boolean) => {
      if (!draftKey || !(result instanceof Promise)) return
      const key = draftKey
      const restoreDraft = () => {
        const recoveryKey = currentDraftKey.current ?? key
        const saved = inputDrafts.get(recoveryKey)
        const restored = {
          content: saved?.content || textToSend,
          images: saved?.images.length ? saved.images : sentImages,
        }
        inputDrafts.set(recoveryKey, restored)
        useComposerReferencesStore.getState().restore(recoveryKey, sentReferences)
        draftRecoverySubscribers.get(recoveryKey)?.forEach(listener => listener(restored))
      }
      void result.then(accepted => {
        if (accepted === false) restoreDraft()
      }).catch(error => {
        console.warn('[InputArea] Send failed', { draftKey: key, inject, error })
        restoreDraft()
      })
    }

    if (isGenerating && !goalMode) {
      // Mid-turn inject: text and cards (no images, no thinking toggle)
      if ((textToSend || referenceCount > 0) && onInject) {
        trackSend(textToSend, [], true)
        const injected = useComposerReferencesStore.getState().take(referenceKey)
        handBackIfRefused(onInject(textToSend, injected.length > 0 ? injected : undefined), [], injected, true)
        setContent('')
        if (draftKey) useChatStore.getState().clearComposerDraft(draftKey)
        handleMentionClose()
        handleSlashClose()
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
      }
      return
    }

    const hasContent = goalMode ? goal!.canSubmit(textToSend) : (textToSend || images.length > 0 || referenceCount > 0)
    if (hasContent) {
      // A goal set mid-turn goes to the running turn, not a new message, so attachments wait for the next one.
      const keepImages = goalMode && isGenerating
      const sentImages = keepImages ? [] : images
      // The onboarding send is a scripted demo: the cards stay for a real message.
      const sentReferences = keepImages || isOnboardingSendStep ? [] : useComposerReferencesStore.getState().take(referenceKey)
      trackSend(textToSend, sentImages, false)
      const result = goalMode
        ? goal!.submit(textToSend, sentImages.length > 0 ? sentImages : undefined, THINKING_ENABLED, sentReferences)
        : onSend(
          textToSend,
          sentImages.length > 0 ? sentImages : undefined,
          THINKING_ENABLED,
          sentReferences.length > 0 ? { references: sentReferences } : undefined,
        )
      if (draftKey) inputDrafts.delete(draftKey)
      handBackIfRefused(result, sentImages, sentReferences, false)

      if (!isOnboardingSendStep) {
        setContent('')
        if (draftKey) useChatStore.getState().clearComposerDraft(draftKey)
        if (!keepImages) setImages([])
        handleMentionClose()
        handleSlashClose()
        // Reset height
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
        }
      }
    }
  }

  // Detect mobile device (touch + narrow screen)
  const isMobile = () => {
    return 'ontouchstart' in window && window.innerWidth < 768
  }

  // Handle key press
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Ignore key events during IME composition (Chinese/Japanese/Korean input)
    // This prevents Enter from sending the message while confirming IME candidates
    if (e.nativeEvent.isComposing) return

    // ── @ mention menu navigation ───────────────────────────────────────────────
    if (mentionMenuVisible && mentionCandidates.length > 0) {
      const mLen = mentionCandidates.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionSelectedIndex(i => (i + 1) % mLen)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionSelectedIndex(i => (i - 1 + mLen) % mLen)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        const selected = mentionCandidates[mentionSelectedIndex]
        if (selected) selectMentionCandidate(selected)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        handleMentionClose()
        return
      }
    }

    // ── Slash-command menu navigation ─────────────────────────────────────────
    // filteredSlashCommands is already computed by useMemo — no extra filtering here.
    if (slashMenuOpen && filteredSlashCommands.length > 0) {
      const filteredLen = filteredSlashCommands.length

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSelectedIndex((i) => (i + 1) % filteredLen)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSelectedIndex((i) => (i - 1 + filteredLen) % filteredLen)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        if (filteredSlashCommands[slashSelectedIndex]) {
          handleSlashSelect(filteredSlashCommands[slashSelectedIndex])
        }
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        if (filteredSlashCommands[slashSelectedIndex]) {
          handleSlashSelect(filteredSlashCommands[slashSelectedIndex])
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        handleSlashClose()
        return
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // A panel the AI opened leaves the keyboard here: Esc closes it rather than stopping the turn.
    if (showAttachMenu && e.key === 'Escape') {
      e.preventDefault()
      setShowAttachMenu(false)
      return
    }

    // Leaving goal mode keeps the text as an ordinary draft. Esc here never
    // stops a running turn; a second Esc, outside goal mode, does.
    if (goalMode && (e.key === 'Escape' || (e.key === 'Backspace' && content === ''))) {
      e.preventDefault()
      e.stopPropagation()
      goal?.exit()
      return
    }

    // Mobile: send via button only
    // PC: respect sendKeyMode setting
    if (!isMobile()) {
      if (sendKeyMode === 'ctrl-enter') {
        // Ctrl+Enter to send, Enter for new line
        if (e.key === 'Enter' && e.ctrlKey) {
          e.preventDefault()
          handleSend()
        }
      } else {
        // Enter to send, Shift+Enter for new line
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          handleSend()
        }
      }
    }
    // Esc to stop
    if (e.key === 'Escape' && isGenerating && onStop) {
      e.preventDefault()
      onStop()
    }
  }

  // In onboarding mode, can always send (prefilled content)
  // Can send if has text, images or references — a comment still being written counts (and not processing images)
  // During generation (inject mode): text and references, no images
  const hasReferences = references.length > 0 || writingComment
  const canSend = isOnboardingSendStep ||
    (goalMode
      ? (goal!.canSubmit(content) && !isProcessingImages && !uploading)
      : isGenerating
        ? ((content.trim().length > 0 || hasReferences) && !!onInject && !uploading)
        : ((content.trim().length > 0 || images.length > 0 || hasReferences) && !isProcessingImages && !uploading)
    )
  const hasImages = images.length > 0
  const cardRadius = standalone ? 'rounded-[22px]' : 'rounded-[18px]'

  const closeAttachMenu = useCallback((reason: 'select' | 'escape' | 'outside') => {
    setShowAttachMenu(false)
    if (reason === 'escape') textareaRef.current?.focus()
  }, [])

  const digitalHumanBlockedReason = !digitalHumanSelector || digitalHumanSelector.options.length === 0
    ? t('No digital humans in this space yet')
    : digitalHumanSelector.locked
      ? t('Switch recipient after the current reply finishes')
      : null
  const conversationBlockedReason = mentionConversations.length === 0 ? t('No other conversations in this space yet') : null
  const attachedCount = images.length + references.filter(ref => ref.source.kind === 'path').length

  // Add → things this message carries; Context → where the work points;
  // Capabilities → what the AI may use. Unavailable rows stay visible and say why.
  const menuSections: ComposerMenuSection[] = [
    {
      id: 'add',
      title: t('Add'),
      items: [{
        id: 'files',
        icon: <Paperclip size={16} />,
        label: canAttachLocalPaths ? t('Files and folders') : t('Files'),
        description: canAttachLocalPaths
          ? t('Attach from this computer; AI reads them where they are')
          : t('Upload from this device into the space; images go to the AI directly'),
        meta: attachedCount > 0 ? String(attachedCount) : undefined,
        disabledReason: isProcessingImages ? t('Processing image...') : null,
        onSelect: () => void handleAttachClick(),
      }],
    },
    {
      id: 'context',
      title: t('Context'),
      items: [
        ...(goal ? [{
          id: 'goal',
          icon: <Target size={16} />,
          label: goal.menuItem.label,
          description: goal.menuItem.description,
          onSelect: goal.menuItem.onSelect,
        }] : []),
        {
          id: 'conversation',
          icon: <MessagesSquare size={16} />,
          label: t('Reference a conversation'),
          description: t('Let AI read another conversation, or message it directly'),
          disabledReason: conversationBlockedReason,
          onSelect: () => handleOpenMentionMenu('conversation'),
        },
        {
          id: 'digital-human',
          icon: <Bot size={16} />,
          label: t('Chat with a digital human'),
          description: t('Hand this message to one of your digital humans'),
          disabledReason: digitalHumanBlockedReason,
          onSelect: () => handleOpenMentionMenu('digital_human'),
        },
      ],
    },
    ...(toolsets.list.length > 0 ? [{
      id: 'capabilities',
      title: t('Capabilities'),
      items: sortToolsets(toolsets.list).map(ts => ({
        id: `toolset:${ts.id}`,
        icon: toolsetIcon(ts.id),
        label: toolsetLabel(t, ts),
        description: toolsetDescription(t, ts),
        toggle: { checked: ts.open, onChange: () => toolsets.toggle(ts) },
        attention: toolsets.requested.has(ts.id) && !ts.open,
      })),
    }] : []),
  ]
  // While a turn runs nothing can be attached; capabilities can change, from the next message on.
  const panelSections = isGenerating ? menuSections.filter(section => section.id === 'capabilities') : menuSections

  return (
    <div className={`
      ${standalone ? '' : isCompact ? 'border-t border-border/50 bg-background' : 'bg-gradient-to-b from-transparent to-background'}
      transition-[padding] duration-300 ease-out
      ${standalone ? '' : isCompact ? 'px-3 py-2' : 'pt-3 px-6 pb-[18px]'}
    `}>
      <div className={standalone ? '' : isCompact ? '' : 'max-w-chat mx-auto'}>
        {/* Error toast notification */}
        {imageError && (
          <div className="mb-2 p-3 rounded-xl bg-destructive/10 border border-destructive/20
            flex items-start gap-2 animate-fade-in">
            <AlertCircle size={16} className="text-destructive mt-0.5 flex-shrink-0" />
            <span className="text-sm text-destructive flex-1">{imageError.message}</span>
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
        />

        {/* Live AI sessions — capsule tab adhered to the input's top-left edge.
            Sibling above the input card; the input box itself is untouched. */}
        <LiveSessionsHeader />

        {/* Inset past the card's corner radius so the shelf sits on its straight top edge. */}
        {goal && <div className={standalone ? 'mx-6' : 'mx-5'}>{goal.shelf}</div>}

        {/* Input container — radius kept at the prototype's literal values
            (its own core visual feature, not on the 8/10/12/16 scale):
            22px centered/standalone, 18px once docked at the bottom. */}
        <div
          ref={cardRef}
          className={`
            relative flex flex-col border bg-card shadow-soft
            transition-colors ease-halo
            ${cardRadius}
            border-border ${isFocused ? 'ring-[3px] ring-primary/[0.12]' : ''}
            ${isDragOver ? 'ring-2 ring-primary/50 bg-primary/5' : ''}
          `}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {/* Slash-command autocomplete menu — floats above the input box.
              Only rendered when there are actual matches; no empty-state UI. */}
          {showAttachMenu && !isOnboardingSendStep && panelSections.length > 0 && (
            <ComposerMenu
              // Rows come and go when a turn ends; a fresh panel keeps the keyboard highlight on the right row.
              key={isGenerating ? 'turn-running' : 'idle'}
              sections={panelSections}
              takeFocus={!attachMenuByRequest}
              anchorRef={cardRef}
              triggerRef={plusTriggerRef}
              onClose={closeAttachMenu}
              radiusClassName={cardRadius}
            />
          )}
          {slashMenuOpen && filteredSlashCommands.length > 0 && (
            <SlashCommandMenu
              radiusClassName={cardRadius}
              items={filteredSlashCommands}
              selectedIndex={slashSelectedIndex}
              onSelect={handleSlashSelect}
              onClose={handleSlashClose}
            />
          )}
          {/* @ mention autocomplete menu — one menu, one keyboard model, one
              row shell; only the row content differs per candidate kind. */}
          {mentionMenuVisible && mentionCandidates.length > 0 && (
            <div className={`absolute bottom-full -inset-x-px mb-2 bg-popover border border-border/70 ${cardRadius} shadow-soft z-30 overflow-hidden animate-composer-rise`}>
              <div className="max-h-[336px] overflow-y-auto py-1 scrollbar-thin">
                {mentionGroups.map(group => (
                  <div key={group.kind}>
                    {/* "More exists" rides on the heading rather than a line
                        of its own: stacked under the last row it read as a
                        second heading for the group below it. */}
                    <div className="px-3 pt-2 pb-1 flex items-baseline justify-between gap-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/60 select-none">
                      <span className="truncate">{mentionGroupLabel(group.kind, t)}</span>
                      {group.truncated && (
                        <span className="shrink-0 normal-case font-normal tracking-normal text-muted-foreground/40">
                          {t('Type to see more')}
                        </span>
                      )}
                    </div>
                    {group.candidates.map((candidate, indexInGroup) => {
                      const isSelected = group.startIndex + indexInGroup === mentionSelectedIndex
                      return (
                        <button
                          key={candidate.key}
                          onMouseDown={(e) => {
                            e.preventDefault()
                            selectMentionCandidate(candidate)
                          }}
                          aria-disabled={candidate.kind === 'conversation' && candidate.conversation.unavailable ? true : undefined}
                          className={`w-full flex items-center gap-2 text-left min-h-[38px] py-1 border-l-2 ${isSelected ? 'bg-primary/10 border-primary pl-2.5 pr-3' : 'border-transparent pl-2.5 pr-3 hover:bg-muted/50'}`}
                        >
                          {candidate.kind === 'digitalHuman' ? (
                            <>
                              {/* Same generated face as the recipient chip and
                                  the people directory — a name alone made this
                                  the only kind of row with nothing to look at. */}
                              <span className="shrink-0 w-7 h-7 flex items-center justify-center overflow-hidden rounded-lg">
                                <AutomationAvatar name={candidate.name} size={28} />
                              </span>
                              <span className="text-sm truncate flex-1 min-w-0">{candidate.name}</span>
                              {candidate.paused && (
                                <span className="shrink-0 text-[10px] text-muted-foreground">{t('Paused')}</span>
                              )}
                            </>
                          ) : candidate.kind === 'conversation' ? (
                            <ConversationMentionRow candidate={candidate.conversation} />
                          ) : (
                            <>
                              <span className="text-xs font-medium text-primary/80 shrink-0">
                                {candidate.artifact.type === 'folder' ? t('Folder') : t('File')}
                              </span>
                              <span className="text-sm truncate flex-1 min-w-0">{candidate.artifact.relativePath}</span>
                            </>
                          )}
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
              <div className="border-t border-border/40 px-3 py-1.5 flex items-center gap-3 text-[10px] text-muted-foreground/40 select-none">
                <span>↑↓ {t('navigate')}</span>
                <span>↵ {t('select')}</span>
                <span>Esc {t('close')}</span>
                {mentionFilesIndexing && <span className="ml-auto">{t('Indexing files…')}</span>}
              </div>
            </div>
          )}
          {/* Stays open with zero matches: a silently empty "@" is
              indistinguishable from the keystroke not registering. */}
          {mentionMenuVisible && mentionCandidates.length === 0 && (
            <div className={`absolute bottom-full -inset-x-px mb-2 bg-popover border border-border/70 ${cardRadius} shadow-soft z-30 overflow-hidden animate-composer-rise`}>
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                {mentionFilesIndexing ? t('Indexing files…') : t('No matching results found')}
              </div>
            </div>
          )}
          {/* Image preview area */}
          {hasImages && (
            <>
              <ImageAttachmentPreview
                images={images}
                onRemove={removeImage}
              />
              {!visionEnabled && (
                <div className="px-4 py-1.5 text-xs text-muted-foreground border-b border-border/30">
                  {t('Current model has no vision — images will be read via local OCR (text only)')}
                </div>
              )}
            </>
          )}

          {/* Image processing indicator */}
          {isProcessingImages && (
            <div className="px-4 py-2 flex items-center gap-2 text-xs text-muted-foreground border-b border-border/30">
              <Loader2 size={14} className="animate-spin" />
              <span>{t('Processing image...')}</span>
            </div>
          )}
          {uploading && (
            <div className="px-4 py-2 flex items-center gap-2 text-xs text-muted-foreground border-b border-border/30">
              <Loader2 size={14} className="animate-spin" />
              <span>{t('Uploading {{count}} file(s)...', { count: uploadingCount })}</span>
            </div>
          )}

          {/* Drag overlay */}
          {isDragOver && (
            <div className="absolute inset-0 flex items-center justify-center
              bg-primary/5 rounded-2xl border-2 border-dashed border-primary/30
              pointer-events-none z-10">
              <div className="flex flex-col items-center gap-2 text-primary/70">
                <Paperclip size={22} />
                <span className="text-sm font-medium">
                  {canAttachLocalPaths ? t('Drop files or folders to attach') : t('Drop files to attach')}
                </span>
              </div>
            </div>
          )}

          {/* References and attached files, on the same layer as the goal chip. */}
          <ComposerReferenceChips composerKey={referenceKey} references={references} baseDir={spaceRoot} className="px-3.5 pt-2.5" />
          {goalMode && goal.chip}

          {/* Textarea area */}
          <div className="px-4 pt-3.5">
            <textarea
              ref={textareaRef}
              value={displayContent}
              onChange={(e) => {
                if (isOnboardingSendStep) return
                const val = e.target.value
                setContent(val)
                if (!val) {
                  composerOriginRef.current = null
                  mentionInsertedRef.current = false
                }
                // Real typing always falls back to the session's live command
                // list — a stale prefill preview shouldn't keep overriding it.
                setSlashPreviewOverride(null)
                // Open slash-command menu only when the input is a plausible command prefix.
                // Short-circuits before any filter computation via maxCommandLen:
                //   • starts with "/"
                //   • no spaces or newlines (file paths, multi-line text are not commands)
                //   • at most as long as the longest known command
                const afterSlash = val.slice(1)
                const looksLikeCommand =
                  slashCommands.length > 0 &&
                  val.startsWith('/') &&
                  !afterSlash.includes(' ') &&
                  !afterSlash.includes('\n') &&
                  afterSlash.length <= maxCommandLen
                if (looksLikeCommand) {
                  if (!slashMenuOpen && isHomeComposer) {
                    trackHomeThrottled('slash-open', 1000, 'home.composer.slash', { action: 'open' })
                  }
                  setSlashMenuOpen(true)
                  setSlashSelectedIndex(0)
                  setMentionMenuOpen(false)
                } else {
                  setSlashMenuOpen(false)
                }

                const nextCursor = e.target.selectionStart ?? val.length
                setCursorPos(nextCursor)
                const nextMentionMatch = getMentionMatch(val, nextCursor)
                // Opens when any kind has something to offer; the per-kind
                // availability rules mirror the filtered lists above.
                const query = nextMentionMatch?.query ?? ''
                const hasPeople = !!digitalHumanSelector && !digitalHumanSelector.locked
                  && digitalHumanSelector.options.some(o => !query || o.name.toLowerCase().includes(query.trim().toLowerCase()))
                const hasConversations = decideConversationMentionCandidates({ query, conversations: mentionConversations }).shouldOpenMenu
                if (nextMentionMatch && (hasPeople || hasConversations || !!mentionSpaceId)) {
                  const filesOnly = !hasPeople && !hasConversations
                  if (!mentionMenuOpen && !filesOnly) trackMentionOpen()
                  setMentionFilesOnly(filesOnly)
                  setMentionMenuOpen(true)
                  setMentionSelectedIndex(0)
                } else {
                  setMentionMenuOpen(false)
                }
              }}
              onSelect={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              // No greeting lead-in here — the full-takeover empty state
              // already has "What do you want to do today?" as an h2 right
              // above the composer; repeating it in the placeholder was pure
              // redundancy the docked (post-first-message) state inherits
              // the same placeholder for, since it's the same InputArea
              // instance either way.
              placeholder={goalMode ? goal.placeholder : placeholder || t('@ for digital humans, files and conversations, / for skills and commands')}
              readOnly={isOnboardingSendStep}
              rows={1}
              className={`w-full bg-transparent resize-none text-[15px] leading-[1.5]
                focus:outline-none text-foreground placeholder:text-subtle-foreground
                disabled:cursor-not-allowed min-h-[26px]
                ${isOnboardingSendStep ? 'cursor-default' : ''}`}
              style={{ maxHeight: '180px' }}
            />
          </div>

          {/* Bottom toolbar - always visible, industry standard layout */}
          <InputToolbar
            isGenerating={isGenerating}
            isOnboarding={isOnboardingSendStep}
            canOpenMenu={panelSections.length > 0}
            showAttachMenu={showAttachMenu}
            onAttachMenuToggle={handleAttachMenuToggle}
            plusTriggerRef={plusTriggerRef}
            extraToolsets={toolsets.extraEnabled}
            canSend={canSend}
            onSend={handleSend}
            onStop={onStop}
            sendKeyMode={sendKeyMode}
            toolbarSlot={toolbarSlot}
            sendSlot={sendSlot}
            hideKnowledgeControls={hideKnowledgeControls}
            digitalHumanSelector={digitalHumanSelector}
            sendTitle={goalMode ? goal.sendTitle : undefined}
          />
        </div>
      </div>
    </div>
  )
})

/**
 * Input Toolbar - Bottom action bar
 *
 * Layout: [recipient] [+] [extra capabilities] [thinking] [knowledge] ──── [send]
 */
interface InputToolbarProps {
  toolbarSlot?: React.ReactNode
  sendSlot?: React.ReactNode
  isGenerating: boolean
  isOnboarding: boolean
  /** Whether the "+" panel has rows now: while a turn runs, only capability switches. */
  canOpenMenu: boolean
  showAttachMenu: boolean
  onAttachMenuToggle: () => void
  plusTriggerRef: React.RefObject<HTMLButtonElement>
  /** Capabilities on beyond the defaults — the only toolset state shown at rest. */
  extraToolsets: ToolsetStatus[]
  canSend: boolean
  onSend: () => void
  onStop?: () => void
  sendKeyMode: 'enter' | 'ctrl-enter'
  hideKnowledgeControls: boolean
  digitalHumanSelector?: DigitalHumanSelectorConfig
  /** Overrides the Send tooltip, e.g. while Send sets a goal. */
  sendTitle?: string
}

function InputToolbar({
  toolbarSlot,
  sendSlot,
  isGenerating,
  isOnboarding,
  canOpenMenu,
  showAttachMenu,
  onAttachMenuToggle,
  plusTriggerRef,
  extraToolsets,
  canSend,
  onSend,
  onStop,
  sendKeyMode,
  hideKnowledgeControls,
  digitalHumanSelector,
  sendTitle
}: InputToolbarProps) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-nowrap items-center justify-between gap-1 px-4 pb-2.5 mt-2">
      {/* Left section, ordered by how often a control is reached for:
          the "+" menu and the per-turn toggles sit inboard, and knowledge —
          a one-off binding, not a per-message decision — sits outermost.
          Scrolls horizontally on narrow widths so the fixed Send/Stop group
          is never pushed off. */}
      <div className="flex flex-nowrap items-center gap-1 min-w-0 overflow-x-auto scrollbar-none">
        {/* Renders only while a digital human is selected — see its own docs. */}
        {digitalHumanSelector && !isOnboarding && (
          <DigitalHumanSelector {...digitalHumanSelector} />
        )}

        {canOpenMenu && !isOnboarding && (
          <button
            ref={plusTriggerRef}
            type="button"
            onClick={onAttachMenuToggle}
            aria-label={isGenerating ? t('Capabilities') : t('Add files, context and capabilities')}
            aria-haspopup="menu"
            aria-expanded={showAttachMenu}
            title={isGenerating ? t('Capabilities') : t('Add files, context and capabilities')}
            className={`w-8 h-8 shrink-0 flex items-center justify-center rounded-full transition-colors duration-150
              ${showAttachMenu
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
              }`}
          >
            <Plus size={18} className={`transition-transform duration-200 ease-halo ${showAttachMenu ? 'rotate-45' : ''}`} />
          </button>
        )}

        {/* Quiet reminder of capabilities turned on beyond the defaults; opens the panel. */}
        {!isGenerating && !isOnboarding && extraToolsets.length > 0 && (
          <button
            type="button"
            onClick={onAttachMenuToggle}
            title={extraToolsets.map(ts => toolsetLabel(t, ts)).join(', ')}
            aria-label={t('Capabilities on: {{names}}', { names: extraToolsets.map(ts => toolsetLabel(t, ts)).join(', ') })}
            className="h-8 shrink-0 flex items-center gap-1.5 px-2 rounded-full text-muted-foreground
              hover:text-foreground hover:bg-secondary transition-colors duration-150"
          >
            {extraToolsets.map(ts => (
              <span key={ts.id} className="inline-flex">{toolsetIcon(ts.id, 15)}</span>
            ))}
          </button>
        )}

        {/* Knowledge base loader */}
        {!isGenerating && !isOnboarding && !hideKnowledgeControls && <KnowledgeBaseButton />}

        {toolbarSlot && <div className="shrink-0">{toolbarSlot}</div>}
      </div>

      {/* Right section: Stop (when generating) + Send — fixed, never scrolls */}
      <div className="flex flex-nowrap items-center gap-1 shrink-0">
        {sendSlot && !isOnboarding && <div className="flex items-center">{sendSlot}</div>}
        {isGenerating && onStop && (
          <button
            onClick={onStop}
            className="w-8 h-8 flex items-center justify-center
              bg-destructive/10 text-destructive rounded-sm
              hover:bg-destructive/20 active:bg-destructive/30
              transition-all duration-150"
            title={t('Stop generation (Esc)')}
          >
            <div className="w-3 h-3 border-2 border-current rounded-sm" />
          </button>
        )}
        {!isOnboarding && (
          <button
            data-onboarding="send-button"
            onClick={onSend}
            disabled={!canSend}
            className={`
              w-[34px] h-[34px] flex items-center justify-center rounded-full transition-all ease-halo
              ${canSend
                ? 'bg-primary text-primary-foreground hover:bg-primary-hover hover:-translate-y-[1px] active:scale-95'
                : 'bg-muted/50 text-muted-foreground/40 cursor-not-allowed'
              }
            `}
            title={
              sendTitle ? sendTitle
              : isGenerating
                ? t('Add to queue')
                : sendKeyMode === 'ctrl-enter'
                  ? t('Send — Ctrl+Enter')
                  : t('Send — Enter')
            }
          >
            <svg className="w-[17px] h-[17px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 10.5L12 3m0 0l7.5 7.5M12 3v18" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}

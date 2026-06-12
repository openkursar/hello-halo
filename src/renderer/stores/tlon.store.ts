/**
 * Tlon Store
 *
 * Manages the Tlon knowledge-base UI state:
 * - Knowledge base list + selection
 * - Per-KB raw files, wiki pages, index content
 * - Per-KB ingest progress (live feedback only)
 *
 * Authoritative learned/unlearned status and counts come from the
 * `listRaw` / `getIngestStatus` pulls — never from progress events.
 * Progress events drive the animated progress bar only; after every
 * event the store re-pulls `listRaw` so the per-file learned status
 * (RawFileStatus.learned) stays truthful.
 *
 * Real-time event handlers are wired from App.tsx using the imported
 * onEvent() transport (same pattern as agent/app events).
 */

import { create } from 'zustand'
import { api } from '../api'
import { useNotificationStore } from './notification.store'
import i18n from '../i18n'
import type {
  KnowledgeBaseEntry,
  RawFileStatus,
  WikiPageMeta,
  IngestProgressEvent,
  CreateKBInput,
  UpdateKBInput,
  AddRawFilesResult,
} from '../../shared/types/tlon'
import type { Conversation, Message, Thought } from '../types'

/** A single turn in a knowledge-base chat (ephemeral, not saved as history). */
export interface TlonChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  error?: boolean
}

interface TlonChatSession {
  /** Backing conversation id under the temp space (created on first send). */
  conversationId?: string
  messages: TlonChatMessage[]
  generating: boolean
  /** Live activity label shown while the agent works (from thought events). */
  status?: string
}

/** KB chats run as ephemeral conversations under the Halo temp space. */
const TLON_CHAT_SPACE = 'halo-temp'

interface TlonState {
  // ── Data ─────────────────────────────────
  kbs: KnowledgeBaseEntry[]
  selectedKBId: string | null
  /** Raw files per KB (with learned status). Keyed by kbId. */
  rawFiles: Record<string, RawFileStatus[]>
  /** Wiki pages per KB. Keyed by kbId. */
  wikiPages: Record<string, WikiPageMeta[]>
  /** index.md content per KB. Keyed by kbId. */
  indexContent: Record<string, string>
  /** Live ingest progress per KB (animation only). Keyed by kbId. */
  ingestProgress: Record<string, IngestProgressEvent>
  /** Ephemeral chat session per KB. Keyed by kbId. */
  chatSessions: Record<string, TlonChatSession>
  isLoading: boolean
  error: string | null

  // ── KB list ───────────────────────────────
  loadKBs: () => Promise<void>
  selectKB: (kbId: string | null) => void
  refreshKB: (kbId: string) => Promise<void>

  // ── KB lifecycle ──────────────────────────
  createKB: (input: CreateKBInput) => Promise<string | null>
  updateKB: (kbId: string, updates: UpdateKBInput) => Promise<boolean>
  deleteKB: (kbId: string) => Promise<boolean>
  setDefaultKB: (kbId: string | null) => Promise<void>

  // ── Binding ───────────────────────────────
  bindSpace: (kbId: string, spaceId: string) => Promise<boolean>
  unbindSpace: (kbId: string, spaceId: string) => Promise<boolean>

  // ── Linked dirs ───────────────────────────
  addLinkedDir: (kbId: string, dir: { path: string; label: string }) => Promise<boolean>
  removeLinkedDir: (kbId: string, linkId: string) => Promise<boolean>

  // ── Raw files ─────────────────────────────
  loadRawFiles: (kbId: string) => Promise<void>
  addFiles: (kbId: string, filePaths: string[]) => Promise<AddRawFilesResult | null>
  removeRawFile: (kbId: string, relativePath: string) => Promise<boolean>
  pickAndAddFiles: (kbId: string) => Promise<void>
  pickAndImportFolder: (kbId: string) => Promise<void>

  // ── Wiki ──────────────────────────────────
  loadWiki: (kbId: string) => Promise<void>
  readWikiPage: (kbId: string, pagePath: string) => Promise<string | null>

  // ── Ingest ────────────────────────────────
  triggerIngest: (kbId: string) => Promise<void>
  clearAndRelearn: (kbId: string) => Promise<boolean>
  loadIngestStatus: (kbId: string) => Promise<void>

  // ── KB chat (ephemeral) ───────────────────
  sendChatMessage: (kbId: string, text: string) => Promise<void>
  clearChat: (kbId: string) => Promise<void>
  /** Subscribe to agent events for KB chats. Returns an unsubscribe fn. */
  subscribeChatEvents: () => () => void
  /** Pull the final assistant answer after a turn completes. */
  finalizeChatTurn: (kbId: string) => Promise<void>
  /** Append an assistant error bubble and stop the generating state. */
  pushAssistantError: (kbId: string, message: string) => void

  // ── Real-time event handlers ──────────────
  /** Called by App.tsx on tlon:ingest-progress (animation only). */
  handleIngestProgress: (event: IngestProgressEvent) => void
  /** Called by App.tsx on tlon:stats-updated. */
  handleStatsUpdated: (kbId: string) => void
}

function notifyRejected(rejected: string[]) {
  if (rejected.length === 0) return
  useNotificationStore.getState().show({
    title: i18n.t('Skipped {{count}} unsupported file(s). Supported: PDF, PPTX, DOCX, XLSX, and text files.', { count: rejected.length }),
    variant: 'warning',
    duration: 5000,
  })
}

export const useTlonStore = create<TlonState>((set, get) => ({
  kbs: [],
  selectedKBId: null,
  rawFiles: {},
  wikiPages: {},
  indexContent: {},
  ingestProgress: {},
  chatSessions: {},
  isLoading: false,
  error: null,

  // ── KB list ───────────────────────────────

  loadKBs: async () => {
    set({ isLoading: true, error: null })
    try {
      const res = await api.tlon.list()
      if (res.success && res.data) {
        set({ kbs: res.data as KnowledgeBaseEntry[] })
      } else {
        set({ error: (res.error as string) || 'Failed to load knowledge bases' })
      }
    } catch (err) {
      set({ error: 'Failed to load knowledge bases' })
      console.error('[TlonStore] loadKBs error:', err)
    } finally {
      set({ isLoading: false })
    }
  },

  selectKB: (kbId) => {
    set({ selectedKBId: kbId })
    if (kbId) {
      void get().loadRawFiles(kbId)
      void get().loadWiki(kbId)
      void get().loadIngestStatus(kbId)
    }
  },

  refreshKB: async (kbId) => {
    try {
      const res = await api.tlon.get(kbId)
      if (res.success && res.data) {
        const updated = res.data as KnowledgeBaseEntry
        set(state => ({ kbs: state.kbs.map(k => k.id === kbId ? updated : k) }))
      }
    } catch (err) {
      console.error('[TlonStore] refreshKB error:', err)
    }
  },

  // ── KB lifecycle ──────────────────────────

  createKB: async (input) => {
    try {
      const res = await api.tlon.create(input)
      if (res.success && (res.data as KnowledgeBaseEntry)?.id) {
        await get().loadKBs()
        return (res.data as KnowledgeBaseEntry).id
      }
      set({ error: (res.error as string) || 'Failed to create knowledge base' })
      return null
    } catch (err) {
      console.error('[TlonStore] createKB error:', err)
      return null
    }
  },

  updateKB: async (kbId, updates) => {
    try {
      const res = await api.tlon.update(kbId, updates)
      if (res.success) {
        await get().refreshKB(kbId)
        return true
      }
      return false
    } catch (err) {
      console.error('[TlonStore] updateKB error:', err)
      return false
    }
  },

  deleteKB: async (kbId) => {
    try {
      const res = await api.tlon.delete(kbId)
      if (res.success) {
        set(state => ({
          kbs: state.kbs.filter(k => k.id !== kbId),
          selectedKBId: state.selectedKBId === kbId ? null : state.selectedKBId,
        }))
        return true
      }
      return false
    } catch (err) {
      console.error('[TlonStore] deleteKB error:', err)
      return false
    }
  },

  setDefaultKB: async (kbId) => {
    // Optimistically flip the flag (only one KB is default), then persist.
    set(state => ({
      kbs: state.kbs.map(k => ({ ...k, isDefault: k.id === kbId })),
    }))
    try {
      const res = await api.tlon.setDefault(kbId)
      if (!res.success) await get().loadKBs()
    } catch (err) {
      console.error('[TlonStore] setDefaultKB error:', err)
      await get().loadKBs()
    }
  },

  // ── Binding ───────────────────────────────

  bindSpace: async (kbId, spaceId) => {
    try {
      const res = await api.tlon.bindSpace(kbId, spaceId)
      if (res.success) {
        await get().refreshKB(kbId)
        return true
      }
      return false
    } catch (err) {
      console.error('[TlonStore] bindSpace error:', err)
      return false
    }
  },

  unbindSpace: async (kbId, spaceId) => {
    try {
      const res = await api.tlon.unbindSpace(kbId, spaceId)
      if (res.success) {
        await get().refreshKB(kbId)
        return true
      }
      return false
    } catch (err) {
      console.error('[TlonStore] unbindSpace error:', err)
      return false
    }
  },

  // ── Linked dirs ───────────────────────────

  addLinkedDir: async (kbId, dir) => {
    try {
      const res = await api.tlon.addLinkedDir(kbId, dir)
      if (res.success) {
        await get().refreshKB(kbId)
        return true
      }
      return false
    } catch (err) {
      console.error('[TlonStore] addLinkedDir error:', err)
      return false
    }
  },

  removeLinkedDir: async (kbId, linkId) => {
    try {
      const res = await api.tlon.removeLinkedDir(kbId, linkId)
      if (res.success) {
        await get().refreshKB(kbId)
        return true
      }
      return false
    } catch (err) {
      console.error('[TlonStore] removeLinkedDir error:', err)
      return false
    }
  },

  // ── Raw files ─────────────────────────────

  loadRawFiles: async (kbId) => {
    try {
      const res = await api.tlon.listRaw(kbId)
      if (res.success && res.data) {
        set(state => ({ rawFiles: { ...state.rawFiles, [kbId]: res.data as RawFileStatus[] } }))
      }
    } catch (err) {
      console.error('[TlonStore] loadRawFiles error:', err)
    }
  },

  addFiles: async (kbId, filePaths) => {
    try {
      const res = await api.tlon.addFiles(kbId, filePaths)
      if (res.success && res.data) {
        const result = res.data as AddRawFilesResult
        notifyRejected(result.rejected)
        await get().loadRawFiles(kbId)
        await get().refreshKB(kbId)
        return result
      }
      return null
    } catch (err) {
      console.error('[TlonStore] addFiles error:', err)
      return null
    }
  },

  removeRawFile: async (kbId, relativePath) => {
    try {
      const res = await api.tlon.removeRaw(kbId, relativePath)
      if (res.success) {
        await get().loadRawFiles(kbId)
        await get().refreshKB(kbId)
        return true
      }
      return false
    } catch (err) {
      console.error('[TlonStore] removeRawFile error:', err)
      return false
    }
  },

  pickAndAddFiles: async (kbId) => {
    try {
      const res = await api.tlon.pickFiles()
      if (res.success && res.data) {
        const { filePaths, canceled } = res.data as { filePaths: string[]; canceled: boolean }
        if (canceled || !filePaths || filePaths.length === 0) return
        await get().addFiles(kbId, filePaths)
      }
    } catch (err) {
      console.error('[TlonStore] pickAndAddFiles error:', err)
    }
  },

  pickAndImportFolder: async (kbId) => {
    try {
      const res = await api.tlon.pickFolder({
        title: i18n.t('Add a folder of text files'),
        buttonLabel: i18n.t('Add'),
      })
      if (res.success && res.data) {
        const { filePaths, canceled } = res.data as { filePaths: string[]; canceled: boolean }
        if (canceled || !filePaths || filePaths.length === 0) return
        await get().addFiles(kbId, filePaths)
      }
    } catch (err) {
      console.error('[TlonStore] pickAndImportFolder error:', err)
    }
  },

  // ── Wiki ──────────────────────────────────

  loadWiki: async (kbId) => {
    try {
      const [wikiRes, indexRes] = await Promise.all([
        api.tlon.listWiki(kbId),
        api.tlon.readIndex(kbId),
      ])
      if (wikiRes.success && wikiRes.data) {
        set(state => ({ wikiPages: { ...state.wikiPages, [kbId]: wikiRes.data as WikiPageMeta[] } }))
      }
      if (indexRes.success) {
        set(state => ({ indexContent: { ...state.indexContent, [kbId]: (indexRes.data as string) ?? '' } }))
      }
    } catch (err) {
      console.error('[TlonStore] loadWiki error:', err)
    }
  },

  readWikiPage: async (kbId, pagePath) => {
    try {
      const res = await api.tlon.readWiki(kbId, pagePath)
      if (res.success) return (res.data as string) ?? null
      return null
    } catch (err) {
      console.error('[TlonStore] readWikiPage error:', err)
      return null
    }
  },

  // ── Ingest ────────────────────────────────

  triggerIngest: async (kbId) => {
    try {
      // Fire-and-forget: progress arrives via the tlon:ingest-progress event.
      await api.tlon.triggerIngest(kbId)
    } catch (err) {
      console.error('[TlonStore] triggerIngest error:', err)
    }
  },

  clearAndRelearn: async (kbId) => {
    try {
      const res = await api.tlon.clearRelearn(kbId)
      if (!res.success) {
        useNotificationStore.getState().show({
          title: (res.error as string) || i18n.t('Could not start relearning.'),
          variant: 'warning',
          duration: 4000,
        })
        return false
      }
      // Wiki is wiped immediately; re-ingest progress arrives via events.
      await get().loadRawFiles(kbId)
      await get().loadWiki(kbId)
      return true
    } catch (err) {
      console.error('[TlonStore] clearAndRelearn error:', err)
      return false
    }
  },

  loadIngestStatus: async (kbId) => {
    try {
      const res = await api.tlon.getIngestStatus(kbId)
      if (res.success && res.data) {
        set(state => ({ ingestProgress: { ...state.ingestProgress, [kbId]: res.data as IngestProgressEvent } }))
      }
    } catch (err) {
      console.error('[TlonStore] loadIngestStatus error:', err)
    }
  },

  // ── KB chat (ephemeral) ───────────────────

  sendChatMessage: async (kbId, text) => {
    const content = text.trim()
    if (!content) return
    const prev = get().chatSessions[kbId]
    if (prev?.generating) return

    // Ensure a backing conversation exists (created lazily on first send).
    let conversationId = prev?.conversationId
    if (!conversationId) {
      const kbName = get().kbs.find(k => k.id === kbId)?.name || 'Knowledge base'
      try {
        const res = await api.createConversation(TLON_CHAT_SPACE, i18n.t('Ask: {{name}}', { name: kbName }))
        conversationId = (res.success && res.data) ? (res.data as Conversation).id : undefined
      } catch (err) {
        console.error('[TlonStore] sendChatMessage createConversation error:', err)
      }
      if (!conversationId) {
        const errMsg: TlonChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: i18n.t('Could not start the chat.'),
          error: true,
        }
        set(state => ({
          chatSessions: {
            ...state.chatSessions,
            [kbId]: {
              messages: [...(state.chatSessions[kbId]?.messages ?? []), errMsg],
              generating: false,
            },
          },
        }))
        return
      }
    }

    const userMsg: TlonChatMessage = { id: crypto.randomUUID(), role: 'user', content }
    set(state => ({
      chatSessions: {
        ...state.chatSessions,
        [kbId]: {
          conversationId,
          messages: [...(state.chatSessions[kbId]?.messages ?? []), userMsg],
          generating: true,
          status: i18n.t('Thinking…'),
        },
      },
    }))

    try {
      const res = await api.sendMessage({
        spaceId: TLON_CHAT_SPACE,
        conversationId,
        message: content,
        tlonKbId: kbId,
      })
      if (!res.success) {
        get().pushAssistantError(kbId, (res.error as string) || i18n.t('Failed to reach the model.'))
      }
    } catch (err) {
      console.error('[TlonStore] sendChatMessage error:', err)
      get().pushAssistantError(kbId, i18n.t('Failed to reach the model.'))
    }
  },

  clearChat: async (kbId) => {
    const conversationId = get().chatSessions[kbId]?.conversationId
    set(state => ({
      chatSessions: { ...state.chatSessions, [kbId]: { messages: [], generating: false } },
    }))
    // Drop the backend conversation so it doesn't linger in the temp space.
    if (conversationId) {
      try {
        await api.deleteConversation(TLON_CHAT_SPACE, conversationId)
      } catch (err) {
        console.error('[TlonStore] clearChat error:', err)
      }
    }
  },

  subscribeChatEvents: () => {
    const matchKb = (data: unknown): string | null => {
      const convId = (data as { conversationId?: string })?.conversationId
      if (!convId) return null
      const sessions = get().chatSessions
      return Object.keys(sessions).find(kbId => sessions[kbId]?.conversationId === convId) || null
    }

    const setStatus = (kbId: string, status: string) => {
      set(state => {
        const session = state.chatSessions[kbId]
        if (!session?.generating) return {}
        return { chatSessions: { ...state.chatSessions, [kbId]: { ...session, status } } }
      })
    }

    const unsubThought = api.onAgentThought((data) => {
      const kbId = matchKb(data)
      if (!kbId) return
      const thought = (data as { thought?: Thought }).thought
      if (!thought) return
      if (thought.type === 'tool_use') setStatus(kbId, i18n.t('Searching the knowledge base…'))
      else if (thought.type === 'thinking') setStatus(kbId, i18n.t('Thinking…'))
      else if (thought.type === 'text') setStatus(kbId, i18n.t('Writing the answer…'))
    })

    const unsubComplete = api.onAgentComplete((data) => {
      const kbId = matchKb(data)
      if (!kbId) return
      void get().finalizeChatTurn(kbId)
    })

    const unsubError = api.onAgentError((data) => {
      const kbId = matchKb(data)
      if (!kbId) return
      const message = (data as { error?: string }).error || i18n.t('The model returned an error.')
      get().pushAssistantError(kbId, message)
    })

    return () => {
      unsubThought()
      unsubComplete()
      unsubError()
    }
  },

  finalizeChatTurn: async (kbId) => {
    const session = get().chatSessions[kbId]
    // Skip if the turn already settled (e.g. agent:error fired before this
    // agent:complete) so we don't append a duplicate bubble.
    if (!session?.generating) return
    const conversationId = session.conversationId
    if (!conversationId) return
    let answer = ''
    try {
      const res = await api.getConversation(TLON_CHAT_SPACE, conversationId)
      if (res.success && res.data) {
        const messages = (res.data as Conversation).messages || []
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i] as Message
          if (m.role === 'assistant') { answer = (m.content || '').trim(); break }
        }
      }
    } catch (err) {
      console.error('[TlonStore] finalizeChatTurn error:', err)
    }
    if (!answer) {
      get().pushAssistantError(kbId, i18n.t('No answer was produced.'))
      return
    }
    set(state => {
      const session = state.chatSessions[kbId]
      if (!session) return {}
      const assistantMsg: TlonChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: answer }
      return {
        chatSessions: {
          ...state.chatSessions,
          [kbId]: { ...session, messages: [...session.messages, assistantMsg], generating: false, status: undefined },
        },
      }
    })
  },

  pushAssistantError: (kbId, message) => {
    set(state => {
      const session = state.chatSessions[kbId]
      if (!session) return {}
      const errMsg: TlonChatMessage = { id: crypto.randomUUID(), role: 'assistant', content: message, error: true }
      return {
        chatSessions: {
          ...state.chatSessions,
          [kbId]: { ...session, messages: [...session.messages, errMsg], generating: false, status: undefined },
        },
      }
    })
  },

  // ── Real-time event handlers ──────────────

  handleIngestProgress: (event) => {
    set(state => ({ ingestProgress: { ...state.ingestProgress, [event.kbId]: event } }))
    // Learned status is authoritative on disk — re-pull after each step so the
    // per-file status icons reflect reality, never the event stream.
    void get().loadRawFiles(event.kbId)
    if (event.phase === 'done' || event.phase === 'error') {
      void get().loadWiki(event.kbId)
      void get().refreshKB(event.kbId)
    }
  },

  handleStatsUpdated: (kbId) => {
    void get().refreshKB(kbId)
    void get().loadRawFiles(kbId)
  },
}))

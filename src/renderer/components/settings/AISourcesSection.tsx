import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type AnimationEvent, type ReactNode } from 'react'
import { Loader2, Plus } from 'lucide-react'
import type { AISource, AISourcesConfig, HaloConfig } from '../../types'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { api } from '../../api'
import { ProviderSelector } from './ProviderSelector'
import { OAuthAccountEditor } from './OAuthAccountEditor'
import { accountSaveFailureReason } from './account-save-error'
import { AISourceCard } from './AISourceCard'
import { AISourceInlinePanel } from './AISourceInlinePanel'
import { DelegatedLoginDialog } from './DelegatedLoginDialog'
import { ProviderIconTile } from '../icons/ProviderIconTile'
import { OAuthRedirectLogin } from '../ai-config/OAuthRedirectLogin'
import { GroupEditor } from '../ai-groups/GroupEditor'
import { GroupCards } from '../ai-groups/GroupCards'
import { GroupCreateMenu } from '../ai-groups/GroupCreateMenu'
import { GroupIcon } from '../ai-groups/group-parts'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { useOAuthLogin } from '../../hooks/useOAuthLogin'
import { openProxySettings } from '../../utils/proxy-navigation'
import { proxyRequiredText } from '../../utils/proxy-required-text'
import { parseProxyRequired } from '../../../shared/constants/proxy-required'
import { useGroupEditRequest } from '../../stores/ai-group-ui.store'
import type { AIGroupChange } from '../../../shared/rpc/contracts/ai-groups.contract'
import { resolveLocalizedText, type LocalizedText, type AuthProviderConfig } from '../../../shared/types'
import { CLI_DELEGATED_PROVIDER_ID } from '../../../shared/constants/claude-models'

const SubagentModelsManager = lazy(() => import('../subagent-models/SubagentModelsManager'))

function getLocalizedText(value: LocalizedText): string {
  return resolveLocalizedText(value, getCurrentLanguage())
}

interface AISourcesSectionProps {
  config: HaloConfig
  setConfig: (config: HaloConfig) => void
}

type SourceEditor =
  | { kind: 'provider'; sourceId?: string; preset?: AuthProviderConfig }
  | { kind: 'group'; groupId: string | null }

type Location = { kind: 'source' | 'group' | 'provider'; id: string } | { kind: 'add' }
type ViewChange = {
  location: Location
  intent: 'anchor' | 'open' | 'nearby' | 'return' | 'created' | 'external' | 'focus'
  anchor?: { element: HTMLElement; top: number }
}

function editorLocation(editor: SourceEditor): Location {
  if (editor.kind === 'group') return editor.groupId ? { kind: 'group', id: editor.groupId } : { kind: 'add' }
  if (editor.sourceId) return { kind: 'source', id: editor.sourceId }
  return editor.preset ? { kind: 'provider', id: editor.preset.type } : { kind: 'add' }
}

function locationSelector(location: Location): string {
  if (location.kind === 'add') return '[data-ai-add-row]'
  const attribute = location.kind === 'source' ? 'data-ai-source-id' : location.kind === 'group' ? 'data-ai-group-id' : 'data-ai-provider-row'
  return `[${attribute}="${CSS.escape(location.id)}"]`
}

function headerOf(element: HTMLElement): HTMLElement {
  return element.querySelector<HTMLElement>('[data-ai-source-header], [data-ai-group-header], [data-ai-panel-header]') ?? element
}

// Top of the scroller's unobscured area: below its own sticky children, such as the narrow-screen settings navigation.
function visibleTop(scroller: HTMLElement): number {
  let top = Math.max(0, scroller.getBoundingClientRect().top)
  for (const child of scroller.children) {
    if (getComputedStyle(child).position === 'sticky') top = Math.max(top, child.getBoundingClientRect().bottom)
  }
  return top
}

function headerInView(element: HTMLElement): boolean {
  const bounds = headerOf(element).getBoundingClientRect()
  const scroller = element.closest('main')
  const viewport = scroller?.getBoundingClientRect()
  return bounds.top >= (scroller ? visibleTop(scroller) : 0) && bounds.bottom <= Math.min(innerHeight, viewport?.bottom ?? innerHeight)
}

function scrollHeaderIntoView(element: HTMLElement, behavior: ScrollBehavior) {
  const header = headerOf(element)
  const scroller = element.closest('main')
  if (!scroller) return header.scrollIntoView({ block: 'nearest', behavior })
  const bounds = header.getBoundingClientRect()
  const top = visibleTop(scroller)
  const bottom = Math.min(innerHeight, scroller.getBoundingClientRect().bottom)
  const distance = bounds.top < top ? bounds.top - top : bounds.bottom > bottom ? Math.min(bounds.bottom - bottom, bounds.top - top) : 0
  if (distance) scroller.scrollBy({ top: distance, behavior })
}

function scrollToStart(element: HTMLElement) {
  const scroller = element.closest('main')
  if (!scroller) return element.scrollIntoView({ block: 'start', behavior: 'instant' })
  const margin = parseFloat(getComputedStyle(element).scrollMarginTop) || 0
  scroller.scrollBy({ top: element.getBoundingClientRect().top - margin - visibleTop(scroller), behavior: 'instant' })
}

const REVEAL_GAP = 16
const REVEAL_FOLLOW_MS = 8000

// Scrolls just enough to show an opened item's body without pushing its header off the top.
// While scrolling, the body only fades in, so the page and the body never move in opposite directions.
function revealOpened(element: HTMLElement, scroller: HTMLElement) {
  const viewTop = visibleTop(scroller)
  const viewBottom = Math.min(innerHeight, scroller.getBoundingClientRect().bottom)
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const entrances = reduced ? [] : element.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSAnimation && animation.animationName === 'slide-down')
  const overflow = element.getBoundingClientRect().bottom + REVEAL_GAP - viewBottom
  const headroom = headerOf(element).getBoundingClientRect().top - viewTop - REVEAL_GAP
  const distance = Math.min(overflow, headroom)
  if (distance < 1) return
  for (const animation of entrances) (animation.effect as KeyframeEffect | null)?.setKeyframes([{ opacity: 0 }, { opacity: 1 }])
  scroller.scrollBy({ top: distance, behavior: reduced ? 'instant' : 'smooth' })
}

// Bodies such as sign-in panels grow once their content loads, so keep revealing until the user takes over.
function followOpened(element: HTMLElement): () => void {
  const scroller = element.closest('main')
  if (!scroller) return () => {}
  revealOpened(element, scroller)
  const observer = new ResizeObserver(() => revealOpened(element, scroller))
  const stop = () => {
    observer.disconnect()
    clearTimeout(timer)
    scroller.removeEventListener('wheel', stop)
    scroller.removeEventListener('touchstart', stop)
    scroller.removeEventListener('pointerdown', stop)
    removeEventListener('keydown', stop, true)
  }
  const timer = setTimeout(stop, REVEAL_FOLLOW_MS)
  observer.observe(element)
  scroller.addEventListener('wheel', stop, { passive: true })
  scroller.addEventListener('touchstart', stop, { passive: true })
  scroller.addEventListener('pointerdown', stop, { passive: true })
  addEventListener('keydown', stop, true)
  return stop
}

export function AISourcesSection({ config, setConfig }: AISourcesSectionProps) {
  const { t } = useTranslation()
  const aiSources: AISourcesConfig = config.aiSources || { version: 2, currentId: null, sources: [] }
  const groups = aiSources.groups ?? []
  const chosenGroupId = aiSources.currentGroupId && groups.some(group => group.id === aiSources.currentGroupId) ? aiSources.currentGroupId : null
  const [editor, setEditor] = useState<SourceEditor | null>(null)
  const [saving, setSaving] = useState(false)
  const [modelAssignmentsOpen, setModelAssignmentsOpen] = useState(false)
  const [modelAssignmentsSaved, setModelAssignmentsSaved] = useState(false)
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null)
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null)
  const [highlighted, setHighlighted] = useState<Location | null>(null)
  const [deleteFailure, setDeleteFailure] = useState<{ sourceId: string; message: string } | null>(null)
  const [loggingOutSourceId, setLoggingOutSourceId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [delegatedLoginOpen, setDelegatedLoginOpen] = useState(false)
  const [oauthProviders, setOAuthProviders] = useState<AuthProviderConfig[]>([])
  const [loginPanel, setLoginPanel] = useState<{ provider: string; error: string | null } | null>(null)
  const sectionRef = useRef<HTMLDivElement>(null)
  const operationRef = useRef(false)
  const savedSourceRef = useRef<string | null>(null)
  const mountedRef = useRef(false)
  const viewChangeRef = useRef<ViewChange | null>(null)
  const revealCleanupRef = useRef<(() => void) | null>(null)
  const followCleanupRef = useRef<(() => void) | null>(null)
  const loginSourceIdsRef = useRef<Set<string>>(new Set())
  const loginProviderRef = useRef<string | null>(null)
  const loginErrorRef = useRef<string | null>(null)
  const { showConfirm, DialogComponent } = useConfirmDialog()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      revealCleanupRef.current?.()
      followCleanupRef.current?.()
    }
  }, [])

  const findLocation = (location: Location) => sectionRef.current?.querySelector<HTMLElement>(locationSelector(location))

  const prepareView = (location: Location, intent: ViewChange['intent'], preserve = false) => {
    const element = findLocation(location)
    viewChangeRef.current = {
      location,
      intent,
      ...(preserve && element ? { anchor: { element, top: element.getBoundingClientRect().top } } : {}),
    }
  }

  useLayoutEffect(() => {
    const change = viewChangeRef.current
    if (!change || saving && change.intent !== 'anchor') return
    viewChangeRef.current = null
    followCleanupRef.current?.()
    followCleanupRef.current = null
    const target = findLocation(change.location)
    if (!target) return
    if (change.anchor?.element === target) {
      const delta = target.getBoundingClientRect().top - change.anchor.top
      const scroller = target.closest('main')
      if (scroller && Math.abs(delta) > 0.1) scroller.scrollTop += delta
    }
    if (change.intent === 'anchor') return
    if (change.intent === 'open' || change.intent === 'external' || change.intent === 'nearby') {
      if (change.intent === 'external') scrollToStart(target)
      if (change.intent === 'nearby' && !headerInView(target)) scrollHeaderIntoView(target, 'instant')
      const region = target.querySelector<HTMLElement>('[data-ai-source-editor], [data-ai-login-panel]')
      const control = region?.querySelector<HTMLElement>('input:not([disabled]):not([readonly]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])')
      const focus = matchMedia('(pointer: coarse)').matches ? region : control ?? region
      focus?.focus({ preventScroll: true })
      if (change.intent === 'open') followCleanupRef.current = followOpened(target)
      return
    }
    if (change.intent === 'created') {
      revealCleanupRef.current?.()
      target.focus({ preventScroll: true })
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
      const header = headerOf(target)
      const scroller = target.closest('main')
      const distance = Math.abs(header.getBoundingClientRect().top - (scroller?.getBoundingClientRect().top ?? 0))
      const smooth = !reduced && distance > (scroller?.clientHeight ?? innerHeight)
      const highlight = () => {
        if (!mountedRef.current) return
        setHighlighted(change.location)
        if (reduced) {
          const timer = setTimeout(() => setHighlighted(null), 600)
          revealCleanupRef.current = () => clearTimeout(timer)
        }
      }
      if (!headerInView(target)) {
        if (smooth && scroller) {
          let done = false
          let timer: ReturnType<typeof setTimeout>
          const finish = () => {
            if (done) return
            done = true
            scroller.removeEventListener('scrollend', finish)
            clearTimeout(timer)
            highlight()
          }
          scroller.addEventListener('scrollend', finish, { once: true })
          timer = setTimeout(finish, 1500)
          revealCleanupRef.current = () => {
            done = true
            scroller.removeEventListener('scrollend', finish)
            clearTimeout(timer)
          }
          scrollHeaderIntoView(target, 'smooth')
          return
        }
        scrollHeaderIntoView(target, 'instant')
      }
      highlight()
      return
    }
    if (!headerInView(target)) scrollHeaderIntoView(target, 'instant')
    const entry = target.querySelector<HTMLElement>('[data-ai-source-edit], [data-ai-group-edit], [data-ai-add-trigger]')
    const focus = change.intent === 'focus' ? target : entry ?? target.querySelector<HTMLElement>('button')
    focus?.focus({ preventScroll: true })
  })

  const endHighlight = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && event.animationName === 'pulse-highlight') setHighlighted(null)
  }

  const openEditor = (next: SourceEditor, intent: 'open' | 'external' | 'nearby' = 'open') => {
    if (operationRef.current) return
    prepareView(editorLocation(next), intent, intent === 'open')
    savedSourceRef.current = null
    if (next.kind === 'provider' && next.sourceId) setExpandedSourceId(next.sourceId)
    if (next.kind === 'group' && next.groupId) setExpandedGroupId(next.groupId)
    setEditor(next)
  }

  const closeEditor = () => {
    if (operationRef.current || !editor) return
    prepareView(editorLocation(editor), 'return', true)
    if (editor.kind === 'provider' && editor.sourceId) setExpandedSourceId(editor.sourceId)
    if (editor.kind === 'group' && editor.groupId) setExpandedGroupId(editor.groupId)
    setEditor(null)
  }

  useEffect(() => {
    if (editor?.kind === 'provider' && editor.sourceId && !aiSources.sources.some(source => source.id === editor.sourceId)
      || editor?.kind === 'group' && editor.groupId && !groups.some(group => group.id === editor.groupId)) setEditor(null)
  }, [editor, aiSources.sources, groups])

  const groupIds = groups.map(group => group.id).join('\n')
  useEffect(() => {
    const pickUp = () => {
      const requested = useGroupEditRequest.getState().groupId
      if (!requested || operationRef.current) return
      useGroupEditRequest.getState().clear()
      if (groupIds.split('\n').includes(requested)) openEditor({ kind: 'group', groupId: requested }, 'external')
    }
    pickUp()
    return useGroupEditRequest.subscribe(pickUp)
  }, [groupIds, saving])

  useEffect(() => {
    const fetchProviders = async () => {
      try {
        const result = await api.authGetProviders()
        if (!mountedRef.current) return
        if (!result.success || !result.data) throw new Error(result.error || t('Failed to load login providers'))
        setOAuthProviders((result.data as AuthProviderConfig[]).filter(provider => provider.type !== 'custom'))
      } catch (failure) {
        console.warn('[AISourcesSection] Could not load login providers')
        if (mountedRef.current) setError(failure instanceof Error ? failure.message : t('Failed to load login providers'))
      }
    }
    void fetchProviders()
  }, [])

  const reloadConfig = async () => {
    const result = await api.getConfig({ snapshot: true })
    if (!result.success || !result.data) throw new Error(result.error || t('Failed to load config'))
    const latest = result.data as HaloConfig
    setConfig(latest)
    return latest
  }

  const oauth = useOAuthLogin({
    onSignedIn: async () => {
      const latest = await reloadConfig()
      if (!mountedRef.current) return
      const added = latest.aiSources?.sources.find(source => !loginSourceIdsRef.current.has(source.id) && source.provider === loginProviderRef.current)
      if (added) {
        setExpandedSourceId(added.id)
        prepareView({ kind: 'source', id: added.id }, 'created')
      }
      setLoginPanel(null)
      loginProviderRef.current = null
    },
    onError: message => {
      loginErrorRef.current = message
      if (message) console.warn('[AISourcesSection] Sign-in failed; its provider row remains open')
      setLoginPanel(current => current ? { ...current, error: message } : current)
    },
  })

  const startLogin = (provider: string) => {
    if (operationRef.current || oauth.login || loginProviderRef.current && !loginErrorRef.current) return
    loginSourceIdsRef.current = new Set(aiSources.sources.map(source => source.id))
    loginProviderRef.current = provider
    loginErrorRef.current = null
    prepareView({ kind: 'provider', id: provider }, 'open', true)
    setLoginPanel({ provider, error: null })
    void oauth.start(provider)
  }

  const cancelLogin = async () => {
    const provider = loginPanel?.provider
    loginErrorRef.current = null
    await oauth.cancel()
    if (!mountedRef.current || loginErrorRef.current) return
    if (provider) prepareView({ kind: 'provider', id: provider }, 'return', true)
    loginProviderRef.current = null
    setLoginPanel(null)
  }

  const handleSwitchSource = async (sourceId: string) => {
    if (operationRef.current) return
    const result = await api.aiSourcesSwitchSource(sourceId)
    if (result.success && result.data) setConfig({ ...config, aiSources: result.data as AISourcesConfig })
  }

  const setEditorSaving = (value: boolean) => {
    operationRef.current = value
    setSaving(value)
  }

  const handleSaveSource = async (source: AISource) => {
    if (operationRef.current) return
    setEditorSaving(true)
    let stage = 'persist'
    try {
      const existing = aiSources.sources.some(item => item.id === source.id) || savedSourceRef.current === source.id
      const adding = editor?.kind === 'provider' && !editor.sourceId
      const saveResult = existing ? await api.aiSourcesUpdateSource(source.id, source) : await api.aiSourcesAddSource(source)
      if (!saveResult.success) throw new Error(saveResult.error || t('Save failed'))
      savedSourceRef.current = source.id
      // Keep this identity after a later selection or settings write fails, so a retry updates it.
      if (saveResult.data) {
        if (editor) prepareView(editorLocation(editor), 'anchor', true)
        setConfig({ ...config, aiSources: saveResult.data as AISourcesConfig })
      }
      let latest: HaloConfig
      if (!adding && chosenGroupId !== null) {
        stage = 'reload'
        const snapshot = await api.getConfig({ snapshot: true })
        if (!snapshot.success || !snapshot.data) throw new Error(snapshot.error || t('Failed to load config'))
        latest = snapshot.data as HaloConfig
      } else {
        stage = 'select'
        const switched = await api.aiSourcesSwitchSource(source.id)
        if (!switched.success || !switched.data) throw new Error(switched.error || t('Save failed'))
        latest = { ...config, aiSources: switched.data as AISourcesConfig }
      }
      if (editor) prepareView(editorLocation(editor), 'anchor', true)
      setConfig({ ...latest, isFirstLaunch: false, modelConfigSkipped: false })
      stage = 'settings'
      const flags = await api.setConfig({ isFirstLaunch: false, modelConfigSkipped: false })
      if (!flags.success) throw new Error(flags.error || t('Save failed'))
      if (!mountedRef.current) return
      setExpandedSourceId(source.id)
      prepareView({ kind: 'source', id: source.id }, adding ? 'created' : 'return', !adding)
      setEditor(null)
    } catch (failure) {
      const reason = accountSaveFailureReason(failure, [source.apiKey, source.accessToken, source.refreshToken])
      console.warn(`[AISourcesSection] Account save failed stage=${stage}; the draft remains open: ${reason}`)
      throw new Error(t('Save failed'))
    } finally {
      setEditorSaving(false)
    }
  }

  const handleDeleteSource = async (source: AISource) => {
    if (operationRef.current) return
    operationRef.current = true
    const groupsUsing = groups.filter(group => group.members.some(member => member.sourceId === source.id))
    const message = [t('Are you sure you want to delete “{{name}}”?', { name: source.name }),
      ...(groupsUsing.length ? [t('It is also taken out of the load-balancing groups that use it: {{names}}.', { names: groupsUsing.map(group => group.name).join(', ') })] : []),
    ].join('\n\n')
    const confirmed = await showConfirm({ title: t('Delete this account?'), message, confirmLabel: t('Delete'), cancelLabel: t('Cancel'), variant: 'danger' })
    if (!confirmed) {
      operationRef.current = false
      return
    }
    setSaving(true)
    setDeleteFailure(null)
    try {
      const result = await api.aiSourcesDeleteSource(source.id)
      if (!result.success || !result.data) throw new Error(t('Delete failed'))
      const order: Location[] = [...aiSources.sources.map(item => ({ kind: 'source' as const, id: item.id })), ...groups.map(group => ({ kind: 'group' as const, id: group.id }))]
      const index = order.findIndex(item => 'id' in item && item.id === source.id)
      const neighbor = order[index + 1] ?? order[index - 1] ?? { kind: 'add' as const }
      prepareView(neighbor, neighbor.kind === 'add' ? 'return' : 'focus')
      setConfig({ ...config, aiSources: result.data as AISourcesConfig })
    } catch {
      console.warn('[AISourcesSection] Account deletion failed; the account remains in its card')
      if (mountedRef.current) setDeleteFailure({ sourceId: source.id, message: t('Delete failed') })
    } finally {
      setEditorSaving(false)
    }
  }

  const handleGroupSaved = (change: AIGroupChange) => {
    const adding = editor?.kind === 'group' && editor.groupId === null
    setConfig({ ...config, aiSources: change.aiSources })
    setExpandedGroupId(change.groupId)
    prepareView({ kind: 'group', id: change.groupId }, adding ? 'created' : 'return', !adding)
    setEditor(null)
  }

  const handleOAuthLogout = async (sourceId: string) => {
    if (operationRef.current) return
    try {
      setLoggingOutSourceId(sourceId)
      setError(null)
      const result = await api.authLogout(sourceId)
      if (!result.success) throw new Error(result.error || t('Unable to sign out'))
      await reloadConfig()
    } catch (failure) {
      if (mountedRef.current) setError(failure instanceof Error ? failure.message : t('Unable to sign out'))
    } finally {
      if (mountedRef.current) setLoggingOutSourceId(null)
    }
  }

  const editorRegion = (title: string, content: ReactNode) => (
    <fieldset data-ai-source-editor role="region" aria-label={title} aria-busy={saving || undefined} tabIndex={-1} disabled={saving} className="min-w-0 space-y-4 border-0 p-0 outline-none">
      {(editor?.kind === 'provider' && editor.sourceId || editor?.kind === 'group' && editor.groupId) && <h3 className="sr-only">{title}</h3>}
      {content}
    </fieldset>
  )

  const providerEditor = editor?.kind === 'provider' ? editor : null
  const editingSource = providerEditor?.sourceId ? aiSources.sources.find(source => source.id === providerEditor.sourceId) : undefined
  let providerContent: ReactNode = null
  if (providerEditor && (!providerEditor.sourceId || editingSource)) {
    providerContent = editingSource?.authType === 'oauth'
      ? editorRegion(t('Edit Account'), (
        <OAuthAccountEditor
          key={editingSource.id}
          source={editingSource}
          onCancel={closeEditor}
          onSavingChange={setEditorSaving}
          onSaved={async () => {
            await reloadConfig()
            if (!mountedRef.current) return
            prepareView({ kind: 'source', id: editingSource.id }, 'return', true)
            setEditor(null)
          }}
        />
      ))
      : editorRegion(editingSource ? t('Edit Provider') : providerEditor.preset ? getLocalizedText(providerEditor.preset.displayName) : t('Add AI Provider'), (
        <ProviderSelector
          key={providerEditor.sourceId ?? providerEditor.preset?.type ?? 'new'}
          variant="inline"
          aiSources={aiSources}
          onSave={handleSaveSource}
          onCancel={closeEditor}
          editingSourceId={providerEditor.sourceId}
          presetProvider={providerEditor.preset}
        />
      ))
  }
  const groupEditor = editor?.kind === 'group' ? editor : null
  const editingGroup = groupEditor?.groupId ? groups.find(group => group.id === groupEditor.groupId) : undefined
  const groupContent = groupEditor && (!groupEditor.groupId || editingGroup)
    ? editorRegion(editingGroup ? t('Edit Load-Balancing Group') : t('Create Load-Balancing Group'), (
      <GroupEditor
        key={editingGroup?.id ?? 'new'}
        aiSources={aiSources}
        group={editingGroup}
        onSaved={handleGroupSaved}
        onSavingChange={setEditorSaving}
        onCancel={closeEditor}
        onAddProvider={() => openEditor({ kind: 'provider' }, editingGroup ? 'nearby' : 'open')}
      />
    )) : null
  const addContent = providerEditor && !providerEditor.sourceId && !providerEditor.preset ? providerContent : groupEditor && !groupEditor.groupId ? groupContent : null
  const addTitle = groupEditor && !groupEditor.groupId ? t('Create Load-Balancing Group') : t('Add AI Provider')

  const renderError = (message: string) => (
    <div role="alert" className="space-y-2 rounded-md border border-destructive/20 bg-destructive/10 p-3">
      <p className="break-words text-sm text-destructive">{proxyRequiredText(message, t) ?? message}</p>
      {parseProxyRequired(message) && <button type="button" onClick={() => void openProxySettings()} className="min-h-9 rounded-md border border-destructive/30 px-2.5 text-xs text-destructive transition-colors hover:bg-destructive/10">{t('Open proxy settings')}</button>}
    </div>
  )

  const loginContent = loginPanel ? (
    <div data-ai-login-panel role="region" aria-label={getLocalizedText(oauthProviders.find(provider => provider.type === loginPanel.provider)?.displayName ?? loginPanel.provider)} tabIndex={-1} className="space-y-4 outline-none">
      {loginPanel.error ? (
        <>
          {renderError(loginPanel.error)}
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-end">
            <button type="button" onClick={() => void cancelLogin()} className="min-h-11 rounded-lg bg-secondary px-4 text-sm text-foreground hover:bg-surface-hover sm:min-h-9">{t('Cancel')}</button>
            <button type="button" disabled={saving} onClick={() => startLogin(loginPanel.provider)} className="min-h-11 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50 sm:min-h-9">{t('Try again')}</button>
          </div>
        </>
      ) : oauth.login?.redirect ? (
        <OAuthRedirectLogin hideTitle variant="inline" title={getLocalizedText(oauthProviders.find(provider => provider.type === loginPanel.provider)?.displayName ?? loginPanel.provider)} redirect={oauth.login.redirect} onOpenWindow={oauth.openLoginWindow} onSubmitCode={oauth.submitCode} onCodeChange={oauth.setManualCode} onCopyLink={oauth.copyLoginUrl} onCancel={() => void cancelLogin()} />
      ) : (
        <>
          <div role="status" className="flex items-center gap-3">
            <Loader2 size={20} className="animate-spin text-primary" />
            <span className="text-foreground">{oauth.login?.phase === 'starting' || !oauth.login ? t('Starting login...') : oauth.login.userCode ? t('Enter the code in your browser') : t('Waiting for login...')}</span>
          </div>
          {config.network?.requireProxyForOAuth && loginPanel.provider === 'chatgpt' && !oauth.login?.userCode && <p className="text-xs text-muted-foreground">{t('The login page opens in your browser. Make sure that browser also goes through your proxy.')}</p>}
          {oauth.login?.userCode && (
            <div className="rounded-md bg-secondary p-3 text-center">
              <p className="mb-2 text-sm text-muted-foreground">{t('Your code')}</p>
              <p className="font-mono text-2xl font-bold text-primary">{oauth.login.userCode}</p>
              {oauth.login.verificationUri && <a href={oauth.login.verificationUri} target="_blank" rel="noopener noreferrer" className="mt-2 block text-sm text-primary hover:underline">{t('Open verification page')}</a>}
            </div>
          )}
          <div className="flex justify-end"><button type="button" onClick={() => void cancelLogin()} className="min-h-11 w-full rounded-lg bg-secondary px-4 text-sm text-foreground hover:bg-surface-hover sm:min-h-9 sm:w-auto">{t('Cancel')}</button></div>
        </>
      )}
    </div>
  ) : null

  const availablePresetProviders = oauthProviders.filter(provider => provider.preset && (providerEditor?.preset?.type === provider.type || !aiSources.sources.some(source => source.isPreset === true && source.apiUrl === provider.preset!.baseUrl)))
  const availableOAuthProviders = oauthProviders.filter(provider => !provider.preset && (provider.type !== CLI_DELEGATED_PROVIDER_ID || !api.isRemoteMode() && !aiSources.sources.some(source => source.provider === provider.type)))

  return (
    <>
      <div ref={sectionRef} className="space-y-4">
        {error && renderError(error)}
        {aiSources.sources.length > 0 || groups.length > 0 ? (
          <div className="space-y-2">
            {aiSources.sources.map(source => <AISourceCard
              key={source.id}
              source={source}
              chosen={!chosenGroupId && source.id === aiSources.currentId}
              expanded={expandedSourceId === source.id}
              busy={saving}
              signingOut={loggingOutSourceId === source.id}
              deleteError={deleteFailure?.sourceId === source.id ? deleteFailure.message : undefined}
              editor={providerEditor?.sourceId === source.id ? providerContent : undefined}
              highlighted={highlighted?.kind === 'source' && highlighted.id === source.id}
              onHighlightEnd={endHighlight}
              onToggle={() => {
                if (operationRef.current) return
                prepareView({ kind: 'source', id: source.id }, 'anchor', true)
                setExpandedSourceId(current => current === source.id ? null : source.id)
              }}
              onChoose={() => void handleSwitchSource(source.id)}
              onEdit={() => openEditor({ kind: 'provider', sourceId: source.id })}
              onDelete={() => void handleDeleteSource(source)}
              onLogout={() => void handleOAuthLogout(source.id)}
            />)}
            {groups.length > 0 && <GroupCards
              aiSources={aiSources}
              chosenGroupId={chosenGroupId}
              expandedGroupId={expandedGroupId}
              editingGroupId={groupEditor?.groupId ?? null}
              editor={groupContent}
              busy={saving}
              highlightedGroupId={highlighted?.kind === 'group' ? highlighted.id : null}
              onHighlightEnd={endHighlight}
              onToggle={groupId => {
                if (operationRef.current) return
                prepareView({ kind: 'group', id: groupId }, 'anchor', true)
                setExpandedGroupId(current => current === groupId ? null : groupId)
              }}
              onChoose={handleSwitchSource}
              onEdit={groupId => openEditor({ kind: 'group', groupId })}
              onDeleted={(next, groupId) => {
                setConfig({ ...config, aiSources: next })
                setExpandedGroupId(current => current === groupId ? null : current)
              }}
              onError={setError}
            />}
          </div>
        ) : <div className="rounded-lg border border-border bg-card p-6 text-center text-muted-foreground">{t('No AI sources configured')}</div>}

        <div data-ai-add-row className="scroll-mt-4">
          {addContent ? (
            <AISourceInlinePanel
              id="add"
              title={addTitle}
              open
              icon={<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground">{groupEditor ? <GroupIcon size={18} /> : <Plus size={18} />}</div>}
            >
              {addContent}
            </AISourceInlinePanel>
          ) : (
            <div className="flex items-stretch gap-2">
              <button
                type="button"
                data-ai-add-trigger
                disabled={saving}
                onClick={() => openEditor({ kind: 'provider' })}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border px-4 py-3 text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
              >
                <Plus size={18} />
                {t('Add AI Provider')}
              </button>
              <fieldset ref={element => { if (element) element.inert = saving }} disabled={saving} className="flex min-w-0 border-0 p-0">
                <GroupCreateMenu onCreate={() => openEditor({ kind: 'group', groupId: null })} onConfigureModels={() => setModelAssignmentsOpen(true)} />
              </fieldset>
            </div>
          )}
        </div>

        {modelAssignmentsOpen ? <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">{t('Loading...')}</p>}><SubagentModelsManager config={aiSources} onSaved={() => setModelAssignmentsSaved(true)} onClose={() => { setModelAssignmentsOpen(false); sectionRef.current?.querySelector<HTMLElement>('[aria-label="' + CSS.escape(t('More ways to add')) + '"]')?.focus({ preventScroll: true }) }} /></Suspense> : (modelAssignmentsSaved || (aiSources.subagentModels?.revision ?? 0) > 0) && <button type="button" onClick={() => setModelAssignmentsOpen(true)} className="min-h-11 rounded-md px-2 text-sm text-muted-foreground hover:bg-secondary sm:min-h-9">{t('Model assignments')}</button>}

        {(availablePresetProviders.length > 0 || availableOAuthProviders.length > 0) && (
          <div className="space-y-4 border-t border-border pt-4">
            {availablePresetProviders.length > 0 && (
              <div>
                <h4 className="mb-3 text-sm font-medium text-muted-foreground">{t('Preset API')}</h4>
                <div className="space-y-2">
                  {availablePresetProviders.map(provider => (
                    <AISourceInlinePanel
                      key={provider.type}
                      id={provider.type}
                      title={getLocalizedText(provider.displayName)}
                      description={getLocalizedText(provider.description)}
                      icon={<ProviderIconTile provider={provider} size="sm" />}
                      open={providerEditor?.preset?.type === provider.type}
                      busy={saving}
                      onOpen={() => openEditor({ kind: 'provider', preset: provider })}
                    >
                      {providerEditor?.preset?.type === provider.type ? providerContent : null}
                    </AISourceInlinePanel>
                  ))}
                </div>
              </div>
            )}
            {availableOAuthProviders.length > 0 && (
              <div>
                <h4 className="mb-3 text-sm font-medium text-muted-foreground">{t('OAuth Login')}</h4>
                <div className="space-y-2">
                  {availableOAuthProviders.map(provider => (
                    <AISourceInlinePanel
                      key={provider.type}
                      id={provider.type}
                      title={getLocalizedText(provider.displayName)}
                      description={provider.type !== CLI_DELEGATED_PROVIDER_ID && aiSources.sources.some(source => source.provider === provider.type) ? t('Add another account') : getLocalizedText(provider.description)}
                      icon={<ProviderIconTile provider={provider} size="sm" />}
                      open={loginPanel?.provider === provider.type}
                      busy={saving || !!loginPanel && !loginPanel.error}
                      onOpen={provider.type === CLI_DELEGATED_PROVIDER_ID
                        ? () => { if (!operationRef.current) setDelegatedLoginOpen(true) }
                        : () => startLogin(provider.type)}
                    >
                      {loginPanel?.provider === provider.type ? loginContent : null}
                    </AISourceInlinePanel>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {DialogComponent}
      <DelegatedLoginDialog
        open={delegatedLoginOpen}
        onClose={() => setDelegatedLoginOpen(false)}
        onComplete={async () => {
          await reloadConfig()
          setDelegatedLoginOpen(false)
        }}
      />
    </>
  )
}

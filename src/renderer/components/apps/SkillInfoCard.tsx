import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, FolderOpen, Globe, Loader2, MoreHorizontal, Pencil, Power, PowerOff, RefreshCw, Share2, Terminal, Trash2, X } from 'lucide-react'
import { api } from '../../api'
import { isElectron } from '../../api/transport'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { useSpaceStore } from '../../stores/space.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useStoreUpdateFlow } from '../store/useStoreUpdateFlow'
import { useChatStore } from '../../stores/chat.store'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { useSkillActions } from '../../hooks/useSkillActions'
import { navigateToConversation, openSkillInComposer } from '../../utils/conversation-navigation'
import { skillDisplay, skillErrorMessage, skillSourceLabel, skillInstructions } from '../../utils/skill-presentation'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { CodeMirrorEditor } from '../canvas/viewers/CodeMirrorEditor'
import { SkillCopyDialog } from './SkillCopyDialog'
import { ShareCurrentAppDialog } from '../store/ShareCurrentAppDialog'
import type { SkillDetail, SkillGroup, SkillRef } from '../../../shared/types/skills'
import type { EngineAvailabilityReport } from '../../types'

interface SkillInfoCardProps {
  appId?: string
  skillRef?: SkillRef
  group?: SkillGroup
  spaceName?: string
  showUse?: boolean
  stickyHeader?: boolean
  onChanged?: () => void
  onDeleted?: () => void
}

export function SkillInfoCard({ appId, skillRef, group, showUse = true, stickyHeader = true, onChanged, onDeleted }: SkillInfoCardProps) {
  const { t } = useTranslation()
  const currentSpace = useSpaceStore(state => state.currentSpace)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const spaces = useSpaceStore(state => state.spaces)
  const contextId = skillRef ? skillRef.spaceId : currentSpace?.id ?? haloSpace?.id ?? null
  const initialId = skillRef?.id ?? `app:${appId}`
  const [selectedId, setSelectedId] = useState(initialId)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [freshGroup, setFreshGroup] = useState<SkillGroup | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const operation = useRef(false)
  const identity = `${contextId}:${initialId}:${selectedId}`
  const activeIdentity = useRef(identity)
  activeIdentity.current = identity
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [revision, setRevision] = useState(0)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [editRevision, setEditRevision] = useState('')
  const [copying, setCopying] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [menu, setMenu] = useState<'scope' | 'more' | null>(null)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const headerSentinel = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(false)
  const { showConfirm, DialogComponent } = useConfirmDialog()
  const allSpaces = [...(haloSpace ? [haloSpace] : []), ...spaces.filter(space => space.id !== haloSpace?.id)]
  const scopeName = (id: string | null) => id === null ? t('Global (all spaces)') : allSpaces.find(space => space.id === id)?.name ?? t('Workspace')
  const copy = detail?.copy
  const ref: SkillRef = { spaceId: contextId, id: copy?.id ?? selectedId }
  const refresh = () => { setRevision(value => value + 1); onChanged?.() }
  const actions = useSkillActions(ref, refresh, onDeleted)
  const disabled = busy || actions.busy || loading
  const update = useAppsPageStore(state => state.availableUpdates.find(item => item.appId === copy?.appId))
  const updateFlow = useStoreUpdateFlow(update?.entry, update, undefined, refresh)

  async function readGroup(spaceId: string | null, name: string) {
    const result = await api.skillsList({ spaceId, q: name, limit: 100 })
    if (!result.success || !result.data) throw new Error(result.error)
    return result.data.groups.find(item => item.name === name.toLowerCase()) ?? null
  }

  useEffect(() => { setSelectedId(initialId); setDetail(null); setEditing(false); setDraft(''); setMenu(null); setVersionsOpen(false) }, [initialId, contextId])
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null); setFreshGroup(null)
    api.skillsRead({ spaceId: contextId, id: selectedId }).then(async result => {
      if (cancelled) return
      if (!result.success || !result.data) throw new Error(result.error)
      setDetail(result.data)
      const latest = await readGroup(contextId, result.data.copy.name)
      if (!cancelled) setFreshGroup(latest)
    }).catch(failure => {
      if (cancelled) return
      console.warn('[SkillInfoCard] Skill read failed', { id: selectedId, reason: failure instanceof Error ? failure.message : String(failure) })
      setError(skillErrorMessage(failure, t('Could not open this skill. Please try again.'), t))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selectedId, contextId, revision, t])
  useEffect(() => {
    if (!menu) return
    function close(event: MouseEvent) { if (!menuRef.current?.contains(event.target as Node)) setMenu(null) }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') { event.stopPropagation(); setMenu(null) } }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [menu])
  useEffect(() => {
    if (!stickyHeader || !headerSentinel.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setPinned(!entry.isIntersecting))
    observer.observe(headerSentinel.current)
    return () => observer.disconnect()
  }, [stickyHeader, selectedId])

  async function act(action: () => Promise<void>) {
    if (operation.current) return
    operation.current = true; setBusy(true); setError(null)
    try { await action() }
    catch (failure) {
      console.warn('[SkillInfoCard] Skill operation failed', { id: selectedId, reason: failure instanceof Error ? failure.message : String(failure) })
      if (mounted.current && activeIdentity.current === identity) setError(skillErrorMessage(failure, t('Could not update this skill. Your changes are kept; please try again.'), t))
    } finally { operation.current = false; if (mounted.current) setBusy(false) }
  }

  async function useSkill(newConversation = false) {
    const spaceId = contextId ?? currentSpace?.id ?? haloSpace?.id
    if (!spaceId || !copy) { setError(t('Choose a workspace first.')); return }
    const stillSelected = () => mounted.current && activeIdentity.current === identity
    const latest = await readGroup(spaceId, copy.name)
    if (!stillSelected()) return
    if (latest?.effectiveId !== copy.id) {
      setError(t('This workspace uses a different version of this skill. Open its workspace version to continue.'))
      return
    }
    if (copy.source !== 'personal') {
      const chat = useChatStore.getState()
      const state = chat.spaceStates?.get(spaceId)
      const conversationId = !newConversation ? state?.selectedAppChat?.conversationId ?? state?.currentConversationId : undefined
      const conversation = conversationId ? chat.conversationCache?.get(conversationId) ?? state?.conversations.find(item => item.id === conversationId) : undefined
      let engine = conversationId ? chat.sessionInitInfo?.get(conversationId)?.engineId ?? conversation?.resolvedEngineId ?? conversation?.engineBinding?.engineId ?? conversation?.engineOverride : undefined
      if (!engine) {
        const response = await api.getEngineAvailability()
        if (!stillSelected()) return
        if (!response.success || !response.data) throw new Error(response.error)
        const availability = response.data as EngineAvailabilityReport
        engine = availability.defaultEngine ?? availability.activeEngine ?? undefined
      }
      if (engine !== 'halo') {
        setError(t('This skill needs Halo SDK. Choose Halo SDK in the conversation’s advanced settings, then use it again.'))
        return
      }
    }
    if (newConversation) {
      const created = await api.createConversation(spaceId)
      if (!created.success || !created.data || typeof created.data !== 'object' || !('id' in created.data) || typeof created.data.id !== 'string') throw new Error(created.error)
      if (!stillSelected()) return
      await useChatStore.getState().loadConversations(spaceId)
      if (!stillSelected()) return
      navigateToConversation(spaceId, created.data.id)
    }
    if (!stillSelected()) return
    openSkillInComposer({ spaceId, name: copy.name, description: copy.description })
  }

  const display = copy ? skillDisplay(copy, getCurrentLanguage()) : { name: group?.displayName ?? t('Skill details'), description: '' }
  const buttonClass = 'inline-flex items-center gap-1.5 rounded-md border border-border-soft bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:border-border hover:bg-secondary disabled:opacity-40'
  const iconButton = 'rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40'
  const menuItem = 'flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-secondary disabled:opacity-40'
  const failed = error || actions.error
  const currentGroup = freshGroup ?? group

  return <div className="min-w-0 flex-1 space-y-5 px-4 py-4 sm:px-10 sm:py-6">
    {stickyHeader && <div ref={headerSentinel} aria-hidden="true" className="!mt-0 h-px" />}
    <div ref={menuRef} className={`${stickyHeader ? 'sticky top-0 z-20 -mx-4 border-b bg-background px-4 py-3 sm:-mx-10 sm:px-10' : ''} flex flex-col items-start justify-between gap-3 sm:flex-row ${pinned ? 'border-border-faint' : 'border-transparent'}`}>
      <div className="w-full min-w-0 sm:w-auto sm:flex-1">
        <div className="flex min-w-0 items-center gap-2"><h2 className="break-words text-base font-semibold text-foreground">{display.name}</h2>{copy && !copy.enabled && <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">{t('Disabled')}</span>}</div>
        {copy && <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {detail?.spec.author && <span>{t('by')} {detail.spec.author}</span>}{detail?.spec.version && <span>v{detail.spec.version}</span>}
          {update && <button type="button" disabled={disabled || updateFlow.busy} onClick={updateFlow.start} className="rounded-full border border-halo-success/30 bg-halo-success/10 px-2 py-0.5 text-[11px] font-medium text-halo-success hover:bg-halo-success/20">{t('Update to v{{version}}', { version: update.latestVersion })}</button>}
          <div className="relative">
            <button type="button" disabled={disabled || editing || copy.availability === 'missing'} onClick={() => setMenu(value => value === 'scope' ? null : 'scope')} aria-expanded={menu === 'scope'} aria-label={t('Change workspace')} title={t('Click to change space')} className="inline-flex items-center gap-1 rounded-full border border-border-soft bg-secondary/50 px-2 py-0.5 text-[11px] hover:text-foreground disabled:opacity-40">{copy.scope === 'global' && <Globe className="h-3 w-3" />}<span>{scopeName(copy.spaceId)}</span><ChevronDown className="h-3 w-3" /></button>
            {menu === 'scope' && <div className="absolute left-0 top-full z-30 mt-1 min-w-[180px] max-w-[260px] rounded-lg border border-border bg-popover py-1 shadow-lg">
              <button className={menuItem} onClick={() => { setMenu(null); void actions.move(null, t('Global (all spaces)')) }}><Globe className="h-3.5 w-3.5" />{t('Global (all spaces)')}{copy.spaceId === null && <Check className="ml-auto h-3.5 w-3.5" />}</button>
              {allSpaces.map(space => <button key={space.id} className={menuItem} onClick={() => { setMenu(null); void actions.move(space.id, space.name) }}><span className="truncate">{space.isTemp ? t('Halo') : space.name}</span>{copy.spaceId === space.id && <Check className="ml-auto h-3.5 w-3.5" />}</button>)}
            </div>}
          </div>
        </div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {copy && <>{showUse && copy.availability === 'available' && <button disabled={disabled} className={buttonClass} onClick={() => void act(() => useSkill())}>{t('Use')}</button>}
          <button disabled={disabled || (!copy.enabled && ['missing', 'invalid'].includes(copy.availability))} onClick={() => void actions.toggle()} className={buttonClass}>{actions.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : copy.enabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}{copy.enabled ? t('Disable') : t('Enable')}</button>
          <button disabled={disabled || copy.availability === 'missing'} aria-label={t('Share')} title={t('Share')} onClick={() => setSharing(true)} className={iconButton}><Share2 className="h-3.5 w-3.5" /></button>
          <div className="relative"><button aria-label={t('More')} title={t('More')} aria-expanded={menu === 'more'} disabled={disabled} className={iconButton} onClick={() => setMenu(value => value === 'more' ? null : 'more')}><MoreHorizontal className="h-4 w-4" /></button>{menu === 'more' && <div className="absolute right-0 top-full z-30 mt-1 min-w-[180px] rounded-lg border border-border bg-popover py-1 shadow-lg">
            <button className={menuItem} disabled={copy.availability === 'missing'} onClick={() => { setMenu(null); setCopying(true) }}>{t('Save custom copy')}</button>
            {showUse && copy.availability === 'available' && <button className={menuItem} onClick={() => { setMenu(null); void act(() => useSkill(true)) }}>{t('Use in a new conversation')}</button>}
            <button className={menuItem} onClick={() => { setMenu(null); refresh() }}><RefreshCw className="h-3.5 w-3.5" />{t('Refresh')}</button>
          </div>}</div></>}
      </div>
    </div>
    {failed && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-halo-error/30 bg-halo-error/5 px-3 py-2.5 text-xs text-halo-error"><span className="min-w-0 break-words">{failed}</span><button disabled={disabled} onClick={() => { actions.clearError(); refresh() }} className="shrink-0 underline">{t('Retry')}</button></div>}
    {loading && !detail && <p role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('Loading…')}</p>}
    {copy && detail && <>
      {copy.availability === 'missing' && <p role="status" className="text-sm text-muted-foreground">{t('The skill file could not be found. Check its folder or import the skill again.')}</p>}
      {copy.availability === 'invalid' && <p role="status" className="text-sm text-halo-error">{t('This skill has invalid instructions. Edit the file to correct its format, then try again.')}</p>}
      {copy.availability === 'conflict' && <p className="text-sm text-halo-error">{t('Two skills have the same name in this workspace. Rename or disable one to use the other.')}</p>}
      {copy.availability === 'overridden' && <p className="text-xs text-muted-foreground">{t('This workspace uses its own version. This global version remains available in other workspaces.')}</p>}
      <div className="space-y-2"><h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"><Terminal className="h-3.5 w-3.5" />{t('How to use')}</h3><div className="rounded-lg bg-secondary p-3 font-mono text-xs text-foreground">/{copy.name}</div><p className="text-xs text-muted-foreground">{t('Invoke this skill by typing the command above in any conversation.')}</p></div>
      {display.description && <div className="space-y-2"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('Description')}</h3><p className="text-sm leading-relaxed text-foreground">{display.description}</p></div>}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('Skill Instructions')}</h3><div className="flex items-center gap-2">
          {isElectron() && <button title={t('Open skill folder')} aria-label={t('Open skill folder')} disabled={disabled} className={iconButton} onClick={() => void actions.openFolder()}><FolderOpen className="h-3.5 w-3.5" /></button>}
          {editing ? <><button disabled={disabled} className="text-xs text-primary" onClick={() => setCopying(true)}>{t('Save custom copy')}</button><button disabled={disabled} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => { setEditing(false); setDraft('') }}><X className="h-3 w-3" />{t('Cancel')}</button><button disabled={disabled} className="inline-flex items-center gap-1 text-xs text-primary" onClick={() => void act(async () => {
            if (!await showConfirm({ title: t('Save shared resource changes?'), message: t('The changes will be saved to this skill. Supporting files will be kept.'), confirmLabel: t('Save'), cancelLabel: t('Cancel') })) return
            const result = await api.skillsSave({ ref, content: draft, revision: editRevision })
            if (!result.success || !result.data) throw new Error(result.error)
            if (!mounted.current || activeIdentity.current !== identity) return
            setDetail(result.data); setEditing(false); setDraft(''); onChanged?.()
          })}>{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}{t('Save')}</button></> : <button disabled={disabled || !copy.editable} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40" onClick={() => { setDraft(detail.content); setEditRevision(detail.revision); setEditing(true) }}><Pencil className="h-3 w-3" />{t('Edit')}</button>}
        </div></div>
        {editing ? <div className="h-[28rem] overflow-hidden rounded-lg border border-border sm:h-[36rem]"><CodeMirrorEditor key={copy.id} content={draft} language="markdown" readOnly={false} onChange={setDraft} className="h-full" /></div> : <div className="overflow-x-auto rounded-lg border border-border-soft bg-secondary/40 p-4 text-sm"><MarkdownRenderer content={skillInstructions(detail.content)} mode="static" /></div>}
      </div>
      {currentGroup && currentGroup.copies.length > 1 && <details open={versionsOpen} onToggle={event => setVersionsOpen(event.currentTarget.open)} className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t('Other versions')}</summary><div className="mt-2 space-y-1">{currentGroup.copies.map(item => <button key={item.id} disabled={disabled || editing || item.id === copy.id} onClick={() => { setDetail(null); setSelectedId(item.id) }} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-secondary disabled:opacity-60"><span>{scopeName(item.spaceId)} · {skillSourceLabel(item, t)}</span>{item.id === copy.id && <Check className="h-3 w-3" />}{!item.enabled && <span>{t('Disabled')}</span>}</button>)}</div></details>}
      {detail.files.length > 1 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t('Supporting files')} ({detail.files.length})</summary><ul className="mt-2 space-y-1">{detail.files.map(file => <li key={file.path} className="break-all font-mono">{file.path}</li>)}</ul></details>}
      <div className="border-t border-border-soft pt-3"><button disabled={disabled} className="inline-flex items-center gap-1.5 rounded-lg border border-halo-error/30 px-3 py-1.5 text-sm text-halo-error transition-colors hover:bg-halo-error/5 disabled:opacity-40" onClick={() => void actions.remove()}><Trash2 className="h-4 w-4" />{t('Delete')}</button></div>
      {copying && <SkillCopyDialog skillRef={ref} name={copy.name} content={editing ? draft : undefined} spaceId={copy.spaceId} onClose={() => setCopying(false)} onSaved={refresh} />}
      {sharing && <ShareCurrentAppDialog appId={copy.appId ?? ''} specOverride={detail.spec} skillRef={ref} onClose={() => setSharing(false)} />}
    </>}
    {actions.DialogComponent}{DialogComponent}{updateFlow.dialogs}
  </div>
}

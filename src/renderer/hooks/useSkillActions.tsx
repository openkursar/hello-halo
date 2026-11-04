import { useEffect, useRef, useState } from 'react'
import type { SkillCopy, SkillRef } from '../../shared/types/skills'
import { api } from '../api'
import { useTranslation } from '../i18n'
import { skillErrorMessage } from '../utils/skill-presentation'
import { useConfirmDialog } from './useConfirmDialog'

export function useSkillActions(ref: SkillRef, onChanged: () => void, onRemoved?: () => void) {
  const { t } = useTranslation()
  const { showConfirm, DialogComponent } = useConfirmDialog()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)
  const identity = `${ref.spaceId}:${ref.id}`
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  async function run(action: () => Promise<void>) {
    if (running.current) return
    running.current = true
    setBusy(true); setError(null)
    try { await action() }
    catch (failure) {
      console.warn('[SkillActions] Skill action failed', { id: ref.id, reason: failure instanceof Error ? failure.message : String(failure) })
      if (mounted.current && currentIdentity.current === identity) setError(skillErrorMessage(failure, t('Could not update this skill. Please try again.'), t))
    } finally {
      running.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function current() {
    const result = await api.skillsRead(ref)
    if (!result.success || !result.data) throw new Error(result.error)
    return result.data
  }

  async function fallback(copy: SkillCopy): Promise<string> {
    if (copy.scope !== 'space') return ''
    const result = await api.skillsList({ spaceId: ref.spaceId, q: copy.name, limit: 100 })
    if (!result.success || !result.data) throw new Error(result.error)
    const group = result.data.groups.find(item => item.name === copy.name.toLowerCase())
    return group?.copies.some(item => item.id !== copy.id && item.scope === 'global' && item.enabled && !['missing', 'invalid', 'conflict'].includes(item.availability))
      ? t('The global version will still be available in this workspace.') : ''
  }

  return {
    busy, error, clearError: () => setError(null), DialogComponent,
    toggle: () => run(async () => {
      const { copy } = await current()
      const note = copy.enabled ? await fallback(copy) : ''
      if (note && !await showConfirm({ title: t('Disable this skill?'), message: note, confirmLabel: t('Disable'), cancelLabel: t('Cancel') })) return
      const result = await api.skillsSetEnabled({ ref, enabled: !copy.enabled })
      if (!result.success) throw new Error(result.error)
      if (mounted.current && currentIdentity.current === identity) onChanged()
    }),
    move: (spaceId: string | null, scopeName: string) => run(async () => {
      const detail = await current()
      if (detail.copy.spaceId === spaceId) return
      const result = await api.skillsMovePreview({ ref, spaceId })
      if (!result.success || !result.data) throw new Error(result.error)
      if (result.data.conflict) throw new Error(result.data.conflict)
      if (!await showConfirm({ title: t('Move this skill?'), message: `${scopeName}\n${t('This moves the skill and its supporting files. It will no longer be available in its previous scope.')}`, confirmLabel: t('Move'), cancelLabel: t('Cancel') })) return
      const moved = await api.skillsMove({ ref, spaceId, revision: detail.revision })
      if (!moved.success) throw new Error(moved.error)
      if (mounted.current && currentIdentity.current === identity) { onChanged(); onRemoved?.() }
    }),
    remove: () => run(async () => {
      const detail = await current()
      const note = await fallback(detail.copy)
      const effect = detail.copy.availability === 'missing'
        ? t('The skill folder is no longer present. Remove this entry from your library?')
        : detail.copy.isLink
          ? t('Only this skill’s link will move to the Trash. The original files will be kept.')
          : t('This skill and its supporting files will move to the Trash.')
      if (!await showConfirm({ title: t('Delete this skill?'), message: `${detail.copy.displayName}\n${effect}\n${note}`, confirmLabel: t('Delete'), cancelLabel: t('Cancel'), variant: 'danger' })) return
      const removed = await api.skillsDelete({ ref, revision: detail.revision })
      if (!removed.success) throw new Error(removed.error)
      if (mounted.current && currentIdentity.current === identity) { onChanged(); onRemoved?.() }
    }),
    openFolder: () => run(async () => {
      const result = await api.skillsOpenFolder(ref)
      if (!result.success) throw new Error(result.error)
    }),
  }
}

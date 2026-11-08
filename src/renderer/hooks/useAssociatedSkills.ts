/**
 * Resolve the skill dependencies a digital human will ship inside its
 * package, and probe whether each already has its own store listing.
 *
 * A DH's spec only carries `requires.skills[]` metadata; the skill content
 * lives in separately-installed skill apps (the same ones the backend's
 * `collectFiles` packages at publish/export time). This mirrors that backend
 * classification via `storeInspectSkillDeps` — including dependencies the
 * author never marked `bundled: true` — so the publish form's "Associated
 * Skills" section shows every skill that is actually about to be packaged,
 * not just the ones explicitly declared bundled.
 *
 * When `appId` is set (an already-installed digital human), the classification
 * runs against that app's own space. When it's absent — the "import a folder"
 * flow, staged client-side and not installed until submit — it falls back to
 * `storeInspectSkillDepsForSpec`, scoped to global-only skill apps to match the
 * throwaway staging space that submit creates for it.
 */

import { useEffect, useState } from 'react'
import { useAppsStore } from '../stores/apps.store'
import { api } from '../api'
import type { AppSpec } from '../../shared/apps/spec-types'

export interface AssociatedSkill {
  appId: string
  specId: string
  name: string
  /** The author declared this dependency `bundled: true`; otherwise it is
   * packaged only because it doesn't resolve from any configured registry. */
  declaredBundled: boolean
  /** True once the skill already has its own listing under this author's slug. */
  published: boolean
}

export interface StoreLinkedSkill {
  specId: string
  name: string
}

export interface AssociatedSkillsResult {
  skills: AssociatedSkill[]
  /** `requires.skills` ids that resolve from no registry and match no
   * installed skill app — publish will abort on these until one is installed. */
  missingSkillIds: string[]
  /** Dependencies that already resolve from a registry — not packaged, but
   * still shown in the list (marked distinctly) so the author can see them. */
  storeLinkedSkills: StoreLinkedSkill[]
  /** Skills the system prompt names that `requires.skills` lacks — left
   * out of the package until declared. */
  undeclaredSkillIds: string[]
  /** Dependencies on a skill folder with no installed app — embedded from
   * disk, but with nothing to list separately. */
  embeddedSkillIds: string[]
  /** Whether the classification above has arrived for the current spec. */
  status: 'loading' | 'ready' | 'error'
}

const EMPTY: Omit<AssociatedSkillsResult, 'status'> = { skills: [], missingSkillIds: [], storeLinkedSkills: [], undeclaredSkillIds: [], embeddedSkillIds: [] }

export function useAssociatedSkills(appId: string | undefined, spec: AppSpec | undefined, author: string): AssociatedSkillsResult {
  const apps = useAppsStore(s => s.apps)
  const [result, setResult] = useState<Omit<AssociatedSkillsResult, 'status'>>(EMPTY)
  const [status, setStatus] = useState<AssociatedSkillsResult['status']>('loading')
  // The spec `result` was computed for. Until a new target's answer arrives the
  // previous lists stay on screen, but its undeclared skills are withheld:
  // declaring them would write one digital human's skills into another.
  const [checkedSpec, setCheckedSpec] = useState<AppSpec | undefined>(undefined)

  // Only a new target shows "checking"; re-runs for author or app-list changes
  // keep the current result on screen.
  useEffect(() => { setStatus('loading') }, [appId, spec])

  useEffect(() => {
    if (spec?.type !== 'automation') { setResult(EMPTY); setStatus('ready'); setCheckedSpec(spec); return }
    let cancelled = false

    const request = appId ? api.storeInspectSkillDeps(appId) : api.storeInspectSkillDepsForSpec(spec)
    request.then(res => {
      if (cancelled) return
      setCheckedSpec(spec)
      if (!res.success || !res.data) { setResult(EMPTY); setStatus('error'); return }
      setStatus('ready')

      const undeclaredSkillIds = res.data.filter(d => !d.declared).map(d => d.id)
      const deps = res.data.filter(d => d.declared)
      const missingSkillIds = deps.filter(d => !d.installed && !d.resolvable).map(d => d.id)
      const embeddedSkillIds = deps.filter(d => d.installed && !d.resolvable && !d.appId).map(d => d.id)

      const storeLinkedSkills = deps
        .filter(d => d.resolvable)
        .map(d => ({ specId: d.id, name: d.storeName ?? d.id }))

      const resolved = deps
        .filter(d => d.installed && !d.resolvable)
        .map(d => {
          const app = apps.find(a => a.id === d.appId)
          return app ? { appId: app.id, specId: d.id, name: app.spec.name, declaredBundled: d.declaredBundled } : null
        })
        .filter((s): s is { appId: string; specId: string; name: string; declaredBundled: boolean } => s !== null)

      if (resolved.length === 0) { setResult({ skills: [], missingSkillIds, storeLinkedSkills, undeclaredSkillIds, embeddedSkillIds }); return }
      setResult({ skills: resolved.map(r => ({ ...r, published: false })), missingSkillIds, storeLinkedSkills, undeclaredSkillIds, embeddedSkillIds })
      Promise.all(resolved.map(async r => {
        try {
          const preview = await api.storePublishPreview(r.appId, author.trim() || undefined)
          return { ...r, published: Boolean(preview.success && preview.data?.storeVersion) }
        } catch {
          return { ...r, published: false }
        }
      })).then(list => { if (!cancelled) setResult({ skills: list, missingSkillIds, storeLinkedSkills, undeclaredSkillIds, embeddedSkillIds }) })
    }).catch(() => { if (!cancelled) { setResult(EMPTY); setStatus('error'); setCheckedSpec(spec) } })

    return () => { cancelled = true }
  }, [appId, spec, apps, author])

  if (checkedSpec !== spec) return { ...result, undeclaredSkillIds: [], status: 'loading' }
  return { ...result, status }
}

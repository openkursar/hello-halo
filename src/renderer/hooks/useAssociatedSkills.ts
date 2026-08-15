/**
 * Resolve the bundled skills a digital human ships with and probe
 * whether each already has its own store listing.
 *
 * A DH's spec only carries `requires.skills[]` metadata; the skill content
 * lives in separately-installed skill apps (the same ones `collectFiles`
 * packages at publish time). We match the bundled deps to those installed apps
 * so the publish form can offer to list each skill independently, and use the
 * publish preview to tell already-published skills apart.
 */

import { useEffect, useMemo, useState } from 'react'
import { useAppsStore } from '../stores/apps.store'
import { api } from '../api'
import { bundledSkillDeps } from '../../shared/apps/bundled-skills'
import type { AppSpec } from '../../shared/apps/spec-types'

export interface AssociatedSkill {
  appId: string
  specId: string
  name: string
  /** True once the skill already has its own listing under this author's slug. */
  published: boolean
}

export function useAssociatedSkills(spec: AppSpec | undefined, author: string): AssociatedSkill[] {
  const apps = useAppsStore(s => s.apps)
  const [skills, setSkills] = useState<AssociatedSkill[]>([])

  const resolved = useMemo(() => {
    if (spec?.type !== 'automation') return []
    const deps = bundledSkillDeps(spec.requires?.skills)
    const out: Array<{ appId: string; specId: string; name: string }> = []
    for (const dep of deps) {
      const app = apps.find(a => a.spec.type === 'skill' && a.specId === dep.id && a.status !== 'uninstalled')
      if (app) out.push({ appId: app.id, specId: dep.id, name: app.spec.name })
    }
    return out
  }, [spec, apps])

  useEffect(() => {
    if (resolved.length === 0) { setSkills([]); return }
    let cancelled = false
    setSkills(resolved.map(r => ({ ...r, published: false })))
    Promise.all(resolved.map(async r => {
      try {
        const res = await api.storePublishPreview(r.appId, author.trim() || undefined)
        return { ...r, published: Boolean(res.success && res.data?.storeVersion) }
      } catch {
        return { ...r, published: false }
      }
    })).then(list => { if (!cancelled) setSkills(list) })
    return () => { cancelled = true }
  }, [resolved, author])

  return skills
}

/**
 * SkillsTab - "Skill" content for the space resource rail
 *
 * Read-only browse of every skill loadable in this space (disk-based, same
 * source AppSkillsSection uses — see main/apps/skill-discovery.ts). No
 * management actions; a row is clickable only when it maps to an installed
 * skill app, and jumps to that app's detail on the digital-humans page,
 * mirroring AppSkillsSection.openDetail.
 */

import { useState, useEffect, useCallback } from 'react'
import { Terminal, Loader2 } from 'lucide-react'
import { api } from '../../api'
import { useSpaceStore } from '../../stores/space.store'
import { useAppsStore } from '../../stores/apps.store'
import { useAppStore } from '../../stores/app.store'
import { useAppsPageStore, tabForAppType } from '../../stores/apps-page.store'
import { useTranslation } from '../../i18n'
import { toSkillDirName } from '../../../shared/skill-naming'
import type { AvailableSkill, InstalledApp } from '../../../shared/apps/app-types'
import { SpaceResourceRow } from './SpaceResourceRow'

export function SkillsTab() {
  const { t } = useTranslation()
  const spaceId = useSpaceStore(state => state.currentSpace?.id ?? '')
  const apps = useAppsStore(state => state.apps)

  const [skills, setSkills] = useState<AvailableSkill[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // AppsPage owns the initial loadApps() call; SkillsTab can render before
    // that page ever mounts, so make sure the installed-apps list this needs
    // for click-through is actually populated.
    useAppsStore.getState().loadApps()
  }, [])

  useEffect(() => {
    if (!spaceId) {
      setSkills([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api.appListAvailableSkillsForSpace(spaceId)
      .then(res => {
        if (cancelled) return
        setSkills(res.success && Array.isArray(res.data) ? res.data : [])
      })
      .catch(() => { if (!cancelled) setSkills([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [spaceId])

  const findInstalled = useCallback((skill: AvailableSkill): InstalledApp | undefined =>
    apps.find(a =>
      a.spec.type === 'skill' &&
      a.status !== 'uninstalled' &&
      (skill.scope === 'global' ? a.spaceId === null : a.spaceId === spaceId) &&
      toSkillDirName(a.specId) === skill.dirName
    ),
  [apps, spaceId])

  const openDetail = useCallback((installedApp: InstalledApp) => {
    useAppStore.getState().navigate('apps')
    const store = useAppsPageStore.getState()
    store.setCurrentTab(tabForAppType('skill'))
    store.selectApp(installedApp.id, 'skill', installedApp.spaceId ?? undefined)
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
      </div>
    )
  }

  if (skills.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-4 py-8">
        <Terminal className="w-8 h-8 text-muted-foreground/40 mb-2" />
        <p className="text-xs text-muted-foreground">{t('No skills available yet.')}</p>
      </div>
    )
  }

  return (
    <div className="p-2 space-y-1.5 overflow-y-auto h-full">
      {skills.map(skill => {
        const installedApp = findInstalled(skill)
        return (
          <SpaceResourceRow
            key={`${skill.scope}:${skill.dirName}`}
            icon={<Terminal className="w-4 h-4" />}
            name={skill.name}
            description={skill.description}
            scope={skill.scope}
            onClick={installedApp ? () => openDetail(installedApp) : undefined}
          />
        )
      })}
    </div>
  )
}

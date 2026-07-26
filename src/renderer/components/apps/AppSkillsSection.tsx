/**
 * AppSkillsSection
 *
 * Lists the skills a digital human can actually load at runtime, fetched via
 * app:list-available-skills (disk discovery — see main/apps/skill-discovery.ts
 * for why the disk, not the installed-apps table, is the source of truth).
 *
 * Skills are ambient (every skill in scope is loadable, not per-app bound), so
 * there is no per-app on/off here. Read-first: each row expands to the rendered
 * SKILL.md. When a skill corresponds to an installed skill app, we surface
 * shortcuts to open its folder / detail (where editing + lifecycle live).
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Terminal, ChevronDown, ChevronRight, Globe, ExternalLink,
  FolderOpen, Download, Loader2,
} from 'lucide-react'
import { api } from '../../api'
import { isElectron } from '../../api/transport'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore, tabForAppType } from '../../stores/apps-page.store'
import { useTranslation } from '../../i18n'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import type { InstalledApp, AvailableSkill } from '../../../shared/apps/app-types'
import { toSkillDirName } from '../../../shared/skill-naming'

interface AppSkillsSectionProps {
  appId: string
  /** The digital human's space — scopes which installed skill app a disk dir maps to. */
  spaceId: string | null
}

/** Strip a leading YAML frontmatter block for clean read-only rendering. */
function stripFrontmatter(md: string): string {
  const m = md.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/)
  return m ? md.slice(m[0].length) : md
}

function SkillRow({
  skill,
  installedApp,
}: {
  skill: AvailableSkill
  installedApp?: InstalledApp
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const isGlobal = skill.scope === 'global'
  const body = stripFrontmatter(skill.content).trim()
  // Reveal works off the on-disk path, so it's available for every skill —
  // including disk-authored ones that have no installed-app record. Desktop-only:
  // Web/Capacitor clients cannot open local folders.
  const canOpenFolder = isElectron() && !!skill.path

  async function openFolder() {
    const res = await api.showArtifactInFolder(skill.path)
    if (!res.success) console.error('[AppSkillsSection] reveal skill folder failed:', res.error)
  }

  function openDetail() {
    if (!installedApp) return
    // Switch the tab too so the left list + tab highlight match the detail.
    const store = useAppsPageStore.getState()
    store.setCurrentTab(tabForAppType('skill'))
    store.selectApp(installedApp.id, 'skill', installedApp.spaceId ?? undefined)
  }

  return (
    <div className="rounded-lg border border-border bg-secondary/40">
      <div className="flex items-center gap-2.5 px-3 py-2">
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
        >
          {expanded
            ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
          <Terminal className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
          <span className="text-sm truncate text-foreground">{skill.name}</span>
        </button>

        {canOpenFolder && (
          <button
            onClick={openFolder}
            title={t('Open skill folder')}
            aria-label={t('Open skill folder')}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors rounded flex-shrink-0"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
        )}

        <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium border flex-shrink-0
          ${isGlobal
            ? 'bg-primary/10 text-primary border-primary/25'
            : 'bg-muted/60 text-muted-foreground border-border/40'}`}
        >
          {isGlobal && <Globe className="w-3 h-3" />}
          {isGlobal ? t('Global') : t('This space')}
        </span>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-2.5 border-t border-border/50">
          {skill.description && (
            <p className="text-xs text-muted-foreground leading-relaxed">{skill.description}</p>
          )}

          {installedApp && (
            <div className="flex items-center justify-end">
              <button
                onClick={openDetail}
                className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                {t('Open skill detail')}
              </button>
            </div>
          )}

          {body ? (
            <div className="rounded-lg bg-secondary/40 border border-border/30 p-3 text-sm overflow-x-auto max-h-80 overflow-y-auto">
              <MarkdownRenderer content={body} mode="static" />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">{t('This skill has no SKILL.md content.')}</p>
          )}
        </div>
      )}
    </div>
  )
}

export function AppSkillsSection({ appId, spaceId }: AppSkillsSectionProps) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)

  const [skills, setSkills] = useState<AvailableSkill[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api.appListAvailableSkills(appId)
      .then((res) => {
        if (cancelled) return
        if (res.success && Array.isArray(res.data)) {
          setSkills(res.data)
        } else {
          setSkills([])
        }
      })
      .catch(() => { if (!cancelled) setSkills([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [appId])

  // Scope must match too: the same dir name can exist as a global install and
  // as space installs in several spaces — dirName alone would pick the wrong one.
  const findInstalled = useCallback((skill: AvailableSkill): InstalledApp | undefined =>
    apps.find(a =>
      a.spec.type === 'skill' &&
      a.status !== 'uninstalled' &&
      (skill.scope === 'global' ? a.spaceId === null : a.spaceId === spaceId) &&
      toSkillDirName(a.specId) === skill.dirName
    ),
  [apps, spaceId])

  const openStore = () => { void useAppsPageStore.getState().openMarketplaceFilteredBy('skill') }

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <Terminal className="w-3.5 h-3.5" />
        {t('Available Skills')}
        {!loading && skills.length > 0 && (
          <span className="text-muted-foreground/60 font-normal normal-case tracking-normal">
            ({skills.length})
          </span>
        )}
      </h3>

      {loading ? (
        <div className="flex items-center justify-center py-4 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      ) : skills.length > 0 ? (
        <>
          <div className="space-y-1.5">
            {skills.map(skill => (
              <SkillRow
                key={`${skill.scope}:${skill.dirName}`}
                skill={skill}
                installedApp={findInstalled(skill)}
              />
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground/60">
              {t('Digital humans can use all skills installed in their space and globally.')}
            </p>
            <button
              onClick={openStore}
              className="flex items-center gap-1 px-2 py-1 text-xs text-primary hover:bg-primary/10 rounded transition-colors flex-shrink-0"
            >
              <Download className="w-3 h-3" />
              {t('Browse')}
            </button>
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-dashed border-border p-4 text-center space-y-2">
          <p className="text-xs text-muted-foreground">
            {t('No skills available in this space yet.')}
          </p>
          <button
            onClick={openStore}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-primary hover:bg-primary/10 rounded transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            {t('Browse skill store')}
          </button>
        </div>
      )}
    </div>
  )
}

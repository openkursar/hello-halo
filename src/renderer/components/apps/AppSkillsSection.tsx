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
  FolderOpen, Download, Loader2, Plus, Upload, Search,
} from 'lucide-react'
import { api } from '../../api'
import { CapabilityStoreDialog } from './CapabilityStoreDialog'
import { ExistingSkillDialog } from './ExistingSkillDialog'
import { SkillInstallDialog } from './SkillInstallDialog'
import { SkillInfoCard } from './SkillInfoCard'
import { CapabilityDialog } from './CapabilityDialog'
import { isElectron } from '../../api/transport'
import { useAppsStore } from '../../stores/apps.store'
import { useTranslation } from '../../i18n'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { APP_TYPE_GLYPH } from '../store/app-type-glyph'
import type { InstalledApp, AvailableSkill } from '../../../shared/apps/app-types'
import { toSkillDirName } from '../../../shared/skill-naming'

const SkillGlyph = APP_TYPE_GLYPH.skill

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
  overridesGlobal,
}: {
  skill: AvailableSkill
  installedApp?: InstalledApp
  overridesGlobal?: boolean
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [showDetail, setShowDetail] = useState(false)

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
    setShowDetail(true)
  }

  return (
    <div className="rounded-lg border border-border bg-secondary/40">
      {showDetail && installedApp && <CapabilityDialog title={t('Shared skill settings')} onClose={() => setShowDetail(false)}><SkillInfoCard appId={installedApp.id} /></CapabilityDialog>}
      <div className="flex items-center gap-2.5 px-3 py-2">
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
        >
          {expanded
            ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
          <SkillGlyph className="w-3.5 h-3.5 flex-shrink-0 text-app-skill" />
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
          {isGlobal ? t('Global') : t('This workspace')}
        </span>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-2.5 border-t border-border/50">
          {!installedApp && <p className="text-xs text-muted-foreground">{t('External file. Edit it in its source folder; it is not managed as an installed library item.')}</p>}
          {overridesGlobal && <p className="text-xs text-muted-foreground">{t('This workspace version overrides the global skill with the same command name.')}</p>}
          {installedApp?.spec.requires?.mcps?.length ? <p className="text-xs text-muted-foreground">{t('Required connections: {{names}}', { names: installedApp.spec.requires.mcps.map(dependency => dependency.id).join(', ') })}</p> : null}
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
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [addMode, setAddMode] = useState<'visual' | 'import' | null>(null)
  const [query, setQuery] = useState('')
  const [chooseExisting, setChooseExisting] = useState(false)
  const [showStore, setShowStore] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    api.appListAvailableSkills(appId)
      .then((res) => {
        if (cancelled) return
        if (res.success && Array.isArray(res.data)) {
          setSkills(res.data)
        } else {
          console.warn('[AppSkillsSection] Failed to load available skills', { appId })
          setError(res.error || t('Could not load available skills.'))
        }
      })
      .catch(() => { if (!cancelled) { console.warn('[AppSkillsSection] Skill discovery request failed', { appId }); setError(t('Could not load available skills.')) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [appId, spaceId, apps, revision, t])

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

  const openStore = () => setShowStore(true)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
        <SkillGlyph className="w-3.5 h-3.5" />
        {t('Available Skills')}
        {!loading && skills.length > 0 && (
          <span className="text-muted-foreground/60 font-normal normal-case tracking-normal">
            ({skills.length})
          </span>
        )}
      </h3>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setChooseExisting(true)} className="rounded-lg px-2 py-1 text-xs text-primary hover:bg-primary/10">{t('Choose existing')}</button>
        <button onClick={() => setAddMode('visual')} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-primary hover:bg-primary/10"><Plus className="h-3.5 w-3.5" />{t('New skill')}</button>
        <button onClick={() => setAddMode('import')} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-primary hover:bg-primary/10"><Upload className="h-3.5 w-3.5" />{t('Import')}</button>
      </div></div>
      <p className="text-xs text-muted-foreground">{t('Skills are inherited from this workspace and global settings. Changes can affect other digital humans in the same scope.')}</p>
      <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"><Search className="h-4 w-4 text-muted-foreground" /><input value={query} onChange={event => setQuery(event.target.value)} aria-label={t('Search skills')} placeholder={t('Search skills')} className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label>
      {showStore && <CapabilityStoreDialog type="skill" spaceId={spaceId} onClose={() => setShowStore(false)} onInstalled={async () => { setRevision(value => value + 1) }} />}
      {chooseExisting && <ExistingSkillDialog spaceId={spaceId} onClose={() => setChooseExisting(false)} onAdded={() => setRevision(value => value + 1)} />}
      {addMode && <SkillInstallDialog draftKey={appId} initialMode={addMode} initialSpaceId={spaceId} onClose={() => setAddMode(null)} onInstalled={() => setRevision(value => value + 1)} />}
      {error && <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-xs text-destructive">{error}<button onClick={() => setRevision(value => value + 1)} className="ml-3 text-primary">{t('Retry')}</button></div>}
      {loading ? (
        <div className="flex items-center justify-center py-4 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      ) : skills.length > 0 ? (
        <>
          {query && !skills.some(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && <p className="text-xs text-muted-foreground">{t('No skills match your search.')}</p>}
          <div className="space-y-1.5">
            {skills.filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(skill => (
              <SkillRow
                key={`${skill.scope}:${skill.dirName}`}
                skill={skill}
                installedApp={findInstalled(skill)}
                overridesGlobal={skill.scope === 'space' && apps.some(app => app.spec.type === 'skill' && app.spaceId === null && app.status !== 'uninstalled' && toSkillDirName(app.specId) === skill.dirName)}
              />
            ))}
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground/60">
              {t('Digital humans can use all skills installed in their workspace and globally.')}
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
            {t('No skills available in this workspace yet.')}
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

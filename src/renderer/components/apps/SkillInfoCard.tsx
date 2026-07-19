/**
 * SkillInfoCard
 *
 * Right-panel detail view for a Skill-type app. Provides:
 *  - Scope badge (Global / space-scoped) with interactive space selector
 *  - Enable/disable toggle
 *  - Trigger command reference
 *  - Description (plain text)
 *  - SKILL.md viewer (MarkdownRenderer) + inline editor (CodeMirror markdown)
 *  - Open skill folder in OS file manager
 *  - Uninstall action
 *
 * Enable/Disable maps to app:pause / app:resume — disabled skills are excluded
 * from conversation context injection.
 *
 * Space selector: clicking the scope badge opens a dropdown to move the skill
 * to a different space (or to global scope) without uninstalling and reinstalling.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Terminal,
  Unplug,
  Loader2,
  FolderOpen,
  Globe,
  Pencil,
  X,
  Check,
  ChevronDown,
  AlertCircle,
  Share2,
} from 'lucide-react'
import { useAppsStore } from '../../stores/apps.store'
import { useSpaceStore } from '../../stores/space.store'
import { AppStatusDot } from './AppStatusDot'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { CodeMirrorEditor } from '../canvas/viewers/CodeMirrorEditor'
import { api } from '../../api'
import { ShareCurrentAppDialog } from '../store/ShareCurrentAppDialog'
import type { AppStatus } from '../../../shared/apps/app-types'
import type { SkillSpec } from '../../../shared/apps/spec-types'

// ============================================
// Props
// ============================================

interface SkillInfoCardProps {
  appId: string
  /** Display name for the scope: resolved space name, or the translated "Global" string */
  spaceName?: string
}

// ============================================
// Helpers
// ============================================

function statusLabel(status: AppStatus, t: (s: string) => string): string {
  switch (status) {
    case 'active':  return t('Enabled')
    case 'paused':  return t('Disabled')
    case 'error':   return t('Error')
    default:        return String(status)
  }
}

/**
 * Extract the primary SKILL.md content from a skill spec.
 * skill_files takes priority (registry installs); falls back to skill_content.
 */
function getSkillContent(spec: SkillSpec): string {
  return spec.skill_files?.['SKILL.md'] ?? spec.skill_content ?? ''
}

/**
 * Build the spec patch needed to update SKILL.md content.
 * Preserves all other files in skill_files when present.
 */
function buildSkillContentPatch(
  spec: SkillSpec,
  newContent: string
): Record<string, unknown> {
  if (spec.skill_files) {
    return { skill_files: { ...spec.skill_files, 'SKILL.md': newContent } }
  }
  return { skill_content: newContent }
}

// ============================================
// Component
// ============================================

export function SkillInfoCard({ appId, spaceName }: SkillInfoCardProps) {
  const { t } = useTranslation()
  const { apps, pauseApp, resumeApp, uninstallApp, updateAppSpec, moveAppToSpace } = useAppsStore()
  const spaces    = useSpaceStore(s => s.spaces)
  const haloSpace = useSpaceStore(s => s.haloSpace)
  const app = apps.find(a => a.id === appId)

  const [toggling, setToggling]         = useState(false)
  const [toggleError, setToggleError]   = useState<string | null>(null)
  const [isEditing, setIsEditing]       = useState(false)
  const [draftContent, setDraft]        = useState('')
  const [saving, setSaving]             = useState(false)
  const [saveError, setSaveError]       = useState<string | null>(null)
  const [moving, setMoving]             = useState(false)
  const [moveError, setMoveError]       = useState<string | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [showShareDialog, setShowShareDialog] = useState(false)
  const dropdownRef                     = useRef<HTMLDivElement>(null)

  // Close the space dropdown when the user clicks outside it
  useEffect(() => {
    if (!dropdownOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [dropdownOpen])

  // When the selected skill changes, discard any in-progress edit.
  // Using useEffect (not an inline setState in render) to avoid extra render cycles.
  useEffect(() => {
    setIsEditing(false)
    setDraft('')
    setToggleError(null)
    setSaveError(null)
    setMoveError(null)
  }, [appId])

  if (!app) return null

  const { name, description } = resolveSpecI18n(app.spec, getCurrentLanguage())
  const spec       = app.spec as SkillSpec
  const status     = app.status
  const isEnabled  = status === 'active'
  const canToggle  = status === 'active' || status === 'paused' || status === 'error'
  const isGlobal   = app.spaceId === null

  const triggerCommand  = `/${spec.name.toLowerCase().replace(/\s+/g, '-')}`
  const skillContent    = getSkillContent(spec)
  const hasSkillContent = skillContent.length > 0

  // Build the ordered space list for the selector.
  // haloSpace (the primary Halo workspace) is shown first, then dedicated spaces.
  const allSpaces = [
    ...(haloSpace ? [haloSpace] : []),
    ...spaces.filter(s => !haloSpace || s.id !== haloSpace.id),
  ]

  // ── Handlers ──────────────────────────────

  const handleToggle = async () => {
    if (!canToggle || toggling) return
    setToggling(true)
    setToggleError(null)
    try {
      await (isEnabled ? pauseApp(appId) : resumeApp(appId))
    } catch (e) {
      setToggleError((e as Error).message)
    } finally {
      setToggling(false)
    }
  }

  const handleStartEdit = () => {
    setDraft(skillContent)
    setSaveError(null)
    setIsEditing(true)
  }

  const handleCancelEdit = () => {
    setIsEditing(false)
    setDraft('')
    setSaveError(null)
  }

  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const ok = await updateAppSpec(appId, buildSkillContentPatch(spec, draftContent))
      if (ok) {
        setIsEditing(false)
        setDraft('')
      } else {
        setSaveError(t('Save failed. Please try again.'))
      }
    } catch (e) {
      setSaveError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleOpenFolder = useCallback(async () => {
    const res = await api.appOpenSkillFolder(appId)
    if (!res.success) {
      console.error('[SkillInfoCard] appOpenSkillFolder failed:', res.error)
    }
  }, [appId])

  const handleMoveToSpace = async (newSpaceId: string | null) => {
    if (moving || newSpaceId === app.spaceId) {
      setDropdownOpen(false)
      return
    }
    setDropdownOpen(false)
    setMoveError(null)
    setMoving(true)
    try {
      const ok = await moveAppToSpace(appId, newSpaceId)
      if (!ok) {
        setMoveError(t('Failed to move skill. Please try again.'))
      }
    } catch (e) {
      setMoveError((e as Error).message)
    } finally {
      setMoving(false)
    }
  }

  // ── Render ────────────────────────────────

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground truncate">{name}</h2>

          {/* Author + scope badge row */}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <p className="text-xs text-muted-foreground">
              {t('by')} {spec.author}
            </p>

            {/* Scope badge — interactive dropdown to switch the skill's space */}
            <div ref={dropdownRef} className="relative">
              <button
                type="button"
                disabled={moving}
                onClick={() => setDropdownOpen(prev => !prev)}
                title={t('Click to change space')}
                className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium border
                  transition-colors cursor-pointer select-none
                  disabled:opacity-60 disabled:cursor-not-allowed
                  ${isGlobal
                    ? 'bg-blue-500/10 text-blue-400 border-blue-500/25 hover:bg-blue-500/20'
                    : 'bg-muted/60 text-muted-foreground border-border/40 hover:bg-muted'
                  }`}
              >
                {moving ? (
                  <Loader2 className="w-3 h-3 flex-shrink-0 animate-spin" />
                ) : (
                  isGlobal && <Globe className="w-3 h-3 flex-shrink-0" />
                )}
                <span>
                  {isGlobal
                    ? t('Takes effect in all spaces')
                    : t('Takes effect in {{space}} space', { space: spaceName })}
                </span>
                {!moving && <ChevronDown className="w-3 h-3 flex-shrink-0 opacity-60" />}
              </button>

              {/* Space selector dropdown */}
              {dropdownOpen && (
                <div className={`
                  absolute left-0 top-full mt-1 z-50 min-w-[180px]
                  bg-popover border border-border rounded-lg shadow-lg
                  py-1 text-[12px]
                `}>
                  {/* Global option */}
                  <button
                    type="button"
                    onClick={() => handleMoveToSpace(null)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left
                      hover:bg-muted/60 transition-colors
                      ${app.spaceId === null ? 'text-blue-400 font-medium' : 'text-foreground'}`}
                  >
                    <Globe className="w-3 h-3 flex-shrink-0" />
                    {t('Global (all spaces)')}
                    {app.spaceId === null && (
                      <Check className="w-3 h-3 ml-auto flex-shrink-0" />
                    )}
                  </button>

                  {/* Divider */}
                  {allSpaces.length > 0 && (
                    <div className="my-1 border-t border-border/50" />
                  )}

                  {/* Per-space options */}
                  {allSpaces.map(space => (
                    <button
                      key={space.id}
                      type="button"
                      onClick={() => handleMoveToSpace(space.id)}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left
                        hover:bg-muted/60 transition-colors
                        ${app.spaceId === space.id ? 'text-foreground font-medium' : 'text-muted-foreground'}`}
                    >
                      <span className="truncate">{space.name}</span>
                      {app.spaceId === space.id && (
                        <Check className="w-3 h-3 ml-auto flex-shrink-0 text-foreground" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Status indicator + inline toggle */}
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <AppStatusDot status={status} size="sm" />
              <span>{statusLabel(status, t)}</span>
            </div>
            <button
              type="button"
              onClick={() => setShowShareDialog(true)}
              title={t('Share')}
              aria-label={t('Share')}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded-md transition-colors"
            >
              <Share2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              role="switch"
              aria-label={isEnabled ? t('Disable') : t('Enable')}
              aria-checked={isEnabled}
              disabled={!canToggle || toggling}
              onClick={handleToggle}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors duration-200
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2
                disabled:opacity-50 disabled:cursor-not-allowed
                ${isEnabled ? 'bg-primary' : 'bg-muted'}`}
            >
              {toggling ? (
                <Loader2 className="absolute inset-0 m-auto w-3.5 h-3.5 animate-spin text-white/70" />
              ) : (
                <span
                  className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm
                    transform transition-transform duration-200 mt-0.5
                    ${isEnabled ? 'translate-x-5' : 'translate-x-0.5'}`}
                />
              )}
            </button>
          </div>
          {toggleError && (
            <div className="flex items-center gap-1 text-[11px] text-red-500">
              <AlertCircle className="w-3 h-3 flex-shrink-0" />
              <span>{toggleError}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Move error ── */}
      {moveError && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {moveError}
        </div>
      )}

      {/* ── How to use ── */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5" />
          {t('How to use')}
        </h3>
        <div className="bg-secondary rounded-lg p-3 text-xs font-mono text-foreground">
          {triggerCommand} [arguments]
        </div>
        <p className="text-xs text-muted-foreground">
          {t('Invoke this skill by typing the command above in any conversation.')}
        </p>
      </div>

      {/* ── Description (plain text) ── */}
      {description && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('Description')}
          </h3>
          <p className="text-sm text-foreground leading-relaxed">{description}</p>
        </div>
      )}

      {/* ── Skill Instructions (SKILL.md) ── */}
      {(hasSkillContent || isEditing) && (
        <div className="space-y-2">

          {/* Section header with view/edit toggle */}
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('Skill Instructions')}
            </h3>

            <div className="flex items-center gap-1.5">
              {/* Open skill folder — always visible, useful alongside editing */}
              <button
                onClick={handleOpenFolder}
                title={t('Open skill folder')}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </button>

              {!isEditing ? (
                <button
                  onClick={handleStartEdit}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Pencil className="w-3 h-3" />
                  {t('Edit')}
                </button>
              ) : (
                <>
                  <button
                    onClick={handleCancelEdit}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X className="w-3 h-3" />
                    {t('Cancel')}
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors disabled:opacity-50"
                  >
                    {saving
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <Check className="w-3 h-3" />}
                    {t('Save')}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Save error — shown below the section header */}
          {saveError && (
            <div className="flex items-center gap-1.5 text-xs text-red-500">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{saveError}</span>
            </div>
          )}

          {/* Content area: rendered markdown OR CodeMirror editor */}
          {isEditing ? (
            <div className="rounded-lg overflow-hidden border border-border" style={{ height: '36rem' }}>
              {/*
                key={appId} ensures the editor remounts if the user switches skills
                while edit mode is open. content prop is the initial value only —
                ongoing changes are tracked via onChange → draftContent state.
              */}
              <CodeMirrorEditor
                key={appId}
                content={draftContent}
                language="markdown"
                readOnly={false}
                onChange={setDraft}
                className="h-full"
              />
            </div>
          ) : (
            <div className="rounded-lg bg-secondary/40 border border-border/30 p-4 text-sm overflow-x-auto">
              <MarkdownRenderer content={skillContent} mode="static" />
            </div>
          )}
        </div>
      )}

      {/* ── Danger zone ── */}
      <div className="pt-2 border-t border-border">
        <button
          onClick={() => uninstallApp(appId)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-400 hover:text-red-300
            border border-red-400/30 hover:border-red-400/60 rounded-lg transition-colors"
        >
          <Unplug className="w-4 h-4" />
          {t('Uninstall')}
        </button>
      </div>

      {showShareDialog && (
        <ShareCurrentAppDialog
          appId={appId}
          onClose={() => setShowShareDialog(false)}
        />
      )}

    </div>
  )
}

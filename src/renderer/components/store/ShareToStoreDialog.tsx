/**
 * ShareToStoreDialog
 *
 * "I want to share SOMETHING but haven't picked it yet" entry — opened from
 * the store header. Lets the user pick a type (Digital Human / Skill) and a
 * source (one of their installed apps, or import from file/folder).
 *
 * Sources accepted (per type tab):
 *   - From installed: pick one of your already-installed apps (most common)
 *   - Import: unified drop zone accepting files and folders alike
 *
 * Backed by the existing `api.storePublish` IPC. For file/folder sources we
 * install locally first to obtain an `appId`, then publish. On publish failure
 * we attempt a rollback uninstall so the user is not left with a stray app.
 *
 * For the per-app Share buttons on detail pages (AutomationHeader,
 * SkillInfoCard), use `ShareCurrentAppDialog` instead — there the app is
 * already known, and publish/export actions live together.
 */

import { useState, useMemo, useCallback, useEffect } from 'react'
import {
  X,
  Loader2,
  Share2,
  Bot,
  BookOpen,
  FolderOpen,
  AlertCircle,
  CheckCircle2,
  Archive,
  FileText,
  HelpCircle,
} from 'lucide-react'
import { parse as parseYaml } from 'yaml'
import { useAppsStore } from '../../stores/apps.store'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { InstalledApp } from '../../../shared/apps/app-types'
import type { AppSpec, AutomationSpec, SkillSpec } from '../../../shared/apps/spec-types'
import {
  processMdFile,
  processDirectoryEntry,
  processFileListAsFolder,
  processZipFile,
  type ParsedSkill,
} from '../apps/skill-import-utils'
import {
  parseDigitalHumanZip,
  parseDigitalHumanFolder,
  type ZipParseResult,
} from '../apps/zip-import-utils'
import { readDirectoryEntryToMap, readFileListToMap } from '../apps/file-read-utils'
import { FileImportZone } from '../apps/FileImportZone'
import { AuthorField } from './AuthorField'
import { loadStoredAuthor, saveAuthor } from './publish-author'

// ────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────

type ShareType = 'automation' | 'skill'
type ShareSource = 'installed' | 'import'

/** A staged spec ready for publish (parsed but not yet installed) */
interface StagedSpec {
  spec: AppSpec
  /** Display label for the preview card */
  label: string
  /** Source icon hint */
  origin: 'file' | 'folder'
  /** Skill-only: extra files keyed by relative path */
  skillFiles?: Record<string, string>
}

export interface ShareToStoreDialogProps {
  onClose: () => void
}

// ────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────

export function ShareToStoreDialog({ onClose }: ShareToStoreDialogProps) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const loadApps = useAppsStore(s => s.loadApps)

  const [type, setType] = useState<ShareType>('automation')
  const [source, setSource] = useState<ShareSource>('installed')

  // Installed source state
  const installedOfType = useMemo(
    () => apps.filter(a => a.spec.type === type && a.status !== 'uninstalled'),
    [apps, type]
  )
  const [selectedInstalledId, setSelectedInstalledId] = useState<string | null>(null)

  // Re-sync selected installed when type changes
  useEffect(() => {
    setSelectedInstalledId(installedOfType[0]?.id ?? null)
  }, [type, installedOfType])

  // File / folder source state
  const [staged, setStaged] = useState<StagedSpec | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [parsing, setParsing] = useState(false)

  // Author — required for publish; persisted across share flows.
  const [author, setAuthor] = useState(loadStoredAuthor)

  // Submit state
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null)

  // Reset staged when type/source changes
  useEffect(() => {
    setStaged(null)
    setParseError(null)
    setSubmitError(null)
    setSubmitSuccess(null)
  }, [type, source])

  // ── Parsers ──────────────────────────────────

  const parseSkillFromMd = useCallback(async (file: File) => {
    const parsed = await processMdFile(file)
    stageSkill(parsed, file.name, 'file')
  }, [])

  const parseSkillFromZip = useCallback(async (file: File) => {
    const parsed = await processZipFile(file)
    stageSkill(parsed, file.name, 'file')
  }, [])

  const parseSkillFromDirEntry = useCallback(async (entry: FileSystemDirectoryEntry) => {
    const parsed = await processDirectoryEntry(entry)
    stageSkill(parsed, entry.name, 'folder')
  }, [])

  const parseSkillFromFileList = useCallback(async (fileList: FileList) => {
    const parsed = await processFileListAsFolder(fileList)
    const folderName = fileList[0]?.webkitRelativePath.split('/')[0] ?? 'folder'
    stageSkill(parsed, folderName, 'folder')
  }, [])

  function stageSkill(parsed: ParsedSkill, label: string, origin: 'file' | 'folder') {
    const spec: SkillSpec = {
      spec_version: '1.0',
      version: '1.0',
      name: parsed.name,
      description: parsed.description || `Skill: ${parsed.name}`,
      type: 'skill',
      skill_files: parsed.skillFiles,
    }
    setStaged({ spec, label, origin, skillFiles: parsed.skillFiles })
  }

  const parseAutomationZip = useCallback(async (file: File) => {
    const outcome = await parseDigitalHumanZip(file)
    if (!outcome.ok) {
      throw new Error(outcome.errors.map(e => `${e.location}: ${e.actual} — ${e.suggestion}`).join('\n'))
    }
    stageAutomation(outcome.result, file.name, 'file')
  }, [])

  const parseAutomationFolder = useCallback(async (files: Record<string, string>, folderName: string) => {
    const outcome = await parseDigitalHumanFolder(files, folderName)
    if (!outcome.ok) {
      throw new Error(outcome.errors.map(e => `${e.location}: ${e.actual} — ${e.suggestion}`).join('\n'))
    }
    stageAutomation(outcome.result, folderName, 'folder')
  }, [])

  const parseAutomationYaml = useCallback(async (file: File) => {
    const text = await file.text()
    let raw: unknown
    try {
      raw = parseYaml(text)
    } catch (err) {
      throw new Error(t('Invalid YAML: {{message}}', { message: (err as Error).message }))
    }
    if (!raw || typeof raw !== 'object') {
      throw new Error(t('Spec file is empty or malformed.'))
    }
    // Cast trusted — backend will revalidate via Zod on install.
    const spec = raw as AutomationSpec
    if (spec.type !== 'automation') {
      throw new Error(t('This YAML is not an automation spec (type must be "automation").'))
    }
    setStaged({ spec, label: file.name, origin: 'file' })
  }, [t])

  function stageAutomation(result: ZipParseResult, label: string, origin: 'file' | 'folder') {
    // Re-parse yamlContent into an AutomationSpec. parseDigitalHumanZip already
    // validated structure; here we just need the typed object to ship to install.
    const spec = parseYaml(result.yamlContent) as AutomationSpec
    setStaged({ spec, label, origin })
  }

  // ── File handlers ────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    setParseError(null)
    setStaged(null)
    setParsing(true)
    try {
      const lower = file.name.toLowerCase()
      if (type === 'skill') {
        if (lower.endsWith('.md')) await parseSkillFromMd(file)
        else if (lower.endsWith('.zip')) await parseSkillFromZip(file)
        else throw new Error(t('Unsupported file. Drop a .md or .zip for a skill.'))
      } else {
        if (lower.endsWith('.zip') || lower.endsWith('.dhpkg')) await parseAutomationZip(file)
        else if (lower.endsWith('.yaml') || lower.endsWith('.yml')) await parseAutomationYaml(file)
        else throw new Error(t('Unsupported file. Drop a .zip, .dhpkg, or .yaml for a digital human.'))
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : t('Failed to parse file.'))
    } finally {
      setParsing(false)
    }
  }, [type, parseSkillFromMd, parseSkillFromZip, parseAutomationZip, parseAutomationYaml, t])

  const handleFolder = useCallback(async (entry: FileSystemDirectoryEntry) => {
    setParseError(null)
    setStaged(null)
    setParsing(true)
    try {
      if (type === 'skill') {
        await parseSkillFromDirEntry(entry)
      } else {
        const flat = await readDirectoryEntryToMap(entry)
        await parseAutomationFolder(flat, entry.name)
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : t('Failed to parse folder.'))
    } finally {
      setParsing(false)
    }
  }, [type, parseSkillFromDirEntry, parseAutomationFolder, t])

  const handleFolderList = useCallback(async (files: FileList) => {
    setParseError(null)
    setStaged(null)
    setParsing(true)
    try {
      if (type === 'skill') {
        await parseSkillFromFileList(files)
      } else {
        const { files: map, folderName } = await readFileListToMap(files)
        await parseAutomationFolder(map, folderName || t('Folder'))
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : t('Failed to parse folder.'))
    } finally {
      setParsing(false)
    }
  }, [type, parseSkillFromFileList, parseAutomationFolder, t])

  // ── Submit ───────────────────────────────────

  const handleSubmit = useCallback(async () => {
    setSubmitError(null)
    setSubmitSuccess(null)

    const trimmedAuthor = author.trim()
    if (!trimmedAuthor) {
      setSubmitError(t('Author is required'))
      return
    }

    setSubmitting(true)

    try {
      let appIdToPublish: string
      let didInstall = false

      if (source === 'installed') {
        if (!selectedInstalledId) {
          throw new Error(t('Please pick an installed item to share.'))
        }
        appIdToPublish = selectedInstalledId
      } else {
        if (!staged) {
          throw new Error(t('No file or folder loaded yet.'))
        }
        // Install locally first so we have a stable appId for publish.
        const installRes = await api.appInstall({ spaceId: null, spec: staged.spec })
        const installedId = (installRes.data as { appId?: string } | undefined)?.appId
        if (!installRes.success || !installedId) {
          throw new Error(installRes.error ?? t('Install failed before publish.'))
        }
        appIdToPublish = installedId
        didInstall = true
      }

      // Publish to registry
      const pubRes = await api.storePublish(appIdToPublish, trimmedAuthor)
      if (!pubRes.success) {
        // Rollback the just-installed app so the user is not left with a stray entry.
        if (didInstall) {
          await api.appUninstall(appIdToPublish, { purge: true }).catch(() => undefined)
        }
        throw new Error(pubRes.error ?? t('Publish failed.'))
      }

      // Refresh installed list (the install path adds an app the store doesn't yet know about)
      if (didInstall) {
        await loadApps()
      }

      saveAuthor(trimmedAuthor)
      const details = (pubRes.data as { details?: string } | undefined)?.details
      setSubmitSuccess(details ?? t('Shared to store successfully.'))
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('Share failed.'))
    } finally {
      setSubmitting(false)
    }
  }, [source, selectedInstalledId, staged, author, loadApps, t])

  // ── Derived ──────────────────────────────────

  const canSubmit =
    !submitting && !parsing && !!author.trim() && (
      source === 'installed'
        ? !!selectedInstalledId
        : !!staged
    )

  // ── Render ───────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={onClose}
    >
      <div
        className="relative w-full max-w-2xl bg-background border border-border rounded-xl shadow-xl flex flex-col max-h-[90vh]"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Share2 className="w-4 h-4 text-primary flex-shrink-0" />
            <h2 className="text-sm font-semibold truncate">{t('Share to Store')}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
            aria-label={t('Close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {/* Friendly hint banner */}
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-primary/5 border border-primary/15 text-xs text-foreground">
            <HelpCircle className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />
            <span>
              {t('Share your Digital Human or Skill to the store so others can install and reuse it.')}
            </span>
          </div>

          {/* Type tabs */}
          <div className="flex items-center gap-1 p-0.5 bg-secondary rounded-lg w-fit">
            <TypeTab
              active={type === 'automation'}
              onClick={() => setType('automation')}
              icon={Bot}
              label={t('Digital Human')}
            />
            <TypeTab
              active={type === 'skill'}
              onClick={() => setType('skill')}
              icon={BookOpen}
              label={t('Skill')}
            />
          </div>

          {/* Source segmented control */}
          <div className="flex flex-col sm:flex-row gap-1 sm:gap-0.5 p-0.5 bg-secondary rounded-lg">
            <SourceSeg
              active={source === 'installed'}
              onClick={() => setSource('installed')}
              label={t('From installed')}
            />
            <SourceSeg
              active={source === 'import'}
              onClick={() => setSource('import')}
              label={t('Import')}
            />
          </div>

          {/* Source body */}
          {source === 'installed' ? (
            <InstalledPicker
              apps={installedOfType}
              selectedId={selectedInstalledId}
              onSelect={setSelectedInstalledId}
              type={type}
            />
          ) : staged ? (
            <StagedPreview staged={staged} onClear={() => { setStaged(null); setParseError(null) }} />
          ) : (
            <FileImportZone
              onFile={handleFile}
              onDirectoryEntry={handleFolder}
              onFolderFileList={handleFolderList}
              fileAccept={type === 'skill' ? '.md,.zip' : '.zip,.dhpkg,.yaml,.yml'}
              dropLabel={type === 'skill'
                ? t('Drop a skill file or folder here')
                : t('Drop a digital human file or folder here')}
              dropHint={type === 'skill'
                ? t('.md file · skill folder · .zip archive')
                : t('.zip · .dhpkg · .yaml · folder')}
              folderLabel={type === 'skill'
                ? t('Browse skill folder...')
                : t('Browse digital human folder...')}
              processing={parsing}
            >
              {parseError && (
                <div className="flex items-start gap-2 text-xs text-red-400">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span className="whitespace-pre-wrap break-words">{parseError}</span>
                </div>
              )}
            </FileImportZone>
          )}

          {/* Author — required for publish */}
          {!submitSuccess && (
            <AuthorField
              value={author}
              onChange={v => { setAuthor(v); setSubmitError(null) }}
            />
          )}

          {/* Submit feedback */}
          {submitError && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span className="whitespace-pre-wrap break-words">{submitError}</span>
            </div>
          )}
          {submitSuccess && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span className="whitespace-pre-wrap break-words">{submitSuccess}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-secondary transition-colors"
          >
            {submitSuccess ? t('Done') : t('Cancel')}
          </button>
          {!submitSuccess && (
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Share2 className="w-3.5 h-3.5" />
              )}
              {submitting ? t('Sharing...') : t('Share to Store')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────

interface TypeTabProps {
  active: boolean
  onClick: () => void
  icon: typeof Bot
  label: string
}

function TypeTab({ active, onClick, icon: Icon, label }: TypeTabProps) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors ${
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  )
}

interface SourceSegProps {
  active: boolean
  onClick: () => void
  label: string
}

function SourceSeg({ active, onClick, label }: SourceSegProps) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-3 py-1.5 text-xs rounded-md transition-colors ${
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
    </button>
  )
}

interface InstalledPickerProps {
  apps: InstalledApp[]
  selectedId: string | null
  onSelect: (id: string) => void
  type: ShareType
}

function InstalledPicker({ apps, selectedId, onSelect, type }: InstalledPickerProps) {
  const { t } = useTranslation()

  if (apps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-center bg-secondary/30 border border-dashed border-border rounded-lg">
        <AlertCircle className="w-5 h-5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          {type === 'automation'
            ? t('No installed digital humans to share. Install or create one first.')
            : t('No installed skills to share. Install or create one first.')}
        </p>
      </div>
    )
  }

  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1.5">
        {type === 'automation' ? t('Pick a digital human to share') : t('Pick a skill to share')}
      </label>
      <select
        value={selectedId ?? ''}
        onChange={e => onSelect(e.target.value)}
        className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
      >
        {apps.map(a => (
          <option key={a.id} value={a.id}>
            {a.spec.name} {a.spec.version ? `· v${a.spec.version}` : ''}
          </option>
        ))}
      </select>
    </div>
  )
}


interface StagedPreviewProps {
  staged: StagedSpec
  onClear: () => void
}

function StagedPreview({ staged, onClear }: StagedPreviewProps) {
  const { t } = useTranslation()
  const Icon = staged.origin === 'folder' ? FolderOpen : staged.label.toLowerCase().endsWith('.zip') || staged.label.toLowerCase().endsWith('.dhpkg') ? Archive : FileText
  const fileCount = staged.skillFiles ? Object.keys(staged.skillFiles).length : undefined

  return (
    <div className="flex items-start gap-3 p-3 bg-secondary/60 rounded-lg border border-border">
      <Icon className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground truncate">{staged.spec.name}</p>
        <p className="text-xs text-muted-foreground truncate">
          <span className="font-mono">{staged.label}</span>
          {staged.spec.version && <> · v{staged.spec.version}</>}
          {fileCount !== undefined && <> · {fileCount === 1 ? t('1 file') : t('{{count}} files', { count: fileCount })}</>}
        </p>
        {staged.spec.description && (
          <p className="text-xs text-muted-foreground/80 mt-1 line-clamp-2">{staged.spec.description}</p>
        )}
      </div>
      <button
        onClick={onClear}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
      >
        {t('Clear')}
      </button>
    </div>
  )
}


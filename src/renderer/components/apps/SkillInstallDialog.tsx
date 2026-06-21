/**
 * SkillInstallDialog
 *
 * Modal dialog for creating / installing a Skill.
 * Three modes:
 *   - Visual (default): simple form — name, description, body content
 *   - MD: full CodeMirror editor with pre-filled SKILL.md frontmatter template;
 *         two-way sync with Visual mode
 *   - Import: drag-and-drop / browse supporting:
 *       • Single .md file  → single-file skill (auto-wrapped as SKILL.md)
 *       • Folder (via webkitdirectory or drag)  → multi-file skill; must contain SKILL.md
 *       • .zip file  → extracted; must contain SKILL.md at root or in a single top folder
 *     Clear error feedback for any unsupported / malformed input.
 */

import {
  useState,
  useMemo,
  useCallback,
  lazy,
  Suspense,
} from 'react'
import { X, Loader2, FolderOpen, FileText, Archive, AlertCircle } from 'lucide-react'
import { useAppsStore } from '../../stores/apps.store'
import { useSpaceStore } from '../../stores/space.store'
import { useTranslation } from '../../i18n'
import type { SkillSpec } from '../../../shared/apps/spec-types'
import {
  toSlug,
  buildMdFromForm,
  parseMd,
  processMdFile,
  processDirectoryEntry,
  processFileListAsFolder,
  processZipFile,
  type ParsedSkill,
} from './skill-import-utils'
import { FileImportZone } from './FileImportZone'

// Lazy-load CodeMirrorEditor to keep initial bundle small
const CodeMirrorEditor = lazy(() =>
  import('../canvas/viewers/CodeMirrorEditor').then(m => ({ default: m.CodeMirrorEditor }))
)

// ============================================
// Types
// ============================================

type SkillMode = 'visual' | 'md' | 'import'

interface VisualForm {
  name: string
  description: string
  /** Markdown content body — everything after the frontmatter */
  bodyContent: string
}

const INITIAL_FORM: VisualForm = {
  name: '',
  description: '',
  bodyContent: '',
}

// Pure parse utilities live in ./skill-import-utils so the Add Skill,
// Share to Store, and Install from File entry points share identical logic.

// ============================================
// ImportDropZone sub-component
// ============================================

/** Describes what the user has loaded, before they confirm install */
interface ImportedSkill {
  parsed: ParsedSkill
  /** Display label for the loaded source (filename / folder name) */
  label: string
  /** Icon type for display */
  sourceType: 'md' | 'folder' | 'zip'
}

interface ImportDropZoneProps {
  imported: ImportedSkill | null
  onImported: (skill: ImportedSkill) => void
  onClear: () => void
  onError: (msg: string) => void
}

function ImportDropZone({ imported, onImported, onClear, onError }: ImportDropZoneProps) {
  const { t } = useTranslation()
  const [processing, setProcessing] = useState(false)

  const handleProcess = useCallback(async (task: () => Promise<ImportedSkill>) => {
    setProcessing(true)
    try {
      const result = await task()
      onImported(result)
    } catch (err) {
      onError(err instanceof Error ? err.message : t('Failed to read file'))
    } finally {
      setProcessing(false)
    }
  }, [onImported, onError, t])

  const handleFile = useCallback(async (file: File) => {
    onError('')
    const name = file.name.toLowerCase()
    if (name.endsWith('.md')) {
      await handleProcess(async () => ({
        parsed: await processMdFile(file),
        label: file.name,
        sourceType: 'md' as const,
      }))
    } else if (name.endsWith('.zip')) {
      await handleProcess(async () => ({
        parsed: await processZipFile(file),
        label: file.name,
        sourceType: 'zip' as const,
      }))
    } else {
      onError(t('Unsupported file type. Drop a .md file, a .zip archive, or a skill folder.'))
    }
  }, [handleProcess, onError, t])

  const handleDirEntry = useCallback(async (entry: FileSystemDirectoryEntry) => {
    onError('')
    await handleProcess(async () => ({
      parsed: await processDirectoryEntry(entry),
      label: entry.name,
      sourceType: 'folder' as const,
    }))
  }, [handleProcess, onError])

  const handleFolderList = useCallback(async (files: FileList) => {
    onError('')
    await handleProcess(async () => ({
      parsed: await processFileListAsFolder(files),
      label: files[0].webkitRelativePath.split('/')[0] || t('Folder'),
      sourceType: 'folder' as const,
    }))
  }, [handleProcess, onError, t])

  if (imported) {
    const Icon = imported.sourceType === 'folder' ? FolderOpen
      : imported.sourceType === 'zip' ? Archive
      : FileText
    const fileCount = Object.keys(imported.parsed.skillFiles).length

    return (
      <div className="space-y-3">
        {/* Loaded file summary */}
        <div className="flex items-center justify-between p-3 bg-secondary rounded-lg border border-border">
          <div className="flex items-center gap-2.5 min-w-0">
            <Icon className="w-4 h-4 text-primary flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground truncate">{imported.label}</p>
              <p className="text-xs text-muted-foreground">
                {fileCount === 1
                  ? t('1 file')
                  : t('{{count}} files', { count: fileCount })}
                {imported.parsed.name && (
                  <> · <span className="font-mono">/{imported.parsed.name}</span></>
                )}
              </p>
            </div>
          </div>
          <button
            onClick={onClear}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 ml-2"
          >
            {t('Clear')}
          </button>
        </div>

        {/* SKILL.md preview */}
        <Suspense fallback={
          <div className="h-56 flex items-center justify-center bg-secondary rounded-lg border border-border">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        }>
          <div className="h-56 border border-border rounded-lg overflow-hidden">
            <CodeMirrorEditor
              content={imported.parsed.skillFiles['SKILL.md'] ?? ''}
              language="markdown"
              readOnly={true}
            />
          </div>
        </Suspense>
      </div>
    )
  }

  return (
    <FileImportZone
      onFile={handleFile}
      onDirectoryEntry={handleDirEntry}
      onFolderFileList={handleFolderList}
      fileAccept=".md,.zip"
      dropLabel={t('Drop a skill file or folder here')}
      dropHint={t('.md file · skill folder · .zip archive')}
      folderLabel={t('Browse skill folder...')}
      processing={processing}
    >
      {/* Format hints */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t('Supported formats')}
        </p>
        <div className="space-y-1">
          {[
            { Icon: FileText, label: t('Single .md file'), sub: t('Treated as a one-file skill; auto-named SKILL.md') },
            { Icon: FolderOpen, label: t('Skill folder'), sub: t('Must contain SKILL.md at the root level') },
            { Icon: Archive, label: t('.zip archive'), sub: t('May contain files at root or inside a single folder') },
          ].map(({ Icon, label, sub }) => (
            <div key={label} className="flex items-start gap-2 px-2 py-1.5">
              <Icon className="w-3.5 h-3.5 text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-xs text-foreground">{label}</span>
                <span className="text-xs text-muted-foreground"> — {sub}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </FileImportZone>
  )
}

// ============================================
// Main component
// ============================================

export interface SkillInstallDialogProps {
  onClose: () => void
}

export function SkillInstallDialog({ onClose }: SkillInstallDialogProps) {
  const { t } = useTranslation()
  const { installApp, loadApps } = useAppsStore()

  // Spaces
  const currentSpace = useSpaceStore(state => state.currentSpace)
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const spaces = useSpaceStore(state => state.spaces)

  // All spaces, plus a sentinel '' = global
  const allSpaces = useMemo(() => {
    const result: Array<{ id: string; name: string }> = [
      { id: '', name: t('Global (all spaces)') },
    ]
    if (haloSpace) result.push({ id: haloSpace.id, name: haloSpace.name })
    result.push(...spaces.map(s => ({ id: s.id, name: s.name })))
    return result
  }, [haloSpace, spaces, t])

  // Default: current space if any, else global
  const [selectedSpaceId, setSelectedSpaceId] = useState(currentSpace?.id ?? '')

  // Mode
  const [mode, setMode] = useState<SkillMode>('visual')

  // Visual form state
  const [form, setForm] = useState<VisualForm>({ ...INITIAL_FORM })

  // MD editor state
  const [mdContent, setMdContent] = useState(buildMdFromForm(INITIAL_FORM))

  // Import state
  const [imported, setImported] = useState<ImportedSkill | null>(null)

  // UI state
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // ── Form field helper ──
  const updateField = useCallback(<K extends keyof VisualForm>(key: K, val: VisualForm[K]) => {
    setForm(prev => ({ ...prev, [key]: val }))
    setError(null)
  }, [])

  // ── Mode switching ──
  const handleSwitchToMd = useCallback(() => {
    setError(null)
    // Serialize current form into MD (only if the form has something)
    if (form.name || form.description || form.bodyContent) {
      setMdContent(buildMdFromForm(form))
    }
    setMode('md')
  }, [form])

  const handleSwitchToVisual = useCallback(() => {
    setError(null)
    // Try to parse MD back into form fields
    const { name, description, bodyContent } = parseMd(mdContent)
    setForm({
      name: name || form.name,
      description: description || form.description,
      bodyContent: bodyContent || form.bodyContent,
    })
    setMode('visual')
  }, [mdContent, form])

  // ── Build spec and install ──
  async function handleInstall() {
    setError(null)
    setLoading(true)

    try {
      let spec: Omit<SkillSpec, 'spec_version' | 'version' | 'author'>

      if (mode === 'import') {
        if (!imported) {
          setError(t('No skill loaded. Drop a file or folder first.'))
          setLoading(false)
          return
        }
        const { name, description, skillFiles } = imported.parsed
        if (!name) {
          setError(t('Could not determine skill name. Make sure SKILL.md has a name field in its frontmatter.'))
          setLoading(false)
          return
        }
        spec = {
          name,
          description: description || `Skill: ${name}`,
          type: 'skill',
          skill_files: skillFiles,
        }
      } else {
        // Visual or MD mode
        let name: string
        let description: string
        let skillContent: string

        if (mode === 'md') {
          const parsed = parseMd(mdContent)
          name = parsed.name
          description = parsed.description
          skillContent = mdContent
        } else {
          // Visual mode — build MD from form
          if (!form.name.trim()) {
            setError(t('Skill name is required'))
            setLoading(false)
            return
          }
          name = toSlug(form.name)
          description = form.description.trim() || `Skill: ${name}`
          skillContent = buildMdFromForm(form)
        }

        if (!name) {
          setError(t('Skill name is required. Add a "name:" field in the frontmatter.'))
          setLoading(false)
          return
        }

        spec = {
          name,
          description: description || `Skill: ${name}`,
          type: 'skill',
          skill_content: skillContent,
        }
      }

      const fullSpec: SkillSpec = {
        spec_version: '1.0',
        version: '1.0',
        ...spec,
      }

      const spaceId = selectedSpaceId || null
      const appId = await installApp(spaceId, fullSpec)
      if (appId) {
        await loadApps()
        onClose()
      } else {
        setError(t('Installation failed. Check the skill content and try again.'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Installation failed'))
    } finally {
      setLoading(false)
    }
  }

  const canInstall =
    mode === 'import'
      ? imported !== null
      : mode === 'md'
        ? mdContent.trim().length > 0
        : form.name.trim().length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        className="relative w-full max-w-2xl mx-4 bg-background border border-border rounded-xl shadow-xl flex flex-col max-h-[90vh]"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">{t('Add Skill')}</h2>

            {/* Mode toggle */}
            <div className="flex items-center gap-0.5 bg-secondary rounded-lg p-0.5">
              <button
                onClick={() => mode !== 'visual' && handleSwitchToVisual()}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  mode === 'visual'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('Visual')}
              </button>
              <button
                onClick={() => mode !== 'md' && handleSwitchToMd()}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  mode === 'md'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                MD
              </button>
              <button
                onClick={() => { setError(null); setMode('import') }}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  mode === 'import'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('Import')}
              </button>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground rounded-md transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 overflow-y-auto flex-1">
          {mode === 'visual' && (
            <>
              <p className="text-xs text-muted-foreground">
                {t('Create a skill using the form below, or switch to MD for full control.')}
              </p>

              {/* Name */}
              <div className="space-y-1.5">
                <label className="text-sm text-foreground">
                  {t('Skill Name')} <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => updateField('name', e.target.value)}
                  placeholder={t('e.g. code-review-guidelines')}
                  className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
                  autoFocus
                />
                {form.name && (
                  <p className="text-xs text-muted-foreground font-mono">
                    /{toSlug(form.name)}
                  </p>
                )}
              </div>

              {/* Description */}
              <div className="space-y-1.5">
                <label className="text-sm text-foreground">
                  {t('Description')}
                </label>
                <input
                  type="text"
                  value={form.description}
                  onChange={e => updateField('description', e.target.value)}
                  placeholder={t('When should the AI use this skill?')}
                  className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
                />
              </div>

              {/* Content */}
              <div className="space-y-1.5">
                <label className="text-sm text-foreground">
                  {t('Instructions')}
                  <span className="text-muted-foreground font-normal ml-1">(Markdown)</span>
                </label>
                <textarea
                  value={form.bodyContent}
                  onChange={e => updateField('bodyContent', e.target.value)}
                  rows={8}
                  placeholder={t('Write the skill instructions here in Markdown...')}
                  className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg resize-none focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50 font-mono"
                  spellCheck={false}
                />
              </div>
            </>
          )}

          {mode === 'md' && (
            <>
              <p className="text-xs text-muted-foreground">
                {t('Edit the full SKILL.md content directly. The frontmatter name and description fields are required.')}
              </p>
              <Suspense fallback={
                <div className="h-80 flex items-center justify-center bg-secondary rounded-lg border border-border">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              }>
                <div className="h-80 border border-border rounded-lg overflow-hidden">
                  <CodeMirrorEditor
                    content={mdContent}
                    language="markdown"
                    readOnly={false}
                    onChange={setMdContent}
                  />
                </div>
              </Suspense>
            </>
          )}

          {mode === 'import' && (
            <>
              <p className="text-xs text-muted-foreground">
                {t('Import a skill from a local file or folder.')}
              </p>
              <ImportDropZone
                imported={imported}
                onImported={skill => { setImported(skill); setError(null) }}
                onClear={() => { setImported(null); setError(null) }}
                onError={msg => { if (msg) setError(msg) }}
              />
            </>
          )}

          {/* Space selector */}
          <div className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('Install to')}
            </h3>
            {allSpaces.length <= 1 ? (
              <p className="text-sm text-foreground">
                {allSpaces[0]?.name ?? t('No spaces available')}
              </p>
            ) : (
              <select
                value={selectedSpaceId}
                onChange={e => setSelectedSpaceId(e.target.value)}
                className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
              >
                {allSpaces.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 bg-destructive/10 border border-destructive/20 rounded-lg">
              <AlertCircle className="w-3.5 h-3.5 text-destructive mt-0.5 flex-shrink-0" />
              <p className="text-xs text-destructive">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-border flex-shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('Cancel')}
          </button>
          <button
            onClick={handleInstall}
            disabled={loading || !canInstall}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {t('Install Skill')}
          </button>
        </div>
      </div>
    </div>
  )
}

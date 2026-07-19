/**
 * AppInstallDialog
 *
 * Modal dialog for creating / installing an App.
 * Three modes:
 *   - Visual (default): structured form for the common case (type=automation)
 *   - YAML: full CodeMirror editor with a complete example template
 *   - Import: unified drop zone for .yaml, .zip, or folder — all handled inline
 *
 * Import tab state machine:
 *   idle → loading → error | yaml-preview | bundle-preview → installing → success | partial | failed
 */

import { useState, useMemo, useCallback, useRef, lazy, Suspense } from 'react'
import {
  X,
  Loader2,
  Sparkles,
  Archive,
  FolderOpen,
  Bot,
  Puzzle,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  ChevronDown,
} from 'lucide-react'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { useAppsStore, AppApiError } from '../../stores/apps.store'
import { useSpaceStore } from '../../stores/space.store'
import { useTranslation } from '../../i18n'
import { CreateSpaceForm } from '../space/CreateSpaceForm'
import type { AppSpec, SkillSpec } from '../../../shared/apps/spec-types'
import { AppModelSelector } from './AppModelSelector'
import { SystemPromptEditor } from './SystemPromptEditor'
import { Switch } from '../ui/Switch'
import { SchedulePicker } from './SchedulePicker'
import {
  isValidPreset,
  type ScheduleValue,
} from './schedule-utils'
import {
  parseDigitalHumanZip,
  parseDigitalHumanFolder,
  type ZipParseResult,
  type ZipValidationError,
} from './zip-import-utils'
import { readFileText, readDirectoryEntryToMap, readFileListToMap } from './file-read-utils'
import { FileImportZone } from './FileImportZone'

// Lazy-load CodeMirrorEditor to keep initial bundle small
const CodeMirrorEditor = lazy(() =>
  import('../canvas/viewers/CodeMirrorEditor').then(m => ({ default: m.CodeMirrorEditor }))
)

// ============================================
// Constants
// ============================================

type InstallMode = 'visual' | 'yaml' | 'import'

const DEFAULT_YAML_TEMPLATE = `\
# ============================================
# Halo Digital Human Spec - Complete Example
# ============================================
# This template shows ALL available fields.
# Delete or modify sections as needed.

spec_version: "1.0"
name: "HN Daily Digest"
version: "1.0"
author: me
description: "Fetch Hacker News top stories and send a daily summary"
type: automation

# -- Core Instruction --
# The system_prompt is the "soul" of your app.
# It tells the AI what to do on each run.
system_prompt: |
  You are an HN information assistant. On each trigger:
  1. Open https://news.ycombinator.com and get today's Top 10 stories
  2. For each story, write a concise Chinese summary (2-3 sentences)
  3. Format as a clean digest with title, link, and summary
  4. Report completion via report_to_user(type="run_complete")

  If you encounter any issues, use
  report_to_user(type="escalation") to ask the user for help.

# -- Schedule --
# Use "every" for intervals or "cron" for cron expressions.
subscriptions:
  - id: daily-check
    source:
      type: schedule
      config:
        every: "1d"
        # cron: "0 8 * * *"    # Alternative: daily at 8am
    frequency:
      default: "1d"
      min: "1h"
      max: "1d"

# -- User Configuration --
# Fields shown to the user during install and in settings.
config_schema:
  - key: email
    label: "Notification Email"
    type: email
    required: false
    placeholder: "you@example.com"
    description: "Optional email for digest delivery"
  - key: story_count
    label: "Number of Stories"
    type: number
    default: 10
    description: "How many top stories to include"

# -- Dependencies --
# MCP servers and skills this app needs.
requires:
  mcps:
    - id: ai-browser
      reason: "Browse Hacker News to fetch stories"

# -- Memory --
# What the AI should remember across runs.
memory_schema:
  seen_stories:
    type: array
    description: "Story IDs already included in past digests"
  last_digest_date:
    type: date
    description: "Date of the last successful digest"

# -- Filters (zero LLM cost) --
# filters:
#   - field: story_score
#     op: gt
#     value: 50

# -- Output --
output:
  notify:
    system: true
    # channels: [email, wecom]   # Optional external channels
  format: "HN Digest: {story_count} stories"

# -- Escalation --
escalation:
  enabled: true
  timeout_hours: 24

# -- Permissions --
permissions:
  - browser.navigate
  - notification.send
`

// ============================================
// Helpers — Visual/YAML modes
// ============================================

interface VisualFormState {
  name: string
  description: string
  author: string
  systemPrompt: string
  frequency: string
  scheduleEnabled: boolean
  scheduleValue: ScheduleValue
}

const INITIAL_FORM: VisualFormState = {
  name: '',
  description: '',
  author: '',
  systemPrompt: '',
  frequency: '1h',
  scheduleEnabled: true,
  scheduleValue: { type: 'every', every: '1h' },
}

function buildSpecFromForm(form: VisualFormState): AppSpec {
  const spec: AppSpec = {
    spec_version: '1.0',
    name: form.name.trim(),
    version: '1.0',
    author: form.author.trim(),
    description: form.description.trim(),
    type: 'automation',
    system_prompt: form.systemPrompt.trim(),
  }

  if (form.scheduleEnabled) {
    const sv = form.scheduleValue
    const config = sv.type === 'every'
      ? { every: sv.every }
      : { cron: sv.cron }
    spec.subscriptions = [
      { source: { type: 'schedule' as const, config } },
    ]
  }

  return spec
}

function extractFormFromParsed(parsed: Record<string, unknown>): {
  frequency: string
  scheduleEnabled: boolean
  scheduleValue: ScheduleValue
} {
  try {
    const subs = parsed.subscriptions as Array<Record<string, unknown>> | undefined
    if (!subs || subs.length === 0) {
      return { frequency: '1h', scheduleEnabled: false, scheduleValue: { type: 'every', every: '1h' } }
    }
    const source = subs[0]?.source as Record<string, unknown> | undefined
    if (!source || source.type !== 'schedule') {
      return { frequency: '1h', scheduleEnabled: false, scheduleValue: { type: 'every', every: '1h' } }
    }
    const config = source.config as Record<string, unknown> | undefined
    if (config?.cron) {
      return {
        frequency: '1h',
        scheduleEnabled: true,
        scheduleValue: { type: 'cron', cron: config.cron as string },
      }
    }
    const every = (config?.every as string) ?? '1h'
    return {
      frequency: isValidPreset(every) ? every : '1h',
      scheduleEnabled: true,
      scheduleValue: { type: 'every', every },
    }
  } catch {
    return { frequency: '1h', scheduleEnabled: true, scheduleValue: { type: 'every', every: '1h' } }
  }
}

function parseSkillFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return { name: '', description: '' }
  const fm = match[1]
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? ''
  return { name, description }
}

// ============================================
// Import tab state machine types
// ============================================

interface SkillInstallResult {
  name: string
  success: boolean
  error?: string
}

/**
 * Translate an install/import failure to user-facing copy.
 * Routes known `AppApiError.code` discriminators to localized strings;
 * falls back to the backend's raw `.message` for unexpected failures.
 *
 * Kept at module scope (pure function) so `t` is the single source of
 * translation and call sites stay short.
 */
function formatInstallError(
  err: unknown,
  t: (key: string, opts?: Record<string, unknown>) => string,
  context: 'skill' | 'digital_human',
): string {
  if (err instanceof AppApiError && err.code === 'ALREADY_INSTALLED') {
    return context === 'skill'
      ? t('A skill with the same name already exists. Uninstall it first or rename your skill before retrying.')
      : t('A digital human with the same name already exists in this space. Uninstall it first or rename your digital human before retrying.')
  }
  if (err instanceof Error) return err.message
  return t('Installation failed')
}

interface InstallProgress {
  currentStep: string
  currentIndex: number
  totalSteps: number
}

type ImportState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; errors: ZipValidationError[] }
  // Single .yaml file loaded — show raw YAML preview in CodeMirror
  | { phase: 'yaml-preview'; yamlContent: string; fileName: string }
  // .zip or folder parsed — show structured preview with bundled skills
  | { phase: 'bundle-preview'; result: ZipParseResult; fileName: string; sourceType: 'zip' | 'folder' }
  | { phase: 'installing'; result: ZipParseResult; progress: InstallProgress }
  | { phase: 'success'; result: ZipParseResult; skillResults: SkillInstallResult[] }
  | { phase: 'partial'; result: ZipParseResult; skillResults: SkillInstallResult[] }
  | { phase: 'failed'; result: ZipParseResult; error: string; skillResults: SkillInstallResult[] }

// ============================================
// Component
// ============================================

interface AppInstallDialogProps {
  onClose: () => void
}

export function AppInstallDialog({ onClose }: AppInstallDialogProps) {
  const { t } = useTranslation()
  const { installApp, importApp, loadApps, updateAppOverrides } = useAppsStore()

  const currentSpace = useSpaceStore(state => state.currentSpace)
  const spaces = useSpaceStore(state => state.spaces)

  // Exclude halo-temp: digital humans must be installed in a dedicated space
  const dedicatedSpaces = useMemo(() => spaces, [spaces])

  const [mode, setMode] = useState<InstallMode>('visual')
  const [form, setForm] = useState<VisualFormState>({ ...INITIAL_FORM })
  const [yamlContent, setYamlContent] = useState(DEFAULT_YAML_TEMPLATE)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [modelSourceId, setModelSourceId] = useState<string | undefined>(undefined)
  const [modelId, setModelId] = useState<string | undefined>(undefined)

  const [selectedSpaceId, setSelectedSpaceId] = useState(
    // Skip halo-temp as default; fall back to first dedicated space
    (currentSpace && !currentSpace.isTemp ? currentSpace.id : null) ?? dedicatedSpaces[0]?.id ?? ''
  )

  const [showCreateSpaceForm, setShowCreateSpaceForm] = useState(false)

  // Import tab state machine
  const [importState, setImportState] = useState<ImportState>({ phase: 'idle' })
  const bodyScrollRef = useRef<HTMLDivElement>(null)

  // ── Form field updater ──
  const updateField = useCallback(<K extends keyof VisualFormState>(key: K, value: VisualFormState[K]) => {
    setForm(prev => ({ ...prev, [key]: value }))
    setError(null)
  }, [])

  // ── Mode switching ──
  const handleSwitchToYaml = useCallback(() => {
    setError(null)
    if (form.name || form.systemPrompt) {
      const spec = buildSpecFromForm(form)
      setYamlContent(stringifyYaml(spec, { lineWidth: 0 }))
    } else {
      setYamlContent(DEFAULT_YAML_TEMPLATE)
    }
    setMode('yaml')
  }, [form])

  const handleSwitchToVisual = useCallback(() => {
    setError(null)
    try {
      const parsed = parseYaml(yamlContent) as Record<string, unknown> | null
      if (parsed && typeof parsed === 'object') {
        const { frequency, scheduleEnabled, scheduleValue } = extractFormFromParsed(parsed)
        setForm({
          name: String(parsed.name ?? ''),
          description: String(parsed.description ?? ''),
          author: String(parsed.author ?? ''),
          systemPrompt: String(parsed.system_prompt ?? ''),
          frequency,
          scheduleEnabled,
          scheduleValue,
        })
      }
    } catch {
      setError(t('Could not parse YAML. Some fields may be empty.'))
    }
    setMode('visual')
  }, [yamlContent, t])

  // ── Import: process a .yaml file ──
  const processYamlFile = useCallback(async (file: File) => {
    setImportState({ phase: 'loading' })
    try {
      const content = await readFileText(file)
      setImportState({ phase: 'yaml-preview', yamlContent: content, fileName: file.name })
    } catch {
      setImportState({
        phase: 'error',
        errors: [{
          location: file.name,
          expected: 'Readable text file',
          actual: 'Failed to read file',
          suggestion: 'Make sure the file is accessible and try again.',
        }],
      })
    }
  }, [])

  // ── Import: process a .zip file ──
  const processZipFile = useCallback(async (file: File) => {
    setImportState({ phase: 'loading' })
    const outcome = await parseDigitalHumanZip(file)
    if (!outcome.ok) {
      setImportState({ phase: 'error', errors: outcome.errors })
      return
    }
    setImportState({ phase: 'bundle-preview', result: outcome.result, fileName: file.name, sourceType: 'zip' })
  }, [])

  // ── Import: process a dragged folder (DataTransferItem API) ──
  const processDirectoryEntry = useCallback(async (entry: FileSystemDirectoryEntry) => {
    setImportState({ phase: 'loading' })
    try {
      const files = await readDirectoryEntryToMap(entry)
      const outcome = await parseDigitalHumanFolder(files, entry.name)
      if (!outcome.ok) {
        setImportState({ phase: 'error', errors: outcome.errors })
        return
      }
      setImportState({ phase: 'bundle-preview', result: outcome.result, fileName: entry.name, sourceType: 'folder' })
    } catch {
      setImportState({
        phase: 'error',
        errors: [{
          location: entry.name,
          expected: 'Readable folder',
          actual: 'Failed to read folder contents',
          suggestion: 'Make sure the folder is accessible and try again.',
        }],
      })
    }
  }, [])

  // ── Import: process a folder selected via webkitdirectory ──
  const processFileList = useCallback(async (fileList: FileList) => {
    setImportState({ phase: 'loading' })
    try {
      const { files, folderName } = await readFileListToMap(fileList)
      const outcome = await parseDigitalHumanFolder(files, folderName)
      if (!outcome.ok) {
        setImportState({ phase: 'error', errors: outcome.errors })
        return
      }
      setImportState({ phase: 'bundle-preview', result: outcome.result, fileName: folderName, sourceType: 'folder' })
    } catch {
      setImportState({
        phase: 'error',
        errors: [{
          location: 'selected folder',
          expected: 'Readable folder',
          actual: 'Failed to read folder contents',
          suggestion: 'Make sure the folder is accessible and try again.',
        }],
      })
    }
  }, [])

  // ── Import: file handler (routes by extension) ──
  const handleImportFile = useCallback(async (file: File) => {
    const name = file.name.toLowerCase()
    if (name.endsWith('.zip')) {
      await processZipFile(file)
    } else {
      await processYamlFile(file)
    }
  }, [processYamlFile, processZipFile])

  const handleImportReset = useCallback(() => {
    setImportState({ phase: 'idle' })
  }, [])

  // ── Install: simple yaml import ──
  const handleYamlInstall = useCallback(async (yamlStr: string) => {
    setLoading(true)
    try {
      await importApp(selectedSpaceId, yamlStr)
      await loadApps()
      onClose()
    } catch (err) {
      setError(formatInstallError(err, t, 'digital_human'))
    } finally {
      setLoading(false)
    }
  }, [selectedSpaceId, importApp, loadApps, onClose, t])

  // ── Install: bundle (zip/folder) ──
  const handleBundleInstall = useCallback(async (result: ZipParseResult) => {
    const totalSteps = result.bundledSkills.length + 1
    const skillResults: SkillInstallResult[] = []

    // Phase 1: install bundled skills first
    for (let i = 0; i < result.bundledSkills.length; i++) {
      const skill = result.bundledSkills[i]
      setImportState(prev => ({
        ...prev,
        phase: 'installing',
        result,
        progress: {
          currentStep: t('Installing skill {{name}}...', { name: skill.name }),
          currentIndex: i + 1,
          totalSteps,
        },
      } as ImportState))

      try {
        const { name, description } = parseSkillFrontmatter(skill.files['SKILL.md'] ?? '')
        const skillSpec: SkillSpec = {
          spec_version: '1.0',
          version: '1.0',
          name: name || skill.name,
          description: description || `Bundled skill: ${skill.name}`,
          type: 'skill',
          skill_files: skill.files,
        }
        // Backend overwrites same-name skills in place, so a fresh
        // install and a re-install of an existing skill both return
        // success here. Real failures (e.g. spec validation) are
        // captured in the catch and reported to the user.
        await installApp(selectedSpaceId || null, skillSpec)
        skillResults.push({ name: skill.name, success: true })
      } catch (err) {
        skillResults.push({
          name: skill.name,
          success: false,
          error: formatInstallError(err, t, 'skill'),
        })
      }
    }

    // Phase 2: install main spec
    setImportState({
      phase: 'installing',
      result,
      progress: {
        currentStep: t('Installing digital human...'),
        currentIndex: totalSteps,
        totalSteps,
      },
    })

    try {
      await importApp(selectedSpaceId, result.yamlContent)
      await loadApps()
      const failedSkills = skillResults.filter(s => !s.success)
      if (failedSkills.length > 0) {
        setImportState({ phase: 'partial', result, skillResults })
      } else {
        setImportState({ phase: 'success', result, skillResults })
      }
    } catch (err) {
      setImportState({
        phase: 'failed',
        result,
        error: formatInstallError(err, t, 'digital_human'),
        skillResults,
      })
    }
  }, [selectedSpaceId, installApp, importApp, loadApps, t])

  // ── Install handler (visual / yaml modes) ──
  async function handleCreateInstall() {
    setError(null)
    setLoading(true)

    try {
      let specObj: AppSpec

      if (mode === 'visual') {
        if (!form.name.trim()) { setError(t('App name is required')); setLoading(false); return }
        if (!form.description.trim()) { setError(t('Description is required')); setLoading(false); return }
        if (!form.author.trim()) { setError(t('Author is required')); setLoading(false); return }
        if (!form.systemPrompt.trim()) { setError(t('System prompt is required')); setLoading(false); return }
        specObj = buildSpecFromForm(form)
      } else {
        try {
          specObj = parseYaml(yamlContent) as AppSpec
        } catch {
          setError(t('Invalid YAML format. Please check your spec.'))
          setLoading(false)
          return
        }
        if (!specObj || typeof specObj !== 'object') {
          setError(t('YAML must be an object'))
          setLoading(false)
          return
        }
      }

      const appId = await installApp(selectedSpaceId, specObj)
      if (appId) {
        if (modelSourceId) {
          await updateAppOverrides(appId, { modelSourceId, modelId })
        }
        await loadApps()
        onClose()
      } else {
        setError(t('Installation failed. Check the spec and try again.'))
      }
    } catch (err) {
      // Skills are installed via the Visual/YAML mode only when the user
      // explicitly writes type: 'skill'; default mode produces automation
      // apps. Treat as digital human for messaging — skill conflicts are
      // already overwritten silently by the backend.
      setError(formatInstallError(err, t, 'digital_human'))
    } finally {
      setLoading(false)
    }
  }

  const canCreate = dedicatedSpaces.length > 0 && (mode === 'yaml'
    ? yamlContent.trim().length > 0
    : (form.name.trim().length > 0 && form.systemPrompt.trim().length > 0))

  // ── Render ──
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        className="relative w-full max-w-2xl mx-4 bg-background border border-border rounded-xl shadow-xl flex flex-col max-h-[90vh]"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold">{t('Create Digital Human')}</h2>

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
                onClick={() => mode !== 'yaml' && handleSwitchToYaml()}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  mode === 'yaml'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('YAML')}
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
        <div ref={bodyScrollRef} className="p-4 space-y-4 overflow-y-auto flex-1">
          {mode === 'visual' ? (
            <>
              <p className="text-xs text-muted-foreground">
                {t('Create a new digital human using the visual form, or switch to YAML for full control.')}
              </p>

              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/10">
                <Sparkles className="w-3.5 h-3.5 text-primary mt-0.5 flex-shrink-0" />
                <p className="text-xs text-muted-foreground">
                  {t('You can also tell AI to create one for you through natural language in any space chat.')}
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm text-foreground">
                  {t('App Name')} <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => updateField('name', e.target.value)}
                  placeholder={t('My Digital Human')}
                  className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm text-foreground">
                  {t('Description')} <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={form.description}
                  onChange={e => updateField('description', e.target.value)}
                  placeholder={t('What does this app do?')}
                  className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm text-foreground">
                  {t('Author')} <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={form.author}
                  onChange={e => updateField('author', e.target.value)}
                  placeholder={t('Your name')}
                  className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm text-foreground">
                  {t('System Prompt')} <span className="text-red-400">*</span>
                </label>
                <SystemPromptEditor
                  value={form.systemPrompt}
                  onChange={v => updateField('systemPrompt', v)}
                  placeholder={t('Describe what this app should do on each scheduled run. This is the core instruction that drives the AI.')}
                  required
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('Schedule')}
                  </h3>
                  <Switch
                    checked={form.scheduleEnabled}
                    onCheckedChange={checked => {
                      setForm(prev => ({ ...prev, scheduleEnabled: checked }))
                      setError(null)
                    }}
                    size="sm"
                  />
                </div>
                {form.scheduleEnabled ? (
                  <SchedulePicker
                    value={form.scheduleValue}
                    onChange={sv => setForm(prev => ({ ...prev, scheduleValue: sv }))}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('No scheduled trigger. This app can be triggered manually or via IM bot.')}
                  </p>
                )}
              </div>
            </>
          ) : mode === 'yaml' ? (
            <>
              <p className="text-xs text-muted-foreground">
                {t('Edit the YAML spec directly. This template includes all available fields for a digital human.')}
              </p>
              <Suspense fallback={
                <div className="h-80 flex items-center justify-center bg-secondary rounded-lg border border-border">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              }>
                <div className="h-80 border border-border rounded-lg overflow-hidden">
                  <CodeMirrorEditor
                    content={yamlContent}
                    language="yaml"
                    readOnly={false}
                    onChange={setYamlContent}
                  />
                </div>
              </Suspense>
            </>
          ) : (
            /* ── Import mode ── */
            <ImportTab
              importState={importState}
              allSpaces={dedicatedSpaces}
              selectedSpaceId={selectedSpaceId}
              onSelectedSpaceChange={setSelectedSpaceId}
              onFile={handleImportFile}
              onDirectoryEntry={processDirectoryEntry}
              onFolderFileList={processFileList}
              onReset={handleImportReset}
              onYamlInstall={handleYamlInstall}
              onBundleInstall={handleBundleInstall}
              loading={loading}
            />
          )}

          {/* Model selector — visual and YAML modes only */}
          {mode !== 'import' && (
            <AppModelSelector
              modelSourceId={modelSourceId}
              modelId={modelId}
              onChange={(srcId, mdlId) => {
                setModelSourceId(srcId)
                setModelId(mdlId)
              }}
            />
          )}

          {/* Space selector — visual and YAML modes only */}
          {mode !== 'import' && (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('Install to')}
              </h3>
              {dedicatedSpaces.length > 0 && (
                <select
                  value={selectedSpaceId}
                  onChange={e => setSelectedSpaceId(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
                >
                  {dedicatedSpaces.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
              {dedicatedSpaces.length === 0 && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-secondary border border-border text-sm text-muted-foreground">
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5 text-orange-400" />
                  <span>{t('A digital human requires a dedicated space. Please create one first from the home page.')}</span>
                </div>
              )}
              {/* New Space — accordion (toggle + body as one unit to avoid spacing leaks) */}
              <div>
                <button
                  onClick={() => {
                    const next = !showCreateSpaceForm
                    setShowCreateSpaceForm(next)
                    if (next) {
                      // Scroll to bottom after CSS animation completes (200ms)
                      setTimeout(() => {
                        bodyScrollRef.current?.scrollTo({
                          top: bodyScrollRef.current.scrollHeight,
                          behavior: 'smooth',
                        })
                      }, 220)
                    }
                  }}
                  className={`flex items-center gap-1.5 text-xs transition-colors ${
                    showCreateSpaceForm
                      ? 'text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>{t('New Space')}</span>
                  <ChevronDown
                    className={`w-3 h-3 transition-transform duration-200 ${showCreateSpaceForm ? 'rotate-180' : ''}`}
                  />
                </button>

                {/* CSS grid height animation — padding inside so collapsed state is truly 0 */}
                <div
                  className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                    showCreateSpaceForm ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                  }`}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div className="pt-2">
                      <div className="rounded-lg border border-border bg-secondary/20 p-3">
                        <CreateSpaceForm
                          compact
                          onCreated={(space) => { setSelectedSpaceId(space.id); setShowCreateSpaceForm(false) }}
                          onCancel={() => setShowCreateSpaceForm(false)}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {error && (
            <p className="text-xs text-red-400">{error}</p>
          )}
        </div>

        {/* Footer — visual / yaml modes only; import mode manages its own footer */}
        {mode !== 'import' && (
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-border flex-shrink-0">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('Cancel')}
            </button>
            <button
              onClick={handleCreateInstall}
              disabled={loading || !canCreate}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {t('Create Digital Human')}
            </button>
          </div>
        )}
      </div>

    </div>
  )
}

// ============================================
// ImportTab — self-contained import UI
// ============================================

function ImportTab({
  importState,
  allSpaces,
  selectedSpaceId,
  onSelectedSpaceChange,
  onFile,
  onDirectoryEntry,
  onFolderFileList,
  onReset,
  onYamlInstall,
  onBundleInstall,
  loading,
}: {
  importState: ImportState
  allSpaces: Array<{ id: string; name: string; icon: string }>
  selectedSpaceId: string
  onSelectedSpaceChange: (id: string) => void
  onFile: (file: File) => void
  onDirectoryEntry: (entry: FileSystemDirectoryEntry) => void
  onFolderFileList: (files: FileList) => void
  onReset: () => void
  onYamlInstall: (yaml: string) => void
  onBundleInstall: (result: ZipParseResult) => void
  loading: boolean
}) {
  const { t } = useTranslation()
  const phase = importState.phase

  // Installing / terminal phases render full-screen content + Done footer
  if (phase === 'installing') {
    const { progress } = importState
    const percent = Math.round((progress.currentIndex / progress.totalSteps) * 100)
    return (
      <>
        <div className="flex flex-col items-center justify-center py-12 gap-4">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <div className="text-center space-y-1">
            <p className="text-sm text-foreground">{progress.currentStep}</p>
            <p className="text-xs text-muted-foreground">
              {t('Step {{current}} of {{total}}', { current: progress.currentIndex, total: progress.totalSteps })}
            </p>
          </div>
          <div className="w-48 h-1.5 bg-secondary rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${percent}%` }} />
          </div>
        </div>
        <ImportFooter phase={phase} onReset={onReset} loading={false} />
      </>
    )
  }

  if (phase === 'success') {
    return (
      <>
        <div className="space-y-3">
          <div className="flex flex-col items-center py-6 gap-3">
            <CheckCircle2 className="w-10 h-10 text-green-500" />
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">{t('Installation complete')}</p>
              <p className="text-xs text-muted-foreground mt-1">{importState.result.displayName}</p>
            </div>
          </div>
          {importState.skillResults.length > 0 && <SkillResultsList skillResults={importState.skillResults} />}
        </div>
        <ImportFooter phase={phase} onReset={onReset} loading={false} />
      </>
    )
  }

  if (phase === 'partial') {
    return (
      <>
        <div className="space-y-3">
          <div className="flex flex-col items-center py-6 gap-3">
            <AlertTriangle className="w-10 h-10 text-yellow-500" />
            <div className="text-center">
              <p className="text-sm font-medium text-foreground">{t('Partially installed')}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t('{{name}} was installed, but some bundled skills failed.', { name: importState.result.displayName })}
              </p>
            </div>
          </div>
          <SkillResultsList skillResults={importState.skillResults} />
        </div>
        <ImportFooter phase={phase} onReset={onReset} loading={false} />
      </>
    )
  }

  if (phase === 'failed') {
    return (
      <>
        <div className="space-y-3">
          <div className="flex flex-col items-center py-6 gap-3">
            <AlertCircle className="w-10 h-10 text-destructive" />
            <div className="text-center">
              <p className="text-sm font-medium text-destructive">{t('Installation failed')}</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-sm">{importState.error}</p>
            </div>
          </div>
          {importState.skillResults.length > 0 && <SkillResultsList skillResults={importState.skillResults} />}
        </div>
        <ImportFooter phase={phase} onReset={onReset} loading={false} />
      </>
    )
  }

  // Idle / loading / error / preview phases — all share the same footer pattern
  return (
    <>
      {/* Description */}
      <p className="text-xs text-muted-foreground">
        {t('Drop a .yaml spec file, .zip bundle, or folder to import a digital human.')}
      </p>

      {phase === 'idle' && (
        <FileImportZone
          onFile={onFile}
          onDirectoryEntry={onDirectoryEntry}
          onFolderFileList={onFolderFileList}
          fileAccept=".yaml,.yml,.zip"
          dropLabel={t('Drop .yaml, .zip, or folder here')}
          dropHint={t('or click to browse a file')}
          folderLabel={t('Browse folder...')}
        >
          {/* Format hint */}
          <div className="p-3 bg-secondary/50 rounded-lg border border-border space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t('Bundle format (zip or folder)')}
            </p>
            <pre className="text-xs text-muted-foreground font-mono leading-relaxed">
{`├── spec.yaml          ← ${t('Required: automation spec')}
└── skills/            ← ${t('Optional: bundled skills')}
    └── skill-name/
        └── SKILL.md`}
            </pre>
          </div>
        </FileImportZone>
      )}

      {phase === 'loading' && (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground">{t('Parsing...')}</p>
        </div>
      )}

      {phase === 'error' && (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
            <p className="text-sm font-medium text-destructive">{t('Validation failed')}</p>
          </div>
          {importState.errors.map((err, i) => (
            <div key={i} className="p-3 bg-destructive/5 border border-destructive/20 rounded-lg space-y-1">
              <p className="text-xs font-medium text-foreground font-mono">{err.location}</p>
              <p className="text-xs text-muted-foreground">
                <span className="text-muted-foreground/70">{t('Expected')}: </span>{err.expected}
              </p>
              <p className="text-xs text-muted-foreground">
                <span className="text-muted-foreground/70">{t('Actual')}: </span>{err.actual}
              </p>
              {err.suggestion && <p className="text-xs text-primary mt-1">{err.suggestion}</p>}
            </div>
          ))}
        </div>
      )}

      {phase === 'yaml-preview' && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-foreground">{importState.fileName}</span>
            <button onClick={onReset} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              {t('Clear')}
            </button>
          </div>
          <Suspense fallback={
            <div className="h-64 flex items-center justify-center bg-secondary rounded-lg border border-border">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          }>
            <div className="h-64 border border-border rounded-lg overflow-hidden">
              <CodeMirrorEditor content={importState.yamlContent} language="yaml" readOnly={true} />
            </div>
          </Suspense>
        </div>
      )}

      {phase === 'bundle-preview' && (
        <BundlePreview result={importState.result} fileName={importState.fileName} sourceType={importState.sourceType} />
      )}

      {/* Space selector — shown in yaml-preview and bundle-preview */}
      {(phase === 'yaml-preview' || phase === 'bundle-preview') && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('Install to')}
          </h3>
          {allSpaces.length <= 1 ? (
            <p className="text-sm text-foreground">{allSpaces[0]?.name ?? t('No spaces available')}</p>
          ) : (
            <select
              value={selectedSpaceId}
              onChange={e => onSelectedSpaceChange(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
            >
              {allSpaces.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Footer */}
      <ImportFooter
        phase={phase}
        onReset={onReset}
        loading={loading}
        onYamlInstall={phase === 'yaml-preview' ? () => onYamlInstall(importState.yamlContent) : undefined}
        onBundleInstall={phase === 'bundle-preview' ? () => onBundleInstall(importState.result) : undefined}
      />
    </>
  )
}

// ── Footer for import tab ──
function ImportFooter({
  phase,
  onReset,
  loading,
  onYamlInstall,
  onBundleInstall,
}: {
  phase: ImportState['phase']
  onReset: () => void
  loading: boolean
  onYamlInstall?: () => void
  onBundleInstall?: () => void
}) {
  const { t } = useTranslation()

  if (phase === 'idle' || phase === 'loading') return null

  if (phase === 'error') {
    return (
      <div className="flex justify-end gap-2 pt-2 border-t border-border">
        <button
          onClick={onReset}
          className="px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          {t('Try again')}
        </button>
      </div>
    )
  }

  if (phase === 'yaml-preview') {
    return (
      <div className="flex justify-end gap-2 pt-2 border-t border-border">
        <button onClick={onReset} className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          {t('Back')}
        </button>
        <button
          onClick={onYamlInstall}
          disabled={loading}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {t('Import')}
        </button>
      </div>
    )
  }

  if (phase === 'bundle-preview') {
    return (
      <div className="flex justify-end gap-2 pt-2 border-t border-border">
        <button onClick={onReset} className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          {t('Back')}
        </button>
        <button
          onClick={onBundleInstall}
          disabled={loading}
          className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {t('Install')}
        </button>
      </div>
    )
  }

  if (phase === 'installing') {
    return (
      <div className="flex justify-end pt-2 border-t border-border">
        <button disabled className="px-3 py-1.5 text-sm text-muted-foreground opacity-50 cursor-not-allowed">
          {t('Installing...')}
        </button>
      </div>
    )
  }

  // success / partial / failed
  return (
    <div className="flex justify-end gap-2 pt-2 border-t border-border">
      {(phase === 'failed') && (
        <button onClick={onReset} className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          {t('Try again')}
        </button>
      )}
    </div>
  )
}

// ── Bundle preview ──
function BundlePreview({
  result,
  fileName,
  sourceType,
}: {
  result: ZipParseResult
  fileName: string
  sourceType: 'zip' | 'folder'
}) {
  const { t } = useTranslation()
  const SourceIcon = sourceType === 'folder' ? FolderOpen : Archive
  const sourceLabel = sourceType === 'folder' ? t('Folder') : t('ZIP archive')

  return (
    <div className="space-y-3">
      {/* Source info */}
      <div className="flex items-center gap-2.5 p-3 bg-secondary rounded-lg border border-border">
        <SourceIcon className="w-4 h-4 text-primary flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground truncate">{fileName}</p>
          <p className="text-xs text-muted-foreground">{sourceLabel}</p>
        </div>
      </div>

      {/* Main spec card */}
      <div className="p-3 bg-secondary/50 rounded-lg border border-border space-y-2">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-primary flex-shrink-0" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('Digital Human')}
          </span>
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{result.displayName}</p>
          <p className="text-xs text-muted-foreground">{result.description}</p>
          {(result.version || result.author) && (
            <p className="text-xs text-muted-foreground/70">
              {result.version && <span>v{result.version}</span>}
              {result.version && result.author && <span> · </span>}
              {result.author && <span>{result.author}</span>}
            </p>
          )}
        </div>
      </div>

      {/* Bundled skills */}
      {result.bundledSkills.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Puzzle className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('Bundled Skills')} ({result.bundledSkills.length})
            </span>
          </div>
          <div className="space-y-1">
            {result.bundledSkills.map(skill => {
              const { name, description } = parseSkillFrontmatter(skill.files['SKILL.md'] ?? '')
              const fileCount = Object.keys(skill.files).length
              return (
                <div
                  key={skill.name}
                  className="flex items-center justify-between px-3 py-2 bg-secondary/50 rounded-lg border border-border"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{name || skill.name}</p>
                    {description && <p className="text-xs text-muted-foreground truncate">{description}</p>}
                  </div>
                  <span className="text-xs text-muted-foreground flex-shrink-0 ml-2">
                    {fileCount === 1 ? t('1 file') : t('{{count}} files', { count: fileCount })}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Warnings */}
      {result.warnings.length > 0 && (
        <div className="space-y-1.5">
          {result.warnings.map((warn, i) => (
            <div key={i} className="flex items-start gap-2 px-3 py-2 bg-yellow-400/5 border border-yellow-400/20 rounded-lg">
              <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-medium text-foreground font-mono">{warn.location}</p>
                <p className="text-xs text-muted-foreground">{warn.message}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Skill results list (success/partial/failed) ──
function SkillResultsList({ skillResults }: { skillResults: SkillInstallResult[] }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('Bundled Skills')}</p>
      {skillResults.map((sr, i) => (
        <div key={i} className="flex items-center justify-between px-3 py-2 bg-secondary/50 rounded-lg border border-border">
          <span className="text-xs text-foreground truncate">{sr.name}</span>
          {sr.success ? (
            <span className="flex items-center gap-1 text-xs text-green-500 flex-shrink-0">
              <CheckCircle2 className="w-3 h-3" />
              {t('Installed')}
            </span>
          ) : (
            <span
              className="flex items-center gap-1 text-xs text-destructive flex-shrink-0"
              title={sr.error}
            >
              <AlertCircle className="w-3 h-3" />
              {t('Failed')}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

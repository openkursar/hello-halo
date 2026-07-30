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

import { useState, useMemo, useCallback, useEffect, useRef, type ReactNode } from 'react'
import {
  X,
  Loader2,
  FolderOpen,
  AlertCircle,
  CheckCircle2,
  Archive,
  FileText,
  ArrowRight,
  ChevronRight,
  LogIn,
  Package,
  Upload,
} from 'lucide-react'
import { Switch } from '../ui/Switch'
import { parse as parseYaml } from 'yaml'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useNotificationStore } from '../../stores/notification.store'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import type { InstalledApp } from '../../../shared/apps/app-types'
import type { AppSpec, AutomationSpec, SkillSpec } from '../../../shared/apps/spec-types'
import type { StoreAppDetail } from '../../../shared/store/store-types'
import {
  processMdFile,
  processDirectoryEntry,
  processFileListAsFolder,
  processZipFile,
  parseMd,
  type ParsedSkill,
} from '../apps/skill-import-utils'
import {
  parseDigitalHumanZip,
  parseDigitalHumanFolder,
  detectZipAppType,
  type ZipParseResult,
  type BundledSkill,
} from '../apps/zip-import-utils'
import { readDirectoryEntryToMap, readFileListToMap } from '../apps/file-read-utils'
import { FileImportZone } from '../apps/FileImportZone'
import { AppTypeIcon } from './AppTypeIcon'
import { AuthorField } from './AuthorField'
import { loadStoredAuthor, saveAuthor } from './publish-author'
import { publishDraftKey, loadPublishDraft, savePublishDraft, clearPublishDraft } from './publish-draft'
import { useStoreCategories, categoryDisplay } from '../../hooks/useStoreCategories'
import { useMarketplaceCapabilities } from '../../hooks/useMarketplaceCapabilities'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { compareDotVersions, suggestNextVersion } from '../../../shared/store/version-compare'
import { useAssociatedSkills } from '../../hooks/useAssociatedSkills'
import { runPublishPreflight, type PreflightFinding } from './publish-preflight'

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
  /** Digital-human-only: skills bundled inside the imported package. They are
   * installed alongside the DH at publish time and can be co-listed. */
  bundledSkills?: BundledSkill[]
}

/** A bundled skill as shown in the publish form's co-list section, unified
 * across the installed and imported sources. */
interface FormSkill {
  /** Stable identity for the co-list selection set. */
  key: string
  name: string
  /** Already has its own store listing (installed source only). */
  published: boolean
  /** Installed source: the skill app to co-publish directly. */
  appId?: string
  /** Imported source: installed on submit to obtain an appId, then co-published. */
  bundled?: BundledSkill
}

/** A bundled skill that could not be co-listed, with the registry's reason (a
 * name collision is the common one — the user must rename to resolve it). */
interface CoListFailure {
  name: string
  reason?: string
}

/** A review rule outcome returned by the registry on a rejected publish. */
interface ReviewFinding {
  rule: string
  severity: string
  message: string
}

// Seeds the digital-human chooser card cycles through — each renders a distinct
// generated avatar (same style as the home page), one per second.
const DIGITAL_HUMAN_SEEDS = ['aria', 'nova', 'sol', 'iris', 'max', 'echo', 'luna', 'pip']

/** Digital-human type icon that swaps to a different generated avatar every
 * second, hinting the app is "alive". Confined to the publish chooser card. */
function RotatingDigitalHumanIcon() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setI(n => (n + 1) % DIGITAL_HUMAN_SEEDS.length), 1000)
    return () => clearInterval(id)
  }, [])
  return <AppTypeIcon type="automation" name={DIGITAL_HUMAN_SEEDS[i]} size="md" />
}

/** Which surface opened the publish dialog — recorded on publish telemetry so
 * the metrics dashboard can attribute publishes by entry point. 'store' is the
 * store header's Publish button, 'share' a detail page's Share action, 'mine'
 * the "publish new version" action in My Publications. */
export type PublishEntry = 'mine' | 'store' | 'share'

export interface ShareToStoreDialogProps {
  onClose: () => void
  /** Open straight on the form with this installed app pre-selected (used when
   * a detail page's Share action routes into the unified publish flow). */
  initialType?: ShareType
  initialAppId?: string
  /** Opening surface, for publish telemetry attribution. */
  entry?: PublishEntry
  /** True when re-publishing an already-listed app (the "publish new version"
   * action in My Publications), vs a first-time publish. */
  republish?: boolean
}

// ────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────

export function ShareToStoreDialog({ onClose, initialType, initialAppId, entry, republish }: ShareToStoreDialogProps) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const showToast = useNotificationStore(s => s.show)
  // Post-publish "View" jumps to My Publications so the creator can see the
  // freshly-listed entry.
  const setCurrentTab = useAppsPageStore(s => s.setCurrentTab)
  const setStoreMineOpen = useAppsPageStore(s => s.setStoreMineOpen)

  // Fields flagged by a failed submit; cleared as the user fills each one.
  const [invalid, setInvalid] = useState<Set<string>>(new Set())
  const clearInvalid = useCallback((key: string) => {
    setInvalid(prev => {
      if (!prev.has(key)) return prev
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [])

  // A brief type-choice step precedes the form; picking a type prefills it (and
  // it stays switchable inside the form). A caller-supplied type or app skips
  // straight to the form (e.g. republishing a known publication).
  const [step, setStep] = useState<'type' | 'form'>(initialAppId || initialType ? 'form' : 'type')
  const [type, setType] = useState<ShareType>(initialType ?? 'automation')
  const [source, setSource] = useState<ShareSource>('installed')

  // Installed source state
  const installedOfType = useMemo(
    () => apps.filter(a => a.spec.type === type && a.status !== 'uninstalled'),
    [apps, type]
  )
  const [selectedInstalledId, setSelectedInstalledId] = useState<string | null>(initialAppId ?? null)

  // Clear the pick when the type changes — the user chooses which app to share
  // rather than being defaulted onto one. Skipped on the first run so a
  // caller-supplied pre-selection survives mount.
  const typeInitRef = useRef(true)
  useEffect(() => {
    if (typeInitRef.current) { typeInitRef.current = false; return }
    setSelectedInstalledId(null)
  }, [type])

  // File / folder source state
  const [staged, setStaged] = useState<StagedSpec | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [parsing, setParsing] = useState(false)

  // Author — required for publish; persisted across share flows.
  const [author, setAuthor] = useState(loadStoredAuthor)
  // Slug/publish-state probes derive from the author; debounce so editing it
  // does not fire an IPC preview per keystroke.
  const debouncedAuthor = useDebouncedValue(author)

  // In um mode the author is the signed-in identity, not free text — prefill it
  // from the creator's uid (ASCII-safe, drives the slug and matches ownership)
  // and lock the field.
  const capabilities = useMarketplaceCapabilities()
  const isUmIdentity = capabilities?.identity === 'um'
  // Sign-in gate: null = still checking, false = must sign in first, true = ready.
  // Non-um builds need no creator identity, so they start ready.
  const [signedIn, setSignedIn] = useState<boolean | null>(isUmIdentity ? null : true)
  const [signingIn, setSigningIn] = useState(false)
  useEffect(() => {
    if (!isUmIdentity) { setSignedIn(true); return }
    let cancelled = false
    api.storeGetIdentity().then(res => {
      const uid = res.success ? res.data?.uid : undefined
      if (cancelled) return
      setSignedIn(!!uid)
      if (uid) setAuthor(uid)
    })
    return () => { cancelled = true }
  }, [isUmIdentity])

  // Sign in from inside the dialog (system-browser OAuth), then reveal the form.
  const handleSignIn = useCallback(async () => {
    if (signingIn) return
    setSigningIn(true)
    try {
      const res = await api.storeEnsureSignedIn()
      if (res.success && res.data) {
        const idRes = await api.storeGetIdentity()
        const uid = idRes.success ? idRes.data?.uid : undefined
        if (uid) setAuthor(uid)
        setSignedIn(true)
      }
    } finally {
      setSigningIn(false)
    }
  }, [signingIn])

  // Scene category — required for publish, drawn from the same taxonomy
  // the store chips use, so publish and browse filtering stay consistent.
  const [category, setCategory] = useState('')
  const categories = useStoreCategories(type)

  // Name / description edits land on the publish snapshot only — they are
  // prefilled from the source spec and never write back to the local app.
  const [name, setName] = useState('')
  // A rename retargets the publish slug, so the version probe must re-run under
  // the new name; debounce to avoid an IPC preview per keystroke.
  const debouncedName = useDebouncedValue(name)
  const [changelog, setChangelog] = useState('')
  const [description, setDescription] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const sourceSpec = source === 'installed'
    ? apps.find(a => a.id === selectedInstalledId)?.spec
    : staged?.spec
  const sourceTags = sourceSpec?.store?.tags
  const sourceCategory = sourceSpec?.store?.category

  // Draft persistence — keyed per installed target so an accidental close, a
  // crash, or a session-expired publish never loses the typed metadata.
  const draftKey = publishDraftKey(source, selectedInstalledId)
  const draft = useMemo(() => loadPublishDraft(draftKey), [draftKey])
  // Only persist once the user actually edits a field, so merely opening the
  // dialog (which seeds fields from the spec and auto-suggests a version) never
  // writes a draft that could later shadow edits to the local app's spec.
  const draftDirty = useRef(false)

  useEffect(() => {
    // A saved draft takes precedence over the spec-derived defaults so a
    // resumed publish shows exactly what the user last had.
    if (draft) {
      setName(draft.name)
      setChangelog(draft.changelog)
      setDescription(draft.description)
      setTags(draft.tags)
      if (draft.category) setCategory(draft.category)
    } else {
      setName(sourceSpec?.name ?? '')
      setChangelog('')
      setDescription(sourceSpec?.description ?? '')
      setTags(sourceTags ?? [])
      // Pre-fill the scene category from the app's existing store metadata so a
      // new-version publish keeps its category instead of forcing a re-pick.
      if (sourceCategory) setCategory(sourceCategory)
    }
    // Re-seeding a fresh target is not a user edit.
    draftDirty.current = false
  }, [sourceSpec?.name, sourceSpec?.description, sourceTags, sourceCategory, draft])

  // Store version of the target slug — needed for the pre-flight version-
  // monotonicity check. Only resolvable for an installed source (import has no
  // appId until submit); null leaves the check dormant.
  const [storeVersion, setStoreVersion] = useState<string | null>(null)
  useEffect(() => {
    const appId = source === 'installed' ? selectedInstalledId : null
    if (!appId) { setStoreVersion(null); return }
    let cancelled = false
    api.storePublishPreview(appId, debouncedAuthor.trim() || undefined, debouncedName.trim() || undefined)
      .then(async res => {
        if (cancelled) return
        const preview = res.success ? res.data : null
        setStoreVersion(preview?.storeVersion ?? null)
        // On an update the scene category and tags live on the published
        // registry entry (never written back to the local spec), so pull them
        // from the store and backfill only fields the user left blank.
        if (!preview?.slug || !preview.storeVersion) return
        const detail = await api.storeGetAppDetail(preview.slug)
        if (cancelled || !detail.success) return
        const entry = (detail.data as StoreAppDetail | undefined)?.entry
        if (!entry) return
        if (entry.category) setCategory(prev => prev || entry.category)
        if (entry.tags?.length) setTags(prev => prev.length ? prev : entry.tags)
      })
      .catch(() => { if (!cancelled) setStoreVersion(null) })
    return () => { cancelled = true }
  }, [source, selectedInstalledId, debouncedAuthor, debouncedName])

  // Publish version — defaults to an auto-incremented value the user may raise
  // but not drop below the published version (enforced by the pre-flight). When
  // the source spec already sits above the store version we keep it; otherwise
  // we bump the store version's last segment.
  const [version, setVersion] = useState('')
  const [versionTouched, setVersionTouched] = useState(false)
  useEffect(() => {
    // Restore a drafted version and mark it touched so the auto-suggest below
    // does not overwrite it; otherwise fall back to the suggested version.
    if (draft?.version) { setVersion(draft.version); setVersionTouched(true) }
    else setVersionTouched(false)
  }, [selectedInstalledId, staged, draft])
  const suggestedVersion = useMemo(() => {
    const specVersion = sourceSpec?.version?.trim() || '1.0.0'
    if (!storeVersion) return specVersion
    return compareDotVersions(specVersion, storeVersion) > 0 ? specVersion : suggestNextVersion(storeVersion)
  }, [sourceSpec?.version, storeVersion])
  useEffect(() => {
    if (!versionTouched) setVersion(suggestedVersion)
  }, [suggestedVersion, versionTouched])

  const preflight = useMemo<PreflightFinding[]>(() => {
    if (!sourceSpec) return []
    return runPublishPreflight({ spec: sourceSpec, storeVersion, overrideName: name, overrideDescription: description, overrideVersion: version })
  }, [sourceSpec, storeVersion, name, description, version])
  const hasBlockingIssue = preflight.some(f => f.severity === 'error')

  // Bundled skills that ship with a digital human — each can be co-listed as its
  // own store entry. Two sources: an installed DH resolves them to installed
  // skill apps (with an appId + a "published" probe); an imported package
  // carries them inline (installed on submit, so no appId/probe yet).
  const installedAssoc = useAssociatedSkills(source === 'installed' ? sourceSpec : undefined, debouncedAuthor)
  const formSkills = useMemo<FormSkill[]>(() => {
    if (source === 'installed') {
      return installedAssoc.map(s => ({ key: s.appId, name: s.name, published: s.published, appId: s.appId }))
    }
    return (staged?.bundledSkills ?? []).map(b => ({
      key: `bundled:${b.name}`,
      name: parseMd(b.files['SKILL.md'] ?? '').name || b.name,
      published: false,
      bundled: b,
    }))
  }, [source, installedAssoc, staged])
  const [coPublishIds, setCoPublishIds] = useState<string[]>([])
  // Reset co-list selections when the underlying app/import changes so stale
  // keys never leak into a different publish.
  useEffect(() => { setCoPublishIds([]) }, [source, selectedInstalledId, staged])

  useEffect(() => {
    void api.trackEvent('mkt_publish_open', entry ? { entry } : {})
  }, [entry])

  // Submit state
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitSuccess, setSubmitSuccess] = useState<string | null>(null)
  // A session-expired publish keeps the draft and offers re-login + retry.
  const [authExpired, setAuthExpired] = useState(false)
  // Bundled skills that failed to co-list, shown on the success screen.
  const [coListFailures, setCoListFailures] = useState<CoListFailure[]>([])

  // Auto-save the editable metadata as the user types (only once dirty, and not
  // after a successful publish, which clears the draft). Placed after the submit
  // state it reads so its dependency list is evaluated post-initialization.
  useEffect(() => {
    if (!draftKey || submitSuccess || !draftDirty.current) return
    savePublishDraft(draftKey, { name, description, version, changelog, category, tags })
  }, [draftKey, name, description, version, changelog, category, tags, submitSuccess])

  // Reset staged when type/source changes
  useEffect(() => {
    setStaged(null)
    setParseError(null)
    setSubmitError(null)
    setSubmitSuccess(null)
    setCoListFailures([])
  }, [type, source])

  // A category from one type's enum is not valid for another; clear on switch.
  useEffect(() => {
    setCategory('')
  }, [type])

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
    setStaged({ spec, label, origin, bundledSkills: result.bundledSkills })
  }

  // ── File handlers ────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    setParseError(null)
    setStaged(null)
    setParsing(true)
    try {
      const lower = file.name.toLowerCase()
      // Detect the real app type from the file so a mismatched type selection
      // auto-corrects instead of erroring. Extensions are decisive except .zip,
      // which we peek inside (a skill zip imported under "Digital Human" would
      // otherwise fail on the missing spec.yaml).
      const detected: ShareType | null = lower.endsWith('.md')
        ? 'skill'
        : lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.dhpkg')
          ? 'automation'
          : lower.endsWith('.zip')
            ? await detectZipAppType(file)
            : null
      if (detected && detected !== type) setType(detected)
      const effective = detected ?? type
      if (effective === 'skill') {
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
      const flat = await readDirectoryEntryToMap(entry)
      const detected = detectFolderType(flat)
      if (detected !== type) setType(detected)
      if (detected === 'skill') await parseSkillFromDirEntry(entry)
      else await parseAutomationFolder(flat, entry.name)
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
      const { files: map, folderName } = await readFileListToMap(files)
      const detected = detectFolderType(map)
      if (detected !== type) setType(detected)
      if (detected === 'skill') await parseSkillFromFileList(files)
      else await parseAutomationFolder(map, folderName || t('Folder'))
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
    setAuthExpired(false)

    const trimmedAuthor = author.trim()
    const missing = new Set<string>()
    if (source === 'installed' ? !selectedInstalledId : !staged) missing.add('source')
    if (!name.trim()) missing.add('name')
    if (!version.trim()) missing.add('version')
    if (!trimmedAuthor) missing.add('author')
    if (!category) missing.add('category')
    if (missing.size > 0) {
      setInvalid(missing)
      showToast({ title: t('Please complete the required fields'), variant: 'warning', duration: 4000 })
      return
    }
    if (hasBlockingIssue) {
      showToast({ title: t('Resolve the pre-flight issues before publishing.'), variant: 'error', duration: 4000 })
      return
    }
    setInvalid(new Set())

    setSubmitting(true)
    // An imported package is staged into a throwaway space (torn down in the
    // `finally`) so publishing never collides with the user's globally-installed
    // apps and leaves nothing behind. Held out here so cleanup runs on any exit.
    let stagingSpaceId: string | null = null

    try {
      const bundledAppIdByKey: Record<string, string> = {}
      let appIdToPublish: string

      if (source === 'installed') {
        if (!selectedInstalledId) {
          throw new Error(t('Please pick an installed item to share.'))
        }
        appIdToPublish = selectedInstalledId
      } else {
        if (!staged) {
          throw new Error(t('No file or folder loaded yet.'))
        }
        // Create the staging workspace (unique per attempt, so an already-installed
        // same-name app never blocks publishing). Called via the api directly so
        // the transient space never enters the space store / UI list.
        const spaceRes = await api.createSpace({ name: t('Publishing "{{name}}"', { name: staged.spec.name }), icon: '📦' })
        const sid = (spaceRes.data as { id?: string } | undefined)?.id
        if (!spaceRes.success || !sid) {
          throw new Error((spaceRes.error as string) ?? t('Failed to prepare a staging workspace.'))
        }
        stagingSpaceId = sid
        // Bundled skills first so the digital human's collectFiles finds them at
        // publish time; the DH is last. All go into the staging space.
        for (const b of staged.bundledSkills ?? []) {
          const { name: skillName, description: skillDesc } = parseMd(b.files['SKILL.md'] ?? '')
          const skillSpec: SkillSpec = {
            spec_version: '1.0',
            version: '1.0',
            name: skillName || b.name,
            description: skillDesc || `Bundled skill: ${b.name}`,
            type: 'skill',
            skill_files: b.files,
          }
          const r = await api.appInstall({ spaceId: sid, spec: skillSpec })
          const id = (r.data as { appId?: string } | undefined)?.appId
          if (!r.success || !id) {
            throw new Error(r.error ?? t('Install failed before publish.'))
          }
          bundledAppIdByKey[`bundled:${b.name}`] = id
        }
        const installRes = await api.appInstall({ spaceId: sid, spec: staged.spec })
        const installedId = (installRes.data as { appId?: string } | undefined)?.appId
        if (!installRes.success || !installedId) {
          throw new Error(installRes.error ?? t('Install failed before publish.'))
        }
        appIdToPublish = installedId
      }

      // Publish to registry
      const pubRes = await api.storePublish(appIdToPublish, {
        author: trimmedAuthor,
        version: version.trim() || undefined,
        changelog: changelog.trim() || undefined,
        category,
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        tags,
      })
      if (!pubRes.success) {
        const findings = (pubRes.data as { findings?: ReviewFinding[] } | undefined)?.findings
        // A name collision is fixed by renaming, so flag the App name field red.
        if (findings?.some(f => f.severity === 'fail' && f.rule === 'name_unique')) {
          setInvalid(prev => new Set(prev).add('name'))
        }
        // Session expired mid-publish: keep the draft and offer re-login + retry.
        if (findings?.some(f => f.rule === 'not-signed-in')) {
          setAuthExpired(true)
        }
        throw new Error(friendlyReviewError(findings, name.trim(), t) ?? pubRes.error ?? t('Publish failed.'))
      }

      // Co-list opted-in bundled skills as their own store entries. Author is
      // reused; no category is set, keeping them out of the DH's taxonomy. The
      // registry reason is kept so a name-collision tells the user to rename.
      const coFailures: CoListFailure[] = []
      for (const s of formSkills) {
        if (s.published || !coPublishIds.includes(s.key)) continue
        const appId = s.appId ?? bundledAppIdByKey[s.key]
        if (!appId) { coFailures.push({ name: s.name }); continue }
        const res = await api.storePublish(appId, { author: trimmedAuthor })
        if (!res.success) coFailures.push({ name: s.name, reason: res.error as string | undefined })
      }

      void api.trackEvent('mkt_publish_submit', { appType: type, result: 'success', entry, isUpdate: republish ? 1 : 0 })
      saveAuthor(trimmedAuthor)
      // Published — discard the saved draft so it is not restored next time.
      clearPublishDraft(draftKey)
      setCoListFailures(coFailures)
      // Re-sync the store index so the freshly-published version feeds the
      // "Updatable" list and browse views (my-publications already reads live
      // submissions). Fire-and-forget: it must not block the success screen.
      void useAppsPageStore.getState().refreshStore()
      // A truthy flag switches the dialog into its success screen; the raw
      // registry verdict string is intentionally not surfaced to the user.
      setSubmitSuccess('ok')
    } catch (err) {
      void api.trackEvent('mkt_publish_submit', { appType: type, result: 'fail', entry, isUpdate: republish ? 1 : 0 })
      setSubmitError(err instanceof Error ? err.message : t('Share failed.'))
    } finally {
      // Tear down the staging workspace (cascades its staged apps + files), so
      // publishing leaves the user's local install set untouched.
      if (stagingSpaceId) await api.deleteSpace(stagingSpaceId).catch(() => undefined)
      setSubmitting(false)
    }
  }, [type, source, selectedInstalledId, staged, author, category, version, changelog, name, description, tags, formSkills, coPublishIds, hasBlockingIssue, draftKey, showToast, t, entry, republish])

  // Post-publish "View": close the dialog and open My Publications so the
  // creator lands on the freshly-listed entry.
  const handleViewPublished = useCallback(() => {
    onClose()
    setCurrentTab('store')
    setStoreMineOpen(true)
  }, [onClose, setCurrentTab, setStoreMineOpen])

  // Session expired during publish: re-authenticate, then resubmit the form
  // (still fully populated — the draft was never dropped) in one tap.
  const handleReloginAndRetry = useCallback(async () => {
    if (signingIn) return
    setSigningIn(true)
    try {
      const res = await api.storeEnsureSignedIn()
      if (res.success && res.data) {
        setAuthExpired(false)
        void handleSubmit()
      }
    } finally {
      setSigningIn(false)
    }
  }, [signingIn, handleSubmit])

  // ── Render ───────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onMouseDown={onClose}
    >
      <div
        className="relative w-full max-w-2xl bg-background border border-border rounded-[14px] shadow-xl flex flex-col max-h-[90vh]"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="relative flex-shrink-0 px-7 pt-6 pb-4 border-b border-border/60">
          <h2 className="text-base font-bold text-foreground">{t('Publish app to store')}</h2>
          <button
            onClick={onClose}
            className="absolute top-4 right-4 flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground hover:text-foreground hover:border-border transition-colors"
            aria-label={t('Close')}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto flex flex-col px-7 py-5 space-y-4">
          {signedIn === null ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : signedIn === false ? (
            <div className="flex flex-col items-center justify-center text-center py-12 gap-3.5">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
                <LogIn className="w-7 h-7 text-primary" />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-base font-semibold text-foreground">{t('Sign in to publish')}</h3>
                <p className="text-[13px] text-muted-foreground max-w-sm">
                  {t('Publishing is tied to your account. Sign in first, then pick what to publish.')}
                </p>
              </div>
              <button
                onClick={handleSignIn}
                disabled={signingIn}
                className="flex items-center gap-1.5 px-5 py-2.5 text-[13px] font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
              >
                {signingIn && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t('Sign in')}
              </button>
            </div>
          ) : step === 'type' ? (
            <div className="pt-1 pb-5 space-y-3">
              <p className="text-[13px] text-muted-foreground">
                {t('Share your Digital Human or Skill to the store so others can install and reuse it.')}
              </p>
              <p className="text-[13px] font-medium text-foreground">{t('What would you like to publish?')}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(['automation', 'skill'] as const).map(pick => (
                  <button
                    key={pick}
                    onClick={() => { setType(pick); setStep('form') }}
                    className="group flex items-center gap-3 p-4 text-left rounded-[10px] border border-border/60 bg-background hover:border-primary/50 hover:bg-muted/30 transition-colors"
                  >
                    {pick === 'automation' ? <RotatingDigitalHumanIcon /> : <AppTypeIcon type={pick} size="md" />}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-foreground">
                        {pick === 'automation' ? t('Digital Human') : t('Skill')}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {pick === 'automation'
                          ? t('An automation that runs tasks on a schedule or on demand.')
                          : t('A reusable capability invoked inside a conversation.')}
                      </p>
                    </div>
                    <ChevronRight className="w-4 h-4 flex-shrink-0 text-muted-foreground/40 group-hover:text-primary transition-colors" />
                  </button>
                ))}
              </div>
            </div>
          ) : submitSuccess ? (
            <div className="flex flex-col items-center justify-center text-center py-12 gap-3.5">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10">
                <CheckCircle2 className="w-7 h-7 text-emerald-500" />
              </div>
              <div className="space-y-1.5">
                <h3 className="text-base font-semibold text-foreground">{t('Submitted successfully')}</h3>
                <p className="text-[13px] text-muted-foreground">{t('Your app has been submitted to the store.')}</p>
              </div>
              {coListFailures.length > 0 && (
                <div className="w-full max-w-sm text-left rounded-lg border border-amber-500/20 bg-amber-500/5 px-3.5 py-2.5 space-y-1.5">
                  <p className="text-xs text-amber-500">
                    {t('These skills could not be listed separately. Rename them and publish the skill on its own.')}
                  </p>
                  <ul className="space-y-1">
                    {coListFailures.map(f => (
                      <li key={f.name} className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{f.name}</span>
                        {f.reason ? <span className="whitespace-pre-wrap break-words"> — {f.reason}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
          <>
          {/* App type */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="publish-type" className="text-xs font-semibold text-muted-foreground">{t('App type')}</label>
            <select
              id="publish-type"
              value={type}
              onChange={e => setType(e.target.value as ShareType)}
              className="w-full px-3 py-2 text-[13px] bg-muted/40 border border-border/60 rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground"
            >
              <option value="automation">{t('Digital Human')}</option>
              <option value="skill">{t('Skill')}</option>
            </select>
          </div>

          {/* Source segmented control */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-muted-foreground">{t('Publish source')}</label>
            <div className="flex gap-0.5 rounded-lg bg-muted/60 p-0.5">
              <SourceSeg active={source === 'installed'} onClick={() => setSource('installed')} label={t('From installed')} icon={<Package className="w-3.5 h-3.5" />} />
              <SourceSeg active={source === 'import'} onClick={() => setSource('import')} label={t('Import')} icon={<Upload className="w-3.5 h-3.5" />} />
            </div>
          </div>

          {/* Source body */}
          {source === 'installed' ? (
            <InstalledPicker
              apps={installedOfType}
              selectedId={selectedInstalledId}
              onSelect={id => { setSelectedInstalledId(id); clearInvalid('source') }}
              type={type}
              invalid={invalid.has('source')}
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

          {sourceSpec && !submitSuccess && (
            <div className="-mx-7 -mb-5 flex-1 bg-muted/40 px-7 py-4 space-y-4">
          {sourceSpec && !submitSuccess && (
            <div className="space-y-2">
              <div className="flex justify-center pt-1">
                <div className="relative">
                  <AppTypeIcon type={type} name={name} size="md" />
                  <span className={`absolute -top-1 left-6 rounded ring-1 ring-background px-1 py-0.5 text-[8.5px] leading-none font-medium text-white whitespace-nowrap ${type === 'skill' ? 'bg-app-skill' : 'bg-primary'}`}>
                    {type === 'automation' ? t('Digital Human') : t('Skill')}
                  </span>
                </div>
              </div>
              <div className="rounded-xl bg-background p-4 space-y-4">

              <div className="flex flex-col gap-1.5">
                <label htmlFor="publish-name" className="text-xs font-semibold text-muted-foreground">
                  {t('App name')} <span className="text-red-400">*</span>
                </label>
                <input
                  id="publish-name"
                  value={name}
                  onChange={e => { draftDirty.current = true; setName(e.target.value); clearInvalid('name'); setSubmitError(null) }}
                  className={`w-full px-3 py-2 text-[13px] bg-muted/40 border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground ${invalid.has('name') ? 'border-red-400 ring-1 ring-red-400/40' : 'border-border/60'}`}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="publish-category" className="text-xs font-semibold text-muted-foreground">
                  {t('Scene category')} <span className="text-red-400">*</span>
                </label>
                <select
                  id="publish-category"
                  value={category}
                  onChange={e => { draftDirty.current = true; setCategory(e.target.value); clearInvalid('category'); setSubmitError(null) }}
                  className={`w-full px-3 py-2 text-[13px] bg-muted/40 border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary ${category ? 'text-foreground' : 'text-muted-foreground/50'} ${invalid.has('category') ? 'border-red-400 ring-1 ring-red-400/40' : 'border-border'}`}
                >
                  <option value="" disabled>{t('Select a scene category')}</option>
                  {categories.map(cat => (
                    <option key={cat.id} value={cat.id} className="text-foreground">{categoryDisplay(cat, t)}</option>
                  ))}
                </select>
              </div>

              <TagInput tags={tags} onChange={t2 => { draftDirty.current = true; setTags(t2); setSubmitError(null) }} />

              <div className="flex flex-col gap-1.5">
                <label htmlFor="publish-desc" className="text-xs font-semibold text-muted-foreground">
                  {t('App description')}
                </label>
                <textarea
                  id="publish-desc"
                  value={description}
                  onChange={e => { draftDirty.current = true; setDescription(e.target.value) }}
                  rows={3}
                  className="w-full px-3 py-2 text-[13px] bg-muted/40 border border-border/60 rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground resize-none"
                />
              </div>
              </div>
            </div>
          )}

          {sourceSpec && !submitSuccess && (
            <div className="space-y-2">
              <FormSection>{t('Release info')}</FormSection>
              <div className="rounded-xl bg-background p-4 space-y-4">

              {storeVersion && (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="publish-changelog" className="text-xs font-semibold text-muted-foreground">
                    {t('Release notes')} <span className="text-muted-foreground/60">{t('(optional)')}</span>
                  </label>
                  <textarea
                    id="publish-changelog"
                    value={changelog}
                    onChange={e => { draftDirty.current = true; setChangelog(e.target.value) }}
                    rows={2}
                    placeholder={t("What's new in this version?")}
                    className="w-full px-3 py-2 text-[13px] bg-muted/40 border border-border/60 rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground resize-none placeholder:text-muted-foreground/50"
                  />
                </div>
              )}

              <AuthorField
                value={author}
                onChange={v => { setAuthor(v); clearInvalid('author'); setSubmitError(null) }}
                readOnly={isUmIdentity}
                invalid={invalid.has('author')}
              />

              <div className="flex flex-col gap-1.5">
                <label htmlFor="publish-version" className="text-xs font-semibold text-muted-foreground">
                  {t('Version')} <span className="text-red-400">*</span>
                </label>
                {storeVersion ? (
                  <div className="flex items-center gap-2.5">
                    <div className="flex flex-col gap-0.5 flex-shrink-0">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">{t('Current')}</span>
                      <span className="px-3 py-2 text-[13px] font-mono text-muted-foreground bg-muted/40 border border-border/60 rounded-lg">
                        v{storeVersion}
                      </span>
                    </div>
                    <ArrowRight className="w-4 h-4 text-muted-foreground/50 flex-shrink-0 mt-4" />
                    <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60">{t('New')}</span>
                      <input
                        id="publish-version"
                        value={version}
                        onChange={e => { draftDirty.current = true; setVersion(e.target.value); setVersionTouched(true); clearInvalid('version'); setSubmitError(null) }}
                        className={`w-full px-3 py-2 text-[13px] bg-muted/40 border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground font-mono ${invalid.has('version') ? 'border-red-400 ring-1 ring-red-400/40' : 'border-border/60'}`}
                      />
                    </div>
                  </div>
                ) : (
                  <input
                    id="publish-version"
                    value={version}
                    onChange={e => { draftDirty.current = true; setVersion(e.target.value); setVersionTouched(true); clearInvalid('version'); setSubmitError(null) }}
                    className={`w-full px-3 py-2 text-[13px] bg-muted/40 border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground font-mono ${invalid.has('version') ? 'border-red-400 ring-1 ring-red-400/40' : 'border-border/60'}`}
                  />
                )}
                {storeVersion && (
                  <p className="text-[11px] text-muted-foreground/70">
                    {t('The new version must be higher than v{{version}}.', { version: storeVersion })}
                  </p>
                )}
              </div>
              </div>
            </div>
          )}

          {/* Associated skills — always submitted with the digital human; only the
              "list separately" toggle is the creator's choice. */}
          {!submitSuccess && formSkills.length > 0 && (
            <div className="space-y-2">
              <FormSection>{t('Associated Skills')}</FormSection>
              <div className="rounded-xl bg-background p-4 space-y-4">

              <div className="flex flex-col gap-1.5">
                <div className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60 overflow-hidden bg-background">
                  {formSkills.map(skill => (
                    <BundledSkillItem
                      key={skill.key}
                      name={skill.name}
                      published={skill.published}
                      coListed={coPublishIds.includes(skill.key)}
                      onToggle={on => setCoPublishIds(ids => on ? [...ids, skill.key] : ids.filter(x => x !== skill.key))}
                    />
                  ))}
                </div>
                <p className="rounded-lg border border-border/60 bg-muted/30 px-3.5 py-2.5 text-xs leading-relaxed text-muted-foreground">
                  {t('These skills are submitted together with this digital human. Turn on "List separately" to also publish the skill as its own entry in the store\'s Skill list; otherwise it stays a private capability of the digital human and is not listed on its own.')}
                </p>
              </div>
              </div>
            </div>
          )}

          {/* Pre-flight findings */}
          {!submitSuccess && preflight.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {preflight.map((f, i) => (
                <div
                  key={`${f.code}-${i}`}
                  className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-xs ${
                    f.severity === 'error'
                      ? 'bg-red-500/10 border-red-500/20 text-red-400'
                      : 'bg-amber-500/10 border-amber-500/20 text-amber-500'
                  }`}
                >
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                  <span className="whitespace-pre-wrap break-words">{describeFinding(f, t)}</span>
                </div>
              ))}
            </div>
          )}

          {/* Submit feedback */}
          {submitError && (
            <div className="flex flex-col gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
              <div className="flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span className="whitespace-pre-wrap break-words">{submitError}</span>
              </div>
              {authExpired && (
                <button
                  onClick={handleReloginAndRetry}
                  disabled={signingIn}
                  className="self-start flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
                >
                  {signingIn && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {t('Sign in and retry')}
                </button>
              )}
            </div>
          )}
            </div>
          )}
          </>
          )}
        </div>

        {/* Footer — hidden on the type-choice step (close via the header ✕) */}
        {signedIn === true && step !== 'type' && (
        <div className="flex items-center gap-3 px-7 py-4 border-t border-border/60 flex-shrink-0">
          <button
            onClick={onClose}
            className="flex-1 px-5 py-2.5 text-[13px] text-muted-foreground border border-border/60 rounded-lg hover:text-foreground hover:border-border transition-colors"
          >
            {submitSuccess ? t('Done') : t('Cancel')}
          </button>
          {submitSuccess ? (
            <button
              onClick={handleViewPublished}
              className="flex-1 flex items-center justify-center gap-1.5 px-5 py-2.5 text-[13px] font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
            >
              {t('View')}
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={submitting || parsing}
              className="flex-1 flex items-center justify-center gap-1.5 px-5 py-2.5 text-[13px] font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {submitting ? t('Publishing...') : t('Publish to Store')}
            </button>
          )}
        </div>
        )}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────

/** Infer the app type of an imported folder from its contents. A digital human
 * bundles its skills (which carry SKILL.md), so a spec.yaml is the decisive
 * marker for a digital human; a SKILL.md with no spec.yaml marks a lone skill.
 * Mirrors detectZipAppType so folder and .zip imports classify the same way. */
function detectFolderType(files: Record<string, string>): ShareType {
  const hasBasename = (name: string) =>
    Object.keys(files).some(path => (path.split('/').pop() ?? '').toLowerCase() === name)
  if (hasBasename('spec.yaml') || hasBasename('spec.yml')) return 'automation'
  return hasBasename('skill.md') ? 'skill' : 'automation'
}

/** Build a localized, user-facing reason from a rejected publish's review
 * findings. Only blocking (fail) findings are surfaced; returns null when there
 * is nothing actionable, so the caller can fall back to the raw error. */
function friendlyReviewError(
  findings: ReviewFinding[] | undefined,
  appName: string,
  t: (k: string, o?: Record<string, unknown>) => string,
): string | null {
  const blocking = findings?.filter(f => f.severity === 'fail') ?? []
  const lines = blocking.map(f => describeReviewFinding(f.rule, appName, t)).filter(Boolean)
  return lines.length ? lines.join('\n') : null
}

/** Literal `t()` per rule so the i18n extractor sees every key. */
function describeReviewFinding(
  rule: string,
  appName: string,
  t: (k: string, o?: Record<string, unknown>) => string,
): string {
  switch (rule) {
    case 'name_unique':
      return t('The name "{{name}}" is already used by another skill in the store. Rename it and publish again.', { name: appName })
    case 'version-conflict':
      return t('"{{name}}" is already published at this version. Raise the version number to release an update.', { name: appName })
    case 'slug_unique':
      return t('A newer version is already published. Raise the version number and try again.')
    case 'dangerous_permissions':
      return t('This app requests permissions that are not allowed in the store.')
    case 'sensitive_categories':
      return t('The content falls into a restricted category and cannot be published as is.')
    case 'schema_valid':
      return t('The app definition is invalid and cannot be published.')
    case 'security_review':
      return t('The security review could not be completed. Please try again later.')
    case 'not-signed-in':
      return t('Your session has expired. Sign in again to publish — your draft is kept.')
    default:
      return ''
  }
}

/** Translate a structured pre-flight finding. Literal `t()` per branch so the
 * i18n extractor can see every key (a variable key would be pruned). */
function describeFinding(f: PreflightFinding, t: (k: string, o?: Record<string, unknown>) => string): string {
  switch (f.code) {
    case 'secret-detected':
      return t('Possible secret detected ({{kind}}). Remove it before publishing.', { kind: f.detail ?? '' })
    case 'version-not-incremented':
      return t('Version must be higher than the published version ({{versions}}).', { versions: f.detail ?? '' })
    case 'missing-name':
      return t('App name is required')
    case 'missing-description':
      return t('App description is empty — add one so others understand what this does.')
  }
}

// ────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────

const MAX_TAGS = 8
const MAX_TAG_LEN = 20

interface BundledSkillItemProps {
  name: string
  published: boolean
  coListed: boolean
  onToggle: (on: boolean) => void
}

function BundledSkillItem({ name, published, coListed, onToggle }: BundledSkillItemProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 bg-background text-[13px]">
      <span className="flex-1 min-w-0 truncate text-foreground">{name}</span>
      {published ? (
        <span className="flex-shrink-0 inline-flex items-center whitespace-nowrap px-1.5 py-px rounded text-[10.5px] leading-4 font-medium bg-app-skill/10 text-app-skill">
          {t('Already listed')}
        </span>
      ) : (
        <>
          <span className="flex-shrink-0 text-[11px] text-muted-foreground whitespace-nowrap">{t('List separately')}</span>
          <Switch checked={coListed} onCheckedChange={onToggle} size="sm" />
        </>
      )}
    </div>
  )
}

interface TagInputProps {
  tags: string[]
  onChange: (tags: string[]) => void
}

/** Chip-style tag entry: up to 8 tags, ≤20 chars each, trimmed and
 * de-duplicated. Enter or comma commits the pending token. */
function TagInput({ tags, onChange }: TagInputProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')

  const commit = (raw: string) => {
    const tag = raw.trim().slice(0, MAX_TAG_LEN)
    if (tag && tags.length < MAX_TAGS && !tags.includes(tag)) onChange([...tags, tag])
    setDraft('')
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="publish-tags" className="text-xs font-semibold text-muted-foreground">
        {t('Tags')} <span className="text-muted-foreground/60">{t('(optional, up to {{max}})', { max: MAX_TAGS })}</span>
      </label>
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 bg-muted/40 border border-border/60 rounded-lg focus-within:ring-1 focus-within:ring-primary">
        {tags.map(tag => (
          <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-background border border-border rounded text-foreground">
            {tag}
            <button
              type="button"
              onClick={() => onChange(tags.filter(x => x !== tag))}
              className="text-muted-foreground hover:text-foreground"
              aria-label={t('Remove tag')}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        {tags.length < MAX_TAGS && (
          <input
            id="publish-tags"
            value={draft}
            onChange={e => setDraft(e.target.value.replace(/,/g, ''))}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(draft) }
              else if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1))
            }}
            onBlur={() => commit(draft)}
            maxLength={MAX_TAG_LEN}
            placeholder={tags.length === 0 ? t('Add a tag and press Enter') : ''}
            className="flex-1 min-w-[8rem] bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
          />
        )}
      </div>
    </div>
  )
}

/** Section header shown at the top of each publish-form group card. */
function FormSection({ children }: { children: ReactNode }) {
  return <div className="text-[13px] font-semibold text-foreground">{children}</div>
}

interface SourceSegProps {
  active: boolean
  onClick: () => void
  label: string
  icon: ReactNode
}

function SourceSeg({ active, onClick, label, icon }: SourceSegProps) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 text-[12.5px] rounded-md transition-colors ${
        active
          ? 'bg-background text-foreground font-semibold shadow-sm'
          : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

interface InstalledPickerProps {
  apps: InstalledApp[]
  selectedId: string | null
  onSelect: (id: string) => void
  type: ShareType
  invalid?: boolean
}

function InstalledPicker({ apps, selectedId, onSelect, type, invalid }: InstalledPickerProps) {
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
      <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
        {type === 'automation' ? t('Pick a digital human to share') : t('Pick a skill to share')} <span className="text-red-400">*</span>
      </label>
      <select
        value={selectedId ?? ''}
        onChange={e => onSelect(e.target.value)}
        className={`w-full px-3 py-2 text-[13px] bg-muted/40 border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary ${selectedId ? 'text-foreground' : 'text-muted-foreground/50'} ${invalid ? 'border-red-400 ring-1 ring-red-400/40' : 'border-border'}`}
      >
        <option value="" disabled>
          {type === 'automation' ? t('Select a digital human') : t('Select a skill')}
        </option>
        {apps.map(a => (
          <option key={a.id} value={a.id} className="text-foreground">
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
    <div className="flex items-start gap-3 p-3 bg-muted/40 rounded-lg border border-border/60">
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


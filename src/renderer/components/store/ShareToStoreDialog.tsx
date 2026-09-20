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
import { createPortal } from 'react-dom'
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
  Search,
  Check,
  ChevronDown,
} from 'lucide-react'
import { Switch } from '../ui/Switch'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'
import { parse as parseYaml } from 'yaml'
import { useAppStore } from '../../stores/app.store'
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
  processZipFile,
  parseSkillFiles,
  parseMd,
  type ParsedSkill,
} from '../apps/skill-import-utils'
import {
  parseDigitalHumanZip,
  parseDigitalHumanFolder,
  type ZipParseResult,
  type BundledSkill,
} from '../apps/zip-import-utils'
import { detectAppType, detectArchiveAppType, type DetectedAppType } from '../apps/app-type-detect'
import { readDirectoryEntryToMap, readFileListToMap } from '../apps/file-read-utils'
import { FileImportZone } from '../apps/FileImportZone'
import { AppTypeIcon } from './AppTypeIcon'
import { AuthorField } from './AuthorField'
import { loadStoredAuthor, saveAuthor } from './publish-author'
import { publishDraftKey, loadPublishDraft, savePublishDraft, clearPublishDraft } from './publish-draft'
import { useStoreCategories, categoryDisplay } from '../../hooks/useStoreCategories'
import { useStoreCapabilities } from '../../hooks/useStoreCapabilities'
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
  /** False when the author never marked this dependency `bundled: true` — it is
   * packaged only because it doesn't resolve from any configured registry. */
  declaredBundled?: boolean
  /** Neither installed nor resolvable from any registry — publish will fail
   * until this is fixed. Shown in the list (red) rather than silently omitted. */
  missing?: boolean
  /** Already resolves from a configured registry under its own listing — not
   * packaged with this DH. Shown for visibility, with nothing to co-publish. */
  fromStore?: boolean
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

/** Thrown when the dropped file's extension is not one the selected type can
 * take at all. It carries no message: the failure describer replaces it with
 * the accepted-format copy, which is translated and names every format. */
class UnsupportedImport extends Error {}

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
  /** The listing being updated, when the dialog was opened from an existing
   * publication (the "publish new version" / relist / resubmit actions in My
   * Publications). It carries what only that record knows — the slug publish
   * targets and the version to increment from — which is otherwise reachable
   * only by probing an installed app. A package re-imported to update a listing
   * has no local app to probe, so without this the form would treat an update
   * as a first-time publish. */
  republishTarget?: RepublishTarget
}

export interface RepublishTarget {
  slug: string
  /** The published version, i.e. the one to increment from. */
  version: string
  /** The listing's presentable name, used to detect a retarget (see below). */
  name: string
  /** A skill's command identifier, which is what its slug derives from. Absent
   * for a digital human, whose slug derives from the presentable name. */
  commandName?: string
}

// ────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────

export function ShareToStoreDialog({ onClose, initialType, initialAppId, entry, republishTarget }: ShareToStoreDialogProps) {
  const republish = !!republishTarget
  // Read as values, not as an object: the freshness effect below would otherwise
  // key on the prop's identity and re-request on every render of a caller that
  // builds it inline.
  const targetSlug = republishTarget?.slug
  const targetVersion = republishTarget?.version
  const targetName = republishTarget?.name
  const targetCommandName = republishTarget?.commandName
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const showToast = useNotificationStore(s => s.show)
  // Post-publish "View" jumps to My Publications so the creator can see the
  // freshly-listed entry. This dialog can be opened from outside StorePage
  // (e.g. AppsPage), so "jump" means a real navigation, not just a tab set.
  const navigate = useAppStore(s => s.navigate)
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

  // Under account-level identity the author is the signed-in creator, not free
  // text — prefill it from the uid (ASCII-safe, drives the slug and matches
  // ownership) and lock the field.
  const capabilities = useStoreCapabilities()
  const isAccountIdentity = capabilities?.identity === 'account'
  // Sign-in gate: null = still checking, false = must sign in first, true = ready.
  // Weaker identity modes need no creator account, so they start ready.
  const [signedIn, setSignedIn] = useState<boolean | null>(isAccountIdentity ? null : true)
  const [signingIn, setSigningIn] = useState(false)
  useEffect(() => {
    if (!isAccountIdentity) { setSignedIn(true); return }
    let cancelled = false
    api.storeGetIdentity().then(res => {
      const uid = res.success ? res.data?.uid : undefined
      if (cancelled) return
      setSignedIn(!!uid)
      if (uid) setAuthor(uid)
    })
    return () => { cancelled = true }
  }, [isAccountIdentity])

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
  // Where a missing dependency gets installed when the author supplies it
  // locally: the source automation's own space (matching the scope
  // `inspectSkillDeps` classifies against), or global for an imported folder
  // not installed anywhere yet (matching its own scope: null / global-only).
  const missingSkillInstallSpaceId = source === 'installed'
    ? (apps.find(a => a.id === selectedInstalledId)?.spaceId ?? null)
    : null

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
      // Seed from the presentable name: for a skill the canonical name is its
      // command identifier, which is not what the listing should show.
      setName(sourceSpec?.display_name ?? sourceSpec?.name ?? '')
      setChangelog('')
      setDescription(sourceSpec?.description ?? '')
      setTags(sourceTags ?? [])
      // Pre-fill the scene category from the app's existing store metadata so a
      // new-version publish keeps its category instead of forcing a re-pick.
      if (sourceCategory) setCategory(sourceCategory)
    }
    // Re-seeding a fresh target is not a user edit.
    draftDirty.current = false
  }, [sourceSpec?.name, sourceSpec?.display_name, sourceSpec?.description, sourceTags, sourceCategory, draft])

  // Updating an existing listing: which installed app a publish would actually
  // land on that slug. It runs the same derivation publish does, so the answer
  // is exact or absent — never a guess. Shown only as a hint in the picker;
  // committing the choice stays with the user, who alone knows whether that app
  // holds the work they mean to release.
  const [pinnedAppId, setPinnedAppId] = useState<string | null>(null)
  useEffect(() => {
    setPinnedAppId(null)
    if (!targetSlug) return
    let cancelled = false
    void api.storeFindAppByPublishSlug(targetSlug, type, debouncedAuthor.trim() || undefined)
      .then(res => { if (!cancelled && res.success) setPinnedAppId(res.data?.appId ?? null) })
    return () => { cancelled = true }
  }, [targetSlug, type, debouncedAuthor])

  // Store version of the target slug — the base the suggested version increments
  // from, and what the pre-flight monotonicity check compares against. Null
  // leaves both dormant, which reads as a first-time publish.
  const [storeVersion, setStoreVersion] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false

    // On an update the scene category and tags live on the published registry
    // entry and are never written back to the local spec, so the store is the
    // only place to read them. Only fields the user left blank are filled.
    const backfillFromListing = async (slug: string) => {
      const detail = await api.storeGetAppDetail(slug)
      if (cancelled || !detail.success) return
      const listing = (detail.data as StoreAppDetail | undefined)?.entry
      if (!listing) return
      if (listing.category) setCategory(prev => prev || listing.category)
      if (listing.tags?.length) setTags(prev => prev.length ? prev : listing.tags)
    }

    const appId = source === 'installed' ? selectedInstalledId : null
    if (!appId) {
      // Whether the package being imported still lands on the listing this
      // dialog was opened for — only then does its version speak for the one
      // about to be published. Each type is asked about whatever its slug
      // derives from: a digital human's presentable name, so renaming retargets
      // a fresh slug and the record stops applying; a skill's command
      // identifier, which a rename leaves alone because the edit lands on
      // display_name instead (see publish's applyDisplayOverride).
      const stillOnListing = type === 'skill'
        ? !!targetCommandName && staged?.spec.name === targetCommandName
        : !!targetName && debouncedName.trim() === targetName
      if (stillOnListing && targetVersion && targetSlug) {
        setStoreVersion(targetVersion)
        void backfillFromListing(targetSlug)
      } else {
        setStoreVersion(null)
      }
      return () => { cancelled = true }
    }

    api.storePublishPreview(appId, debouncedAuthor.trim() || undefined, debouncedName.trim() || undefined)
      .then(async res => {
        if (cancelled) return
        const preview = res.success ? res.data : null
        setStoreVersion(preview?.storeVersion ?? null)
        if (!preview?.slug || !preview.storeVersion) return
        await backfillFromListing(preview.slug)
      })
      .catch(() => { if (!cancelled) setStoreVersion(null) })
    return () => { cancelled = true }
  }, [source, selectedInstalledId, debouncedAuthor, debouncedName, type, targetSlug, targetVersion, targetName])

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

  // Skills that ship with a digital human — either explicitly bundled, or
  // packaged anyway because they aren't resolvable from any registry — each
  // can be co-listed as its own store entry. Two sources: an installed DH
  // resolves them to installed skill apps (with an appId + a "published"
  // probe); an imported package carries them inline (installed on submit, so
  // no appId/probe yet).
  const assoc = useAssociatedSkills(source === 'installed' ? (selectedInstalledId ?? undefined) : undefined, sourceSpec, debouncedAuthor)

  // A `requires.skills` entry that resolves from no registry and matches no
  // installed skill app blocks publish outright (collectFiles aborts at
  // submit) — folded into the pre-flight so it surfaces before the user fills
  // out the rest of the form. An imported folder's own bundled skills satisfy
  // their matching dependency even though they aren't installed yet (they
  // will be, into the staging space, ahead of this same check server-side).
  const missingSkillIds = useMemo(() => {
    if (source === 'installed') return assoc.missingSkillIds
    const bundledIds = new Set((staged?.bundledSkills ?? []).map(b => b.name))
    return assoc.missingSkillIds.filter(id => !bundledIds.has(id))
  }, [source, assoc.missingSkillIds, staged])

  const formSkills = useMemo<FormSkill[]>(() => {
    // assoc.skills covers dependencies satisfied by an already-installed skill
    // app — for an imported (not-yet-installed) automation that includes a
    // dependency fixed locally via the missing-row import button, since that
    // installs into the global scope rather than into `staged.bundledSkills`.
    const resolvedFromAssoc: FormSkill[] = assoc.skills.map(s => ({ key: s.appId, name: s.name, published: s.published, appId: s.appId, declaredBundled: s.declaredBundled }))
    const resolved: FormSkill[] = source === 'installed'
      ? resolvedFromAssoc
      : [
          ...resolvedFromAssoc,
          ...(staged?.bundledSkills ?? []).map(b => ({
            key: `bundled:${b.name}`,
            name: parseMd(b.files['SKILL.md'] ?? '').name || b.name,
            published: false,
            bundled: b,
          })),
        ]
    const missing: FormSkill[] = missingSkillIds.map(id => ({ key: `missing:${id}`, name: id, published: false, missing: true }))
    const storeLinked: FormSkill[] = assoc.storeLinkedSkills.map(s => ({ key: `store:${s.specId}`, name: s.name, published: false, fromStore: true }))
    return [...resolved, ...storeLinked, ...missing]
  }, [source, assoc.skills, assoc.storeLinkedSkills, staged, missingSkillIds])

  const preflight = useMemo<PreflightFinding[]>(() => {
    if (!sourceSpec) return []
    const findings = runPublishPreflight({ spec: sourceSpec, storeVersion, overrideName: name, overrideDescription: description, overrideVersion: version })
    if (missingSkillIds.length > 0) {
      findings.push({ severity: 'error', code: 'missing-skill-dependency', detail: missingSkillIds.join(', ') })
    }
    return findings
  }, [sourceSpec, storeVersion, name, description, version, missingSkillIds])
  const hasBlockingIssue = preflight.some(f => f.severity === 'error')

  const [coPublishIds, setCoPublishIds] = useState<string[]>([])
  // Reset co-list selections when the underlying app/import changes so stale
  // keys never leak into a different publish.
  useEffect(() => { setCoPublishIds([]) }, [source, selectedInstalledId, staged])

  useEffect(() => {
    void api.trackEvent('store.publish.open', entry ? { entry } : {})
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
  // Skip the initial mount so a restored draft category (seeded above) is not
  // wiped — this effect must only react to an actual type change.
  const typeSwitchGuard = useRef(true)
  useEffect(() => {
    if (typeSwitchGuard.current) { typeSwitchGuard.current = false; return }
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

  // ── Import failure messages ──────────────────

  /** The format the selected type accepts, or — when the package is plainly of
   * the other type — an invitation to switch the type. The type is never
   * switched for the user: a silent switch moves the app they are publishing
   * out from under them. */
  const describeRejection = useCallback((detected: DetectedAppType | null): string => {
    if (type === 'skill') {
      return detected === 'automation'
        ? t('This looks like a digital human package, but the app type is set to Skill. Switch the app type to Digital Human, or choose a skill package.')
        : t('Not a skill package. A skill must contain SKILL.md at its root. Accepted: a .md file, a folder containing SKILL.md, or a .zip containing SKILL.md.')
    }
    return detected === 'skill'
      ? t('This looks like a skill package, but the app type is set to Digital Human. Switch the app type to Skill, or choose a digital human package.')
      : t('Not a digital human package. A digital human must contain spec.yaml at its root. Accepted: .zip, .dhpkg, .yaml, or a folder containing spec.yaml.')
  }, [type, t])

  /** Only a package positively identified as the *other* type is worth
   * overriding the parser with — that diagnosis is about the wrong question.
   * A null detection means unknown, never "wrong type", so it must leave the
   * parser's own reason standing: it names the offending field, and an archive
   * refused for its size or read as corrupt reports through it. */
  const describeFailure = useCallback((detected: DetectedAppType | null, err: unknown): string => {
    if (detected && detected !== type) return describeRejection(detected)
    return err instanceof Error && err.message ? err.message : describeRejection(detected)
  }, [type, describeRejection])

  /** What the file actually holds, consulted only to explain a failure. Only a
   * .zip is ambiguous enough to be worth reading; the read refuses an oversized
   * archive on its own, which lands as "unknown". */
  const probeFile = useCallback(async (file: File): Promise<DetectedAppType | null> => {
    const lower = file.name.toLowerCase()
    if (lower.endsWith('.md')) return 'skill'
    if (lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.dhpkg')) return 'automation'
    if (lower.endsWith('.zip')) return detectArchiveAppType(file)
    return null
  }, [])

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
        else throw new UnsupportedImport()
      } else {
        if (lower.endsWith('.zip') || lower.endsWith('.dhpkg')) await parseAutomationZip(file)
        else if (lower.endsWith('.yaml') || lower.endsWith('.yml')) await parseAutomationYaml(file)
        else throw new UnsupportedImport()
      }
    } catch (err) {
      setParseError(describeFailure(await probeFile(file), err))
    } finally {
      setParsing(false)
    }
  }, [type, parseSkillFromMd, parseSkillFromZip, parseAutomationZip, parseAutomationYaml, probeFile, describeFailure])

  const stageFolder = useCallback(async (files: Record<string, string>, folderName: string) => {
    if (type === 'skill') stageSkill(parseSkillFiles(files, folderName), folderName, 'folder')
    else await parseAutomationFolder(files, folderName)
  }, [type, parseAutomationFolder])

  const handleFolder = useCallback(async (entry: FileSystemDirectoryEntry) => {
    setParseError(null)
    setStaged(null)
    setParsing(true)
    // Held outside the try so a failure mid-parse can still be classified.
    let files: Record<string, string> = {}
    try {
      files = await readDirectoryEntryToMap(entry)
      await stageFolder(files, entry.name)
    } catch (err) {
      setParseError(describeFailure(detectAppType(Object.keys(files)), err))
    } finally {
      setParsing(false)
    }
  }, [stageFolder, describeFailure])

  const handleFolderList = useCallback(async (fileList: FileList) => {
    setParseError(null)
    setStaged(null)
    setParsing(true)
    let files: Record<string, string> = {}
    try {
      const read = await readFileListToMap(fileList)
      files = read.files
      await stageFolder(files, read.folderName || t('Folder'))
    } catch (err) {
      setParseError(describeFailure(detectAppType(Object.keys(files)), err))
    } finally {
      setParsing(false)
    }
  }, [stageFolder, describeFailure, t])

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

      void api.trackEvent('store.publish.submit', { appType: type, result: 'success', entry, isUpdate: republish ? 1 : 0 })
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
      void api.trackEvent('store.publish.submit', { appType: type, result: 'fail', entry, isUpdate: republish ? 1 : 0 })
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
    navigate('store')
    setStoreMineOpen(true)
  }, [onClose, navigate, setStoreMineOpen])

  // Session expired during publish: re-authenticate, then resubmit the form
  // (still fully populated — the draft was never dropped) in one tap.
  const handleReloginAndRetry = useCallback(async () => {
    if (signingIn) return
    setSigningIn(true)
    try {
      // force: the current token was just rejected (401), so re-run OAuth to mint
      // a fresh one instead of getting the stale token handed back.
      const res = await api.storeEnsureSignedIn(true)
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
              pinned={pinnedAppId && targetSlug ? { appId: pinnedAppId, slug: targetSlug } : undefined}
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
                ? t('Drop a skill file here')
                : t('Drop a digital human file here')}
              dropHint={type === 'skill'
                ? t('Or click to choose · .md · .zip')
                : t('Or click to choose · .zip · .dhpkg · .yaml')}
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
                {type === 'skill' && sourceSpec?.name && (
                  <p className="text-[11px] text-muted-foreground">
                    {t('Command')} <span className="font-mono">/{sourceSpec.name}</span>
                  </p>
                )}
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
                readOnly={isAccountIdentity}
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
                      declaredBundled={skill.declaredBundled}
                      missing={skill.missing}
                      fromStore={skill.fromStore}
                      installSpaceId={missingSkillInstallSpaceId}
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
    case 'missing-skill-dependency':
      return t('Skill dependency not found: {{ids}}. Install it first (or include it in the imported folder), then try again.', { ids: f.detail ?? '' })
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
  /** False when this dependency isn't declared `bundled: true` — it is packaged
   * only because it doesn't resolve from any configured registry. */
  declaredBundled?: boolean
  /** Neither installed nor resolvable — publish will fail until this is fixed.
   * Rendered as a plain red row with no co-list toggle (nothing to co-publish yet). */
  missing?: boolean
  /** Already resolves from a configured registry under its own listing — not
   * packaged with this DH. No co-list toggle (nothing local to co-publish). */
  fromStore?: boolean
  /** Space a locally-supplied fix for a `missing` dependency installs into —
   * the source automation's own space, or global (null) when imported. */
  installSpaceId?: string | null
}

function BundledSkillItem({ name, published, coListed, onToggle, declaredBundled = true, missing = false, fromStore = false, installSpaceId = null }: BundledSkillItemProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2.5 px-3 py-2.5 bg-background text-[13px]">
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className={`truncate ${missing ? 'text-red-400' : 'text-foreground'}`}>{name}</span>
        {missing && (
          <span className="text-[11px] text-red-400/80">
            {t('Not installed and not resolvable from a registry — publish will fail until this is resolved.')}
          </span>
        )}
        {fromStore && (
          <span className="text-[11px] text-muted-foreground">
            {t('Already resolves from a registry — not packaged with this digital human.')}
          </span>
        )}
        {!missing && !fromStore && !declaredBundled && !published && (
          <span className="text-[11px] text-muted-foreground">
            {t('Not resolvable from a registry — will be embedded in this package.')}
          </span>
        )}
      </div>
      {missing ? (
        <>
          <span className="flex-shrink-0 inline-flex items-center whitespace-nowrap px-1.5 py-px rounded text-[10.5px] leading-4 font-medium bg-red-500/10 text-red-400">
            {t('Missing')}
          </span>
          <MissingSkillInstallButton depId={name} spaceId={installSpaceId} />
        </>
      ) : fromStore ? (
        <span className="flex-shrink-0 inline-flex items-center whitespace-nowrap px-1.5 py-px rounded text-[10.5px] leading-4 font-medium bg-muted text-muted-foreground">
          {t('From store')}
        </span>
      ) : published ? (
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

interface MissingSkillInstallButtonProps {
  /** The `requires.skills[]` id this row is missing. The installed skill's
   * `name` is forced to this exact value — classification matches an
   * installed skill by exact `specId`, not by its authored frontmatter name. */
  depId: string
  /** Space to install into — the source automation's own space, or global
   * (null) for an imported folder that has nothing installed yet. */
  spaceId: string | null
}

/** Inline fix for a missing dependency row: pick a local skill file/folder,
 * install it under the exact id the dependency needs, then close. The row
 * itself updates on its own once `useAssociatedSkills` re-classifies against
 * the refreshed installed-apps list. */
function MissingSkillInstallButton({ depId, spaceId }: MissingSkillInstallButtonProps) {
  const { t } = useTranslation()
  const showToast = useNotificationStore(s => s.show)
  const installApp = useAppsStore(s => s.installApp)
  const [open, setOpen] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState('')

  const install = useCallback(async (parsed: ParsedSkill) => {
    setProcessing(true)
    setError('')
    try {
      const spec: SkillSpec = {
        spec_version: '1.0',
        version: '1.0',
        name: depId,
        description: parsed.description || depId,
        type: 'skill',
        skill_files: parsed.skillFiles,
      }
      const appId = await installApp(spaceId, spec)
      if (!appId) throw new Error(t('Install failed.'))
      showToast({ title: t('Skill installed'), variant: 'success', duration: 3000 })
      setOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Install failed.'))
    } finally {
      setProcessing(false)
    }
  }, [depId, spaceId, installApp, showToast, t])

  const handleFile = useCallback(async (file: File) => {
    setError('')
    const lower = file.name.toLowerCase()
    try {
      if (lower.endsWith('.md')) await install(await processMdFile(file))
      else if (lower.endsWith('.zip')) await install(await processZipFile(file))
      else setError(t('Unsupported file type. Choose a .md file, a .zip archive, or a skill folder.'))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to read file'))
    }
  }, [install, t])

  const handleDirEntry = useCallback(async (entry: FileSystemDirectoryEntry) => {
    setError('')
    try {
      await install(parseSkillFiles(await readDirectoryEntryToMap(entry), entry.name))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to read folder'))
    }
  }, [install, t])

  const handleFolderList = useCallback(async (fileList: FileList) => {
    setError('')
    try {
      const { files, folderName } = await readFileListToMap(fileList)
      await install(parseSkillFiles(files, folderName))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Failed to read folder'))
    }
  }, [install, t])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        title={t('Import a local skill to satisfy this dependency')}
        className="flex-shrink-0 inline-flex items-center justify-center w-6 h-6 rounded text-red-400 hover:bg-red-500/10 transition-colors"
      >
        <Upload className="w-3.5 h-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <FileImportZone
          onFile={handleFile}
          onDirectoryEntry={handleDirEntry}
          onFolderFileList={handleFolderList}
          fileAccept=".md,.zip"
          dropLabel={t('Drop a skill file here')}
          dropHint={t('Or click to choose · .md · .zip')}
          folderLabel={t('Browse skill folder...')}
          processing={processing}
        />
        {error && <p className="mt-2 text-[11px] text-red-400">{error}</p>}
      </PopoverContent>
    </Popover>
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
  /** The app whose publish would land on `slug`, when updating an existing
   * listing. Sorted to the top of the list and annotated with the slug, so the
   * user can recognise it among same-looking names — the local app's name is
   * often not the one the listing shows. Deliberately not pre-selected. */
  pinned?: { appId: string; slug: string }
}

function InstalledPicker({ apps, selectedId, onSelect, type, invalid, pinned }: InstalledPickerProps) {
  const { t } = useTranslation()
  const selected = apps.find(a => a.id === selectedId) ?? null
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  // Anchor rect for the portaled dropdown — a plain absolute layer would be
  // clipped by the dialog's scroll container, so the list floats in a portal.
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null)
  const fieldRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const openList = useCallback(() => {
    const r = fieldRef.current?.getBoundingClientRect()
    if (r) setAnchor({ top: r.bottom + 4, left: r.left, width: r.width })
    setOpen(true)
  }, [])

  // The closed input mirrors the committed selection; typing (open) overrides it.
  useEffect(() => {
    if (!open) setQuery(selected ? selected.spec.name : '')
  }, [open, selected])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (fieldRef.current?.contains(target) || listRef.current?.contains(target)) return
      setOpen(false)
    }
    // The dropdown is fixed-positioned and cannot follow the dialog scrolling, so
    // close it when an ancestor scrolls — but not when the list itself scrolls.
    const onScroll = (e: Event) => {
      if (listRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onResize = () => setOpen(false)
    // Capture phase: the dialog panel stops mousedown propagation (to guard its
    // own backdrop-close), which would otherwise hide this outside click.
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    // A freshly opened input still shows the selection's name — treat that as "no
    // filter" so the full list is browsable, not narrowed to the current pick.
    if (!q || (selected && q === selected.spec.name.toLowerCase())) return apps
    return apps.filter(a => a.spec.name.toLowerCase().includes(q))
  }, [apps, query, selected])

  // Lift the pinned app to the top so the annotated row is the first thing read.
  const ordered = useMemo(() => {
    if (!pinned) return filtered
    const i = filtered.findIndex(a => a.id === pinned.appId)
    if (i <= 0) return filtered
    return [filtered[i], ...filtered.slice(0, i), ...filtered.slice(i + 1)]
  }, [filtered, pinned])

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

      <div ref={fieldRef} className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60" />
        <input
          value={query}
          onChange={e => { setQuery(e.target.value); openList() }}
          onFocus={openList}
          placeholder={type === 'automation' ? t('Select a digital human') : t('Select a skill')}
          className={`w-full pl-8 pr-8 py-2 text-[13px] bg-muted/40 border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary text-foreground placeholder:text-muted-foreground/50 ${invalid ? 'border-red-400 ring-1 ring-red-400/40' : 'border-border/60'}`}
        />
        <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60 pointer-events-none" />
      </div>

      {open && anchor && createPortal(
        <div
          ref={listRef}
          style={{ position: 'fixed', top: anchor.top, left: anchor.left, width: anchor.width }}
          className="z-[60] max-h-44 overflow-y-auto rounded-lg border border-border/60 bg-background shadow-lg divide-y divide-border/60"
        >
          {ordered.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground text-center">{t('No matches')}</p>
          ) : (
            ordered.map(a => (
              <button
                key={a.id}
                type="button"
                onClick={() => { onSelect(a.id); setOpen(false) }}
                className={`flex w-full flex-col gap-0.5 px-3 py-2 text-left text-[13px] transition-colors ${
                  selectedId === a.id ? 'bg-primary/10 font-medium text-foreground' : 'text-foreground hover:bg-secondary/50'
                }`}
              >
                <span className="flex w-full items-center gap-2">
                  <span className="flex-1 min-w-0 truncate">{a.spec.name}</span>
                  {a.spec.version && <span className="flex-shrink-0 text-[11px] text-muted-foreground">v{a.spec.version}</span>}
                  {selectedId === a.id && <Check className="w-3.5 h-3.5 flex-shrink-0 text-primary" />}
                </span>
                {pinned?.appId === a.id && (
                  <span className="w-full truncate text-[11px] font-normal text-muted-foreground">
                    {t('Publishing this app updates {{slug}}', { slug: pinned.slug })}
                  </span>
                )}
              </button>
            ))
          )}
        </div>,
        document.body,
      )}
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


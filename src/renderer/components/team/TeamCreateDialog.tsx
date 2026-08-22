/**
 * TeamCreateDialog — Create-team form.
 *
 * Asks only for what creation actually decides: name, goal, members. The
 * owning space defaults to the current one and shows as a one-line summary
 * with a "Change" affordance (the lead and any AI-built members are created
 * there); coordination and escalation live under a collapsed "Advanced
 * options" section. The lead is always auto-assigned here — promoting a
 * specific member happens in team Settings, where the lead is visible. For
 * the same reason the escalation wording avoids naming the lead here, while
 * Settings names it: the reader there has already met it.
 *
 * Members come from two actions in the same row: pick existing digital
 * humans, or let AI propose a roster from the goal. The AI path confirms the
 * proposal (cost governance) before teamCreate runs with it.
 *
 * Validation: name + goal required; creating directly requires ≥1 member.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X, Plus, Sparkles, ChevronDown, ChevronRight } from 'lucide-react'
import type {
  CreateTeamInput,
  MemberSourcing,
  CollabMode,
  EscalationRouting,
  TeamMemberInput,
  ProposedMember,
} from '../../../shared/apps/team-types'
import { leadAppIdSet } from '../../../shared/apps/team-types'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { useAppsStore } from '../../stores/apps.store'
import { useTeamStore } from '../../stores/team.store'
import { useSpaceStore } from '../../stores/space.store'
import { useTranslation } from '../../i18n'
import { SystemPromptEditor } from '../apps/SystemPromptEditor'
import { AppInstallDialog } from '../apps/AppInstallDialog'
import { SpacePicker } from '../apps/SpacePicker'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/Popover'

interface TeamCreateDialogProps {
  onClose: () => void
  onCreated?: (teamId: string) => void
}

export function TeamCreateDialog({ onClose, onCreated }: TeamCreateDialogProps) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const teams = useTeamStore(s => s.teams)
  const proposeMembers = useTeamStore(s => s.proposeMembers)
  const createTeam = useTeamStore(s => s.createTeam)
  const isProposing = useTeamStore(s => s.isProposing)
  // The store already holds what actually went wrong. Restating a guess here
  // would put a second, less informed explanation next to it.
  const storeError = useTeamStore(s => s.error)
  const isCreating = useTeamStore(s => s.isCreating)

  const spaces = useSpaceStore(s => s.spaces)
  const haloSpace = useSpaceStore(s => s.haloSpace)
  const currentSpace = useSpaceStore(s => s.currentSpace)

  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  // The lead and every AI-built member are created in this space, so it must
  // be chosen deliberately — but the space the user is already working in is
  // the right answer for most teams, so it starts pre-filled and changeable
  // rather than asked as a required question.
  const defaultSpaceId = currentSpace?.id ?? haloSpace?.id ?? spaces[0]?.id ?? ''
  const [selectedSpaceId, setSelectedSpaceId] = useState(defaultSpaceId)
  const [spaceEditing, setSpaceEditing] = useState(false)
  const [collabMode, setCollabMode] = useState<CollabMode>('free')
  const [escalationRouting, setEscalationRouting] = useState<EscalationRouting>('lead')
  const [selectedAppIds, setSelectedAppIds] = useState<string[]>([])
  const [submitted, setSubmitted] = useState(false)
  // Advanced options (coordination / escalation) stay collapsed by default —
  // sensible defaults cover most teams, keeping creation low-friction.
  const [showAdvanced, setShowAdvanced] = useState(false)
  // Stacked on top of this dialog rather than replacing it, so the in-progress
  // team form (name, goal, already-picked members) survives the inline
  // digital-human creation flow regardless of whether it's finished or cancelled.
  const [showInlineCreate, setShowInlineCreate] = useState(false)
  const [showMemberPicker, setShowMemberPicker] = useState(false)

  // AI-proposal confirmation step
  const [proposal, setProposal] = useState<ProposedMember[] | null>(null)
  const [proposeEmpty, setProposeEmpty] = useState(false)
  // A backend failure only raised a toast, which is gone by the time the user
  // looks back at the dialog — leaving a screen that did not react at all.
  const [proposeFailed, setProposeFailed] = useState(false)

  // Spaces can load after this dialog mounts; backfill the default only while
  // the user has not picked one themselves.
  useEffect(() => {
    if (!selectedSpaceId && defaultSpaceId) setSelectedSpaceId(defaultSpaceId)
  }, [selectedSpaceId, defaultSpaceId])

  // Expanding a section near the bottom (space picker, advanced options)
  // grows the scrolled body, leaving the new content below the fold — scroll
  // just enough to reveal it once the expand animation has settled.
  const bodyRef = useRef<HTMLDivElement>(null)
  const spaceSectionRef = useRef<HTMLDivElement>(null)
  const advancedSectionRef = useRef<HTMLDivElement>(null)
  const reveal = (el: HTMLElement | null) => {
    window.setTimeout(() => {
      const body = bodyRef.current
      if (!body || !el) return
      const overflow = el.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom
      if (overflow > 0) body.scrollBy({ top: overflow + 8, behavior: 'smooth' })
    }, 220)
  }

  const allSpaces = useMemo(
    () => (haloSpace ? [haloSpace, ...spaces] : spaces),
    [haloSpace, spaces]
  )
  const selectedSpaceName = useMemo(() => {
    const found =
      allSpaces.find(s => s.id === selectedSpaceId) ??
      (currentSpace?.id === selectedSpaceId ? currentSpace : undefined)
    return found?.name ?? ''
  }, [allSpaces, currentSpace, selectedSpaceId])

  // Lead apps are an internal coordination role and must never be addable as a
  // member; exclude every team's lead from the pickable set.
  const leadAppIds = useMemo(() => leadAppIdSet(teams), [teams])

  // Automation apps available to add. Show ALL of the user's digital humans
  // (any space) so they can be composed into a team — joining never moves a
  // digital human out of its own space.
  const availableApps = useMemo<InstalledApp[]>(
    () => apps.filter(a =>
      a.spec.type === 'automation' &&
      a.status !== 'uninstalled' &&
      !leadAppIds.has(a.id)
    ),
    [apps, leadAppIds]
  )

  const addedApps = useMemo(
    () => selectedAppIds.map(id => availableApps.find(a => a.id === id)).filter(Boolean) as InstalledApp[],
    [selectedAppIds, availableApps]
  )
  const pickableApps = useMemo(
    () => availableApps.filter(a => !selectedAppIds.includes(a.id)),
    [availableApps, selectedAppIds]
  )

  const nameError = submitted && !name.trim()
  const goalError = submitted && !goal.trim()
  const spaceError = submitted && !selectedSpaceId
  const memberError = submitted && selectedAppIds.length === 0

  const addMember = (appId: string) => {
    setSelectedAppIds(ids => [...ids, appId])
    setShowMemberPicker(false)
  }
  const removeMember = (appId: string) => setSelectedAppIds(ids => ids.filter(id => id !== appId))

  const buildInput = (sourcing: MemberSourcing): CreateTeamInput => {
    const members: TeamMemberInput[] | undefined =
      sourcing === 'manual' ? selectedAppIds.map(appId => ({ appId })) : undefined
    return {
      name: name.trim(),
      goal: goal.trim(),
      owningSpaceId: selectedSpaceId,
      memberSourcing: sourcing,
      collabMode,
      escalationRouting,
      members,
      leadAppId: null,
    }
  }

  const finalize = async (sourcing: MemberSourcing, confirmedProposal?: ProposedMember[]) => {
    const team = await createTeam(buildInput(sourcing), confirmedProposal)
    if (team) {
      onCreated?.(team.id)
      onClose()
    }
  }

  // The common required fields; the AI path derives its roster from the goal,
  // so it cannot start without one either way.
  const baseValid = name.trim().length > 0 && goal.trim().length > 0 && selectedSpaceId !== ''

  const handleCreate = async () => {
    setSubmitted(true)
    if (!baseValid || selectedAppIds.length === 0) return
    await finalize('manual')
  }

  const handleAiBuild = async () => {
    setSubmitted(true)
    if (!baseValid) return
    const proposed = await proposeMembers(goal.trim(), selectedSpaceId)
    // null = backend error (toast already shown). Empty = AI returned nothing
    // usable; surface inline so the user can refine the goal or add members
    // themselves rather than confirming an empty roster.
    if (!proposed) {
      setProposeEmpty(false)
      setProposeFailed(true)
      return
    }
    setProposeFailed(false)
    if (proposed.length === 0) {
      setProposeEmpty(true)
      return
    }
    setProposeEmpty(false)
    setProposal(proposed)
  }

  // ── AI proposal confirmation step ──
  if (proposal) {
    return (
      <ConfirmProposalDialog
        proposal={proposal}
        spaceName={selectedSpaceName}
        creating={isCreating}
        onBack={() => setProposal(null)}
        onConfirm={() => finalize('ai', proposal)}
      />
    )
  }

  const busy = isProposing || isCreating

  return createPortal(
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4" onMouseDown={onClose}>
        <div
          // Fixed frame height: inline expansions (member picker, space picker)
          // must scroll the body, not grow the dialog — a resizing modal jumps.
          className="flex h-[min(44rem,90vh)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl"
          onMouseDown={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3 sm:px-6">
            <h2 className="text-base font-medium text-foreground">{t('New team')}</h2>
            <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div ref={bodyRef} className="flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6">
            {/* Name */}
            <Field label={t('Name')} required error={nameError ? t('Name is required') : undefined}>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder={t('e.g. Competitor Analysis Team')}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/50"
              />
            </Field>

            {/* Goal */}
            <Field
              label={t('Goal')}
              required
              hint={t('Describe in plain words what this team should do')}
              error={goalError ? t('Goal is required') : undefined}
            >
              {/* A controlled form field: the value is read on submit, so there is
                  nothing to save on blur or on Done. */}
              <SystemPromptEditor
                value={goal}
                onChange={v => { setGoal(v); setProposeEmpty(false); setProposeFailed(false) }}
                title={t('What this team should get done')}
                placeholder={t('e.g. Every morning, analyze competitors\u2019 activity and send me a brief.')}
                className="bg-background"
              />
            </Field>

            {/* Members */}
            <Field label={t('Members')} error={memberError ? t('Add at least one member, or let AI build the team') : undefined}>
              <div className="space-y-2.5">
                {addedApps.length === 0 ? (
                  <p className="text-sm text-muted-foreground/70">{t('No members added yet.')}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {addedApps.map(app => (
                      <div key={app.id} className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-foreground">{app.spec.name}</p>
                          {app.spaceId && (
                            <p className="truncate font-mono text-[11px] text-muted-foreground">{app.spaceId}</p>
                          )}
                        </div>
                        <button
                          onClick={() => removeMember(app.id)}
                          className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                          title={t('Remove')}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {/* Portal-rendered popover: floats above the dialog without
                      being clipped by its scroll container or affecting its
                      height. */}
                  <Popover open={showMemberPicker} onOpenChange={setShowMemberPicker}>
                    <PopoverTrigger className="rounded-lg border border-border px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary">
                      <span className="flex items-center gap-1.5">
                        <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                        {t('Add a digital human')}
                      </span>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="max-h-48 w-64 overflow-y-auto py-1">
                      {pickableApps.length === 0 ? (
                        <p className="px-3 py-2 text-sm text-muted-foreground/70">
                          {availableApps.length === 0
                            ? t('You have no digital humans yet.')
                            : t('All your digital humans are already added.')}
                        </p>
                      ) : (
                        pickableApps.map(app => (
                          <button
                            key={app.id}
                            onClick={() => addMember(app.id)}
                            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary"
                          >
                            <Plus className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                            <span className="truncate">{app.spec.name}</span>
                          </button>
                        ))
                      )}
                      <div className="mt-1 border-t border-border pt-1">
                        <button
                          onClick={() => { setShowMemberPicker(false); setShowInlineCreate(true) }}
                          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm text-primary transition-colors hover:bg-secondary"
                        >
                          <Plus className="h-3.5 w-3.5 flex-shrink-0" />
                          {t('New digital human…')}
                        </button>
                      </div>
                    </PopoverContent>
                  </Popover>

                  <button
                    onClick={handleAiBuild}
                    disabled={busy || !goal.trim()}
                    title={!goal.trim() ? t('Fill in the goal first — AI builds the team from it.') : undefined}
                    className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
                  >
                    {isProposing
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      : <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />}
                    {t('Let AI build the team from the goal')}
                  </button>
                </div>

                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t('Members keep working in their own spaces — the team just brings them into one room to collaborate, and anything they need to share goes on the board.')}
                </p>

                {proposeEmpty && (
                  <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
                    {t('The AI could not propose members for this goal. Try describing the goal more concretely, or add members yourself instead.')}
                  </p>
                )}
                {proposeFailed && (
                  <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
                    {storeError ?? t('Failed to propose members')}
                  </p>
                )}
              </div>
            </Field>

            {/* Space — where the lead and every AI-built member are created.
                One quiet line by default; the picker expands below it on
                "Change", and the same button collapses it again ("Done"). */}
            <div ref={spaceSectionRef} className="space-y-1.5">
              {selectedSpaceId && (
                <button
                  onClick={() => {
                    setSpaceEditing(v => {
                      if (!v) reveal(spaceSectionRef.current)
                      return !v
                    })
                  }}
                  className="flex w-full items-center justify-between gap-2 text-left"
                >
                  <span className="truncate text-xs text-muted-foreground">
                    {t('New digital humans are saved in the {{name}} space', { name: selectedSpaceName })}
                  </span>
                  <span className="flex-shrink-0 text-xs text-primary">
                    {spaceEditing ? t('Done') : t('Change')}
                  </span>
                </button>
              )}
              <div
                className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                  spaceEditing || !selectedSpaceId ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                }`}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="space-y-1.5">
                    <SpacePicker
                      selectedSpaceId={selectedSpaceId}
                      onSelect={setSelectedSpaceId}
                      label={t('Space')}
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t('The lead and any members AI builds are created in this space. Digital humans you already have keep working in their own spaces after they join.')}
                    </p>
                    {spaceError && <p className="text-xs text-destructive">{t('Choose a space')}</p>}
                  </div>
                </div>
              </div>
              {!spaceEditing && selectedSpaceId && (
                <p className="text-xs leading-relaxed text-muted-foreground/70">
                  {t('Members AI creates and the lead work in this space. Digital humans you add yourself are not affected.')}
                </p>
              )}
            </div>

            {/* Advanced options — collapsed by default to keep creation simple. */}
            <div ref={advancedSectionRef} className="border-t border-border pt-4">
              <button
                type="button"
                onClick={() => {
                  setShowAdvanced(v => {
                    if (!v) reveal(advancedSectionRef.current)
                    return !v
                  })
                }}
                className="flex w-full items-center gap-1.5 text-sm font-medium text-foreground"
              >
                {showAdvanced
                  ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                {t('Advanced options')}
                {!showAdvanced && (
                  <span className="ml-1 truncate text-xs font-normal text-muted-foreground/70">
                    {t('Defaults work for most teams')}
                  </span>
                )}
              </button>

              {showAdvanced && (
                <div className="mt-4 space-y-5">
                  {/* Coordination */}
                  <Field label={t('Coordination')}>
                    <RadioRow
                      checked={collabMode === 'structured'}
                      label={t('Managed mode')}
                      hint={t('The Lead assigns tasks and reviews results.')}
                      onSelect={() => setCollabMode('structured')}
                    />
                    <RadioRow
                      checked={collabMode === 'free'}
                      label={t('Free mode')}
                      hint={t('All members communicate freely.')}
                      onSelect={() => setCollabMode('free')}
                    />
                  </Field>

                  {/* When a member needs help (escalation routing). The lead is
                      not named here — at creation time the user has not met it
                      yet; Settings uses its name once it exists. */}
                  <Field label={t('When members need help')}>
                    <RadioRow
                      checked={escalationRouting === 'lead'}
                      label={t('Work it out within the team first')}
                      hint={t('Members are asked to clear blockers together before involving you. One can still reach you directly when the decision is clearly yours.')}
                      badge={t('Recommended')}
                      onSelect={() => setEscalationRouting('lead')}
                    />
                    <RadioRow
                      checked={escalationRouting === 'user'}
                      label={t('Notify me directly')}
                      hint={t('Members are asked to bring blockers straight to you.')}
                      onSelect={() => setEscalationRouting('user')}
                    />
                  </Field>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-6">
            <button
              onClick={onClose}
              className="rounded-lg border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-secondary"
            >
              {t('Cancel')}
            </button>
            <button
              onClick={handleCreate}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {isCreating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t('Create')}
            </button>
          </div>
        </div>
      </div>
      {showInlineCreate && (
        <AppInstallDialog
          onClose={() => setShowInlineCreate(false)}
          onInstalled={appId => {
            // Don't close here — the bundle install path keeps the dialog open
            // on a 'partial' result (some skills failed) so the user can see
            // which ones. `onClose` (the dialog's own X / auto-close-on-success)
            // is the only thing that should dismiss it.
            setSelectedAppIds(ids => ids.includes(appId) ? ids : [...ids, appId])
          }}
        />
      )}
    </>,
    document.body
  )
}

// ──────────────────────────────────────────────
// AI proposal confirmation
// ──────────────────────────────────────────────

interface ConfirmProposalDialogProps {
  proposal: ProposedMember[]
  spaceName: string
  creating: boolean
  onBack: () => void
  onConfirm: () => void
}

function ConfirmProposalDialog({ proposal, spaceName, creating, onBack, onConfirm }: ConfirmProposalDialogProps) {
  const { t } = useTranslation()
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4">
      <div className="flex h-[min(36rem,90vh)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl">
        <div className="border-b border-border px-4 py-3 sm:px-6">
          <h2 className="text-base font-medium text-foreground">{t('Confirm the members AI will build')}</h2>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
          <p className="text-sm text-muted-foreground">
            {t('Based on your goal, AI suggests building these {{count}} members:', { count: proposal.length })}
          </p>
          <ul className="space-y-2">
            {proposal.map((m, i) => (
              <li key={`${m.memberName}-${i}`} className="rounded-lg border border-border p-3">
                <p className="text-sm font-medium text-foreground">{m.memberName}</p>
                <p className="mt-1 text-sm text-muted-foreground">{m.responsibility}</p>
              </li>
            ))}
          </ul>
          <ul className="space-y-1 text-xs text-muted-foreground/80">
            <li>{t('The lead and these members will be created in: {{name}}', { name: spaceName })}</li>
            <li>{t('They never run on their own — only when this team runs.')}</li>
            <li>{t('Dissolving the team deletes these digital humans, but the space they worked in stays, along with everything in it.')}</li>
          </ul>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3 sm:px-6">
          <button
            onClick={onBack}
            disabled={creating}
            className="rounded-lg border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
          >
            {t('Back to edit')}
          </button>
          <button
            onClick={onConfirm}
            disabled={creating}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('Confirm and create')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ──────────────────────────────────────────────
// Form primitives
// ──────────────────────────────────────────────

function Field({ label, required, hint, error, children }: {
  label: string
  required?: boolean
  hint?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1 text-sm font-medium text-foreground">
        {label}
        {required && <span className="text-destructive">*</span>}
      </label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

function RadioRow({ checked, label, hint, badge, onSelect }: {
  checked: boolean
  label: string
  hint?: string
  badge?: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex items-start gap-2 text-left"
    >
      <span className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border ${checked ? 'border-primary' : 'border-border'}`}>
        {checked && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm text-foreground">
          {label}
          {badge && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{badge}</span>}
        </span>
        {hint && <span className="mt-0.5 block text-xs text-muted-foreground/70">{hint}</span>}
      </span>
    </button>
  )
}

/**
 * TeamCreateDialog — Create-team form.
 *
 * Captures name, goal and member sourcing (manual default / AI) up front;
 * coordination (free default / managed), lead (auto / pick) and escalation
 * routing (lead default / user) live under a collapsed "Advanced options"
 * section so most users never have to touch them. Wording is kept identical to
 * the team Settings tab so the same concepts read the same everywhere.
 *
 * For AI sourcing, "Create" first calls proposeMembers and shows a confirmation
 * step (cost governance) before teamCreate runs with the confirmed proposal.
 *
 * Validation: name + goal required; manual sourcing requires ≥1 member.
 */

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X, Plus, ChevronDown, ChevronRight } from 'lucide-react'
import type {
  CreateTeamInput,
  MemberSourcing,
  CollabMode,
  EscalationRouting,
  TeamMemberInput,
  ProposedMember,
} from '../../../shared/apps/team-types'
import { AI_MEMBER_HARD_LIMIT } from '../../../shared/apps/team-types'
import type { InstalledApp } from '../../../shared/apps/app-types'
import { useAppsStore } from '../../stores/apps.store'
import { useTeamStore } from '../../stores/team.store'
import { useTranslation } from '../../i18n'
import { SystemPromptEditor } from '../apps/SystemPromptEditor'

interface TeamCreateDialogProps {
  owningSpaceId: string
  onClose: () => void
  onCreated?: (teamId: string) => void
  /** Open the inline "create member" flow (existing digital-human creation). */
  onCreateMemberInline?: () => void
}

export function TeamCreateDialog({ owningSpaceId, onClose, onCreated, onCreateMemberInline }: TeamCreateDialogProps) {
  const { t } = useTranslation()
  const apps = useAppsStore(s => s.apps)
  const teams = useTeamStore(s => s.teams)
  const proposeMembers = useTeamStore(s => s.proposeMembers)
  const createTeam = useTeamStore(s => s.createTeam)
  const isProposing = useTeamStore(s => s.isProposing)
  const isCreating = useTeamStore(s => s.isCreating)

  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [memberSourcing, setMemberSourcing] = useState<MemberSourcing>('manual')
  const [collabMode, setCollabMode] = useState<CollabMode>('free')
  const [escalationRouting, setEscalationRouting] = useState<EscalationRouting>('lead')
  const [leadMode, setLeadMode] = useState<'auto' | 'pick'>('auto')
  const [leadAppId, setLeadAppId] = useState<string | null>(null)
  const [selectedAppIds, setSelectedAppIds] = useState<string[]>([])
  const [submitted, setSubmitted] = useState(false)
  // Advanced options (coordination / lead / escalation) stay collapsed by
  // default — sensible defaults cover most teams, keeping creation low-friction.
  const [showAdvanced, setShowAdvanced] = useState(false)

  // AI-proposal confirmation step
  const [proposal, setProposal] = useState<ProposedMember[] | null>(null)
  const [proposeEmpty, setProposeEmpty] = useState(false)
  // A backend failure only raised a toast, which is gone by the time the user
  // looks back at the dialog — leaving a screen that did not react at all.
  const [proposeFailed, setProposeFailed] = useState(false)

  // Lead apps are an internal coordination role and must never be addable as a
  // member; exclude every team's lead from the pickable set.
  const leadAppIds = useMemo(
    () => new Set(teams.map(tm => tm.leadAppId).filter((id): id is string => !!id)),
    [teams]
  )

  // Automation apps available to add. Show ALL of the user's digital humans
  // (any space) so they can be composed into a team — the owning space only
  // determines where the team record lives, not which humans can join.
  // Excludes uninstalled apps and team leads.
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
  const memberError = submitted && memberSourcing === 'manual' && selectedAppIds.length === 0

  const canSubmit =
    name.trim().length > 0 &&
    goal.trim().length > 0 &&
    (memberSourcing === 'ai' || selectedAppIds.length > 0)

  const addMember = (appId: string) => setSelectedAppIds(ids => [...ids, appId])
  const removeMember = (appId: string) => {
    setSelectedAppIds(ids => ids.filter(id => id !== appId))
    if (leadAppId === appId) setLeadAppId(null)
  }

  const buildInput = (): CreateTeamInput => {
    const members: TeamMemberInput[] | undefined =
      memberSourcing === 'manual' ? selectedAppIds.map(appId => ({ appId })) : undefined
    return {
      name: name.trim(),
      goal: goal.trim(),
      owningSpaceId,
      memberSourcing,
      collabMode,
      escalationRouting,
      members,
      leadAppId: leadMode === 'pick' ? leadAppId : null,
    }
  }

  const finalize = async (confirmedProposal?: ProposedMember[]) => {
    const team = await createTeam(buildInput(), confirmedProposal)
    if (team) {
      onCreated?.(team.id)
      onClose()
    }
  }

  const handleSubmit = async () => {
    setSubmitted(true)
    if (!canSubmit) return

    if (memberSourcing === 'ai') {
      const proposed = await proposeMembers(goal.trim(), owningSpaceId)
      // null = backend error (toast already shown). Empty = AI returned nothing
      // usable; surface inline so the user can refine the goal or switch to
      // manual rather than confirming an empty roster.
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
      return
    }
    await finalize()
  }

  // ── AI proposal confirmation step ──
  if (proposal) {
    return (
      <ConfirmProposalDialog
        proposal={proposal}
        creating={isCreating}
        onBack={() => setProposal(null)}
        onConfirm={() => finalize(proposal)}
      />
    )
  }

  const busy = isProposing || isCreating

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4" onMouseDown={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl"
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3 sm:px-6">
          <h2 className="text-base font-medium text-foreground">{t('New office')}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-secondary hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6">
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
              onChange={setGoal}
              title={t('What this team should get done')}
              placeholder={t('e.g. Every morning, analyze competitors\u2019 activity and send me a brief.')}
              className="bg-background"
            />
          </Field>

          {/* Member sourcing */}
          <Field label={t('Member source')}>
            <RadioRow
              checked={memberSourcing === 'manual'}
              label={t('I will add members (default)')}
              onSelect={() => setMemberSourcing('manual')}
            />
            <RadioRow
              checked={memberSourcing === 'ai'}
              label={t('Let AI build the team from the goal')}
              onSelect={() => setMemberSourcing('ai')}
            />
          </Field>

          {/* Manual member area */}
          {memberSourcing === 'manual' && (
            <div className="space-y-3">
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('Added')}</p>
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
                {memberError && <p className="mt-1 text-xs text-destructive">{t('Add at least one member')}</p>}
              </div>

              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('Available digital humans')}</p>
                {pickableApps.length === 0 ? (
                  <p className="text-sm text-muted-foreground/70">{t('No digital humans available in this space.')}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {pickableApps.map(app => (
                      <button
                        key={app.id}
                        onClick={() => addMember(app.id)}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary"
                      >
                        <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                        {app.spec.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                onClick={onCreateMemberInline}
                className="flex items-center gap-1.5 text-sm text-primary transition-colors hover:underline"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('Create a member inline')}
              </button>
            </div>
          )}

          {/* AI sourcing info */}
          {memberSourcing === 'ai' && (
            <div className="space-y-2">
              <p className="rounded-lg border border-border bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground">
                {t('AI will build the members it needs from your goal (up to {{count}}). After you click Create, it lists the proposed members for your confirmation before anything is created. Each member gets its own subdirectory in the team space and has no schedule by default.', { count: AI_MEMBER_HARD_LIMIT })}
              </p>
              {proposeEmpty && (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
                  {t('The AI could not propose members for this goal. Try describing the goal more concretely, or switch to “I will add members”.')}
                </p>
              )}
              {proposeFailed && (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs leading-relaxed text-destructive">
                  {t('The AI model is unavailable. Check your AI source settings and try again.')}
                </p>
              )}
            </div>
          )}

          {/* Advanced options — collapsed by default to keep creation simple.
              Wording is kept identical to the team Settings tab so the same
              concepts read the same everywhere. */}
          <div className="border-t border-border pt-4">
            <button
              type="button"
              onClick={() => setShowAdvanced(v => !v)}
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
                    hint={t('The AI Lead assigns tasks and reviews results.')}
                    onSelect={() => setCollabMode('structured')}
                  />
                  <RadioRow
                    checked={collabMode === 'free'}
                    label={t('Free mode')}
                    hint={t('All members communicate freely.')}
                    onSelect={() => setCollabMode('free')}
                  />
                </Field>

                {/* Team lead */}
                <Field label={t('Team lead')}>
                  <RadioRow
                    checked={leadMode === 'auto'}
                    label={t('Assign automatically (recommended)')}
                    onSelect={() => { setLeadMode('auto'); setLeadAppId(null) }}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <RadioRow
                      checked={leadMode === 'pick'}
                      label={t('Pick a member')}
                      onSelect={() => setLeadMode('pick')}
                    />
                    {leadMode === 'pick' && (
                      <select
                        value={leadAppId ?? ''}
                        onChange={e => setLeadAppId(e.target.value || null)}
                        disabled={memberSourcing === 'ai' || addedApps.length === 0}
                        className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                      >
                        <option value="">{t('Select a member')}</option>
                        {addedApps.map(app => (
                          <option key={app.id} value={app.id}>{app.spec.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </Field>

                {/* When a member needs help (escalation routing) */}
                <Field label={t('When members need help')}>
                  <RadioRow
                    checked={escalationRouting === 'lead'}
                    label={t('Ask the AI Lead first')}
                    hint={t('Members are asked to bring blockers to the AI Lead before involving you. One can still reach you directly when the decision is clearly yours.')}
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
            onClick={handleSubmit}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('Create')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ──────────────────────────────────────────────
// AI proposal confirmation
// ──────────────────────────────────────────────

interface ConfirmProposalDialogProps {
  proposal: ProposedMember[]
  creating: boolean
  onBack: () => void
  onConfirm: () => void
}

function ConfirmProposalDialog({ proposal, creating, onBack, onConfirm }: ConfirmProposalDialogProps) {
  const { t } = useTranslation()
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl">
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
                {m.role && <p className="text-xs text-muted-foreground">{m.role}</p>}
                <p className="mt-1 text-sm text-muted-foreground">{m.responsibility}</p>
              </li>
            ))}
          </ul>
          <ul className="space-y-1 text-xs text-muted-foreground/80">
            <li>{t('Each is created in its own subdirectory of the team space.')}</li>
            <li>{t('No schedule by default — team-driven only.')}</li>
            <li>{t('These members are cleaned up when the team is dissolved.')}</li>
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

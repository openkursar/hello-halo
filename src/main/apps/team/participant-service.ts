import { randomUUID } from 'crypto'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { CollaborationRefusal, type MessageBus, type SpawnInput } from '@hello-halo/agent-sdk/collaboration'
import { openMemberWorkspace, releaseMemberWorkspace, remapWorkspaceDeniedRoots } from '@hello-halo/agent-sdk/collaboration/workspaces'
import { buildTeamSessionKey, isRemoteMember, parseSpaceCoordinatorAppId, type TeamParticipant, type TeamRequestOrigin, type TeamStopController } from '../../../shared/apps/team-types'
import type { TeamStore } from './types'
import type { RecipientAddress } from './recipient-fences'
import type { ParticipantExecution } from './participants'
import { parseTeamSessionKey } from '../../../shared/apps/im-keys'
import { getWorkMember, listWorkMembers } from './work-members'

export interface CollaborationCaller {
  teamId: string
  epochId: string
  callerAppId: string
  origin?: TeamRequestOrigin
  requestId?: string
}

export type ParticipantSource = Omit<ParticipantExecution, 'prompt' | 'workspace' | 'stopped' | 'requestId'>

interface ParticipantRuntime {
  bus: MessageBus
  discardReports?(epochId: string): void
  stopMemberTurn(input: { teamId: string; epochId: string; appId: string; controller?: TeamStopController; expectedRequestId?: string }): Promise<boolean>
}

export interface ParticipantService {
  recipientFence(target: RecipientAddress): string
  acceptRecipientFence(target: RecipientAddress, fence?: string): boolean
  invalidateRecipientFences(teamId: string, epochId: string): void
  registerSource(conversationId: string): void
  hasSource(conversationId: string): boolean
  beginRequest(conversationId: string, requestId: string): void
  requestAllowed(requestId: string): boolean
  sourceRequestId(conversationId: string): string
  captureSource(conversationId: string, signal?: AbortSignal): () => void
  requestId(caller: CollaborationCaller): string
  adoptRequest(caller: CollaborationCaller, requestId: string, controller?: Omit<TeamStopController, 'requestId'>): string | false
  sourceState(conversationId: string): { requestId?: string; stopped: boolean }
  prepareSourceStop(target: { teamId: string; epochId: string; appId: string }, expectedRequestId: string): { appIds: string[]; isCurrent(appId: string): boolean }
  prepareControlledStop(target: { teamId: string; epochId: string; appId: string }, controller: TeamStopController): { appIds: string[]; isCurrent(appId: string): boolean }
  generation(caller: CollaborationCaller): string
  sourceGeneration(conversationId: string): number
  reportGuard(teamId: string, epochId: string, requestId?: string): () => boolean
  stopSource(conversationId: string): Promise<void>
  capture(caller: CollaborationCaller, signal?: AbortSignal): () => void
  spawn(caller: CollaborationCaller, input: SpawnInput, source: ParticipantSource, signal?: AbortSignal): Promise<TeamParticipant>
  stop(caller: CollaborationCaller, target: string): Promise<Array<{ member: string; stopped: boolean; pending: boolean }>>
  markStopped(caller: CollaborationCaller): void
  continueTarget(caller: CollaborationCaller, targetId: string, requestId?: string): string
  canRead(caller: CollaborationCaller, targetId: string): boolean
}

/** Per-work delegation reuses the authoritative store and runtime mailbox. */
export function createParticipantService(deps: {
  store: TeamStore
  getRuntime(): ParticipantRuntime | null
  onCreated?(participant: TeamParticipant): void | Promise<void>
  maxMembersPerRequest?: number
  identityExists?(id: string): boolean
}): ParticipantService {
  const { store } = deps
  if (deps.identityExists) store.setParticipantIdentityLookup(deps.identityExists)
  const generations = new Map<string, number>()
  const sourceGenerations = new Map<string, number>()
  const reportGenerations = new Map<string, number>()
  const endpoints = new Set<string>()
  const usedSources = new Set<string>()
  const inputs = new Map<string, string>()
  const stopped = new Set<string>()
  const creation = new Map<string, Promise<unknown>>()
  const key = (caller: CollaborationCaller) => buildTeamSessionKey(caller.callerAppId, caller.teamId, caller.epochId)
  const scopeKey = (caller: CollaborationCaller) => `${caller.teamId}:${caller.epochId}`
  const fail = (code: string, message: string, caller: CollaborationCaller): never => {
    throw new CollaborationRefusal(code, message, caller)
  }
  const runtime = () => {
    const value = deps.getRuntime()
    if (!value) throw new CollaborationRefusal('runtime_unavailable', 'Collaboration services are not ready.')
    return value
  }

  function sourceOf(caller: CollaborationCaller): string {
    return store.getTeamById(caller.teamId)?.coordinatorConversationId ?? key(caller)
  }

  function sourceRequestId(conversationId: string): string {
    usedSources.add(conversationId)
    const wanted = inputs.get(conversationId)
    const current = store.requests.current(conversationId)
    const id = wanted ?? current ?? randomUUID()
    if (id !== current) store.requests.begin(conversationId, id)
    if (stopped.has(conversationId)) store.requests.cancel(id)
    return id
  }

  function requestId(caller: CollaborationCaller): string {
    usedSources.add(sourceOf(caller))
    let id = caller.requestId ?? store.participants.getExecution(caller.teamId, caller.epochId, caller.callerAppId)?.requestId
      ?? sourceRequestId(sourceOf(caller))
    const source = sourceOf(caller)
    const current = store.requests.current(key(caller)) ?? (!parseTeamSessionKey(source) ? store.requests.current(source) : null)
    if (current && id.startsWith(`${current}/`)) id = current
    store.requests.inherit(sourceOf(caller), id)
    return id
  }

  function beginRequest(conversationId: string, id: string): void {
    inputs.delete(conversationId)
    inputs.set(conversationId, id)
    if (inputs.size > 1024) inputs.delete(inputs.keys().next().value!)
    stopped.delete(conversationId)
    const parsed = parseTeamSessionKey(conversationId)
    if (parsed) {
      const execution = store.participants.getExecution(parsed.teamId, parsed.epochId, parsed.appId)
      if (execution || store.requests.current(conversationId)) store.requests.begin(conversationId, id)
      if (execution) {
        store.participants.updateExecution(parsed.teamId, parsed.epochId, parsed.appId, { ...execution, requestId: id, stopped: false })
      }
      runtime().bus.continueSession(conversationId)
    }
    {
      const team = store.getCollabTeamByConversation(conversationId)
      if (team?.leadAppId) {
        for (const epoch of store.listOpenEpochs(team.id)) {
          const leadKey = buildTeamSessionKey(team.leadAppId, team.id, epoch.id)
          stopped.delete(leadKey)
          runtime().bus.continueSession(leadKey)
        }
      }
    }
  }

  function captureSource(conversationId: string, signal?: AbortSignal): () => void {
    const observed = sourceGenerations.get(conversationId) ?? 0
    const id = sourceRequestId(conversationId)
    return () => {
      signal?.throwIfAborted()
      if ((sourceGenerations.get(conversationId) ?? 0) !== observed || store.requests.cancelled(id)) {
        throw new CollaborationRefusal('source_stopped', 'The originating request was stopped. No collaborator assignment was dispatched.')
      }
    }
  }

  function capture(caller: CollaborationCaller, signal?: AbortSignal): () => void {
    const id = requestId(caller)
    const observed = generations.get(key(caller)) ?? 0
    const check = () => {
      signal?.throwIfAborted()
      const epoch = store.getEpochById(caller.epochId)
      if (!epoch || epoch.teamId !== caller.teamId || epoch.endedAt !== null || epoch.workItem?.status === 'completed') {
        fail('work_closed', 'This work context is closed. Continue it from its originating conversation.', caller)
      }
      if (!getWorkMember(store, caller.teamId, caller.epochId, caller.callerAppId)) fail('caller_missing', 'The caller is not part of this work.', caller)
      if ((generations.get(key(caller)) ?? 0) !== observed
        || store.requests.cancelled(id) || stopped.has(key(caller))
        || store.participants.getExecution(caller.teamId, caller.epochId, caller.callerAppId)?.stopped) {
        fail('execution_stopped', 'This operation belongs to work that was stopped.', caller)
      }
    }
    check()
    return check
  }

  function controls(caller: CollaborationCaller, targetId: string): boolean {
    if (!caller.origin && store.getTeamById(caller.teamId)?.leadAppId === caller.callerAppId) return true
    if (caller.origin) {
      const execution = store.participants.getExecution(caller.teamId, caller.epochId, targetId)
      if (!execution || execution.origin !== caller.origin) return false
    }
    const seen = new Set<string>()
    let member = store.participants.get(caller.teamId, caller.epochId, targetId)
    while (member && !seen.has(member.appId)) {
      if (member.parentAppId === caller.callerAppId) return true
      seen.add(member.appId)
      member = store.participants.get(caller.teamId, caller.epochId, member.parentAppId)
    }
    return false
  }

  function markStopped(caller: CollaborationCaller, cancelRequest = true): void {
    store.recipientFences.rotate({ teamId: caller.teamId, epochId: caller.epochId, appId: caller.callerAppId })
    generations.set(key(caller), (generations.get(key(caller)) ?? 0) + 1)
    stopped.add(key(caller))
    const execution = store.participants.getExecution(caller.teamId, caller.epochId, caller.callerAppId)
    const id = execution?.requestId ?? store.requests.current(key(caller))
    if (id && cancelRequest) store.requests.cancel(id)
    if (execution && !execution.stopped) store.participants.updateExecution(caller.teamId, caller.epochId, caller.callerAppId, { ...execution, stopped: true })
  }

  async function spawn(caller: CollaborationCaller, input: SpawnInput, source: ParticipantSource, signal?: AbortSignal): Promise<TeamParticipant> {
    const check = capture(caller, signal)
    const owner = getWorkMember(store, caller.teamId, caller.epochId, caller.callerAppId)!
    if (isRemoteMember(owner)) fail('owner_mismatch', 'A collaborator must be created on its caller’s own machine.', caller)
    if (!source.modelSelection.modelSourceId || !source.modelSelection.modelId || !source.engineId) {
      fail('execution_unconfigured', 'The host has not supplied the source execution model and engine.', caller)
    }
    const chainKey = scopeKey(caller)
    const task = (creation.get(chainKey) ?? Promise.resolve()).then(async () => {
      check()
      const parentRequest = requestId(caller)
      if (!store.requests.reserve(parentRequest, deps.maxMembersPerRequest ?? 128)) {
        fail('participant_limit', 'This source request has reached its collaborator creation limit. Continue an existing member with team_send.', caller)
      }
      const memberRequest = `${parentRequest}/${randomUUID()}`
      store.requests.inherit(sourceOf(caller), memberRequest)
      const id = randomUUID()
      if (store.participants.getById(id) || deps.identityExists?.(id)) fail('identity_collision', 'The collaborator identity is already in use. No workspace was created.', caller)
      const name = `${input.name?.trim() || 'collaborator'}-${id.slice(0, 8)}`
      const member: TeamParticipant = {
        teamId: caller.teamId, epochId: caller.epochId, appId: id, parentAppId: caller.callerAppId,
        memberName: name, role: input.name?.trim() || 'Collaborator',
        addedAt: Date.now(), isLead: false, aiProvisioned: false, isTemporary: true,
        ownerNodeId: owner.ownerNodeId, origin: 'local', memberIdentity: owner.memberIdentity, ownerDisplayName: owner.ownerDisplayName,
      }
      const directory = join(source.environment.spacePath, 'collaboration', id)
      const workspace = await openMemberWorkspace({ member: { id, cwd: input.cwd, isolation: input.isolation },
        parentCwd: source.environment.workDir, metadataDirectory: join(directory, 'workspace'), signal: signal ?? new AbortController().signal })
      let inserted = false
      try {
        check()
        await mkdir(directory, { recursive: true })
        check()
        const fileAccess = source.fileAccess ? {
          ...source.fileAccess, cwd: workspace.cwd, memoryWritable: [], memoryReadable: [],
          workspaceRoots: [workspace.cwd],
          closed: remapWorkspaceDeniedRoots(source.fileAccess.closed, workspace),
          memorySystemPaths: remapWorkspaceDeniedRoots(source.fileAccess.memorySystemPaths, workspace),
        } : undefined
        store.participants.insert(member, {
          ...source, requestId: memberRequest, origin: caller.origin ?? source.origin, prompt: input.prompt, workspace, fileAccess,
          environment: { ...source.environment, workDir: workspace.cwd, memoryDir: directory },
        })
        inserted = true
        store.requests.track(buildTeamSessionKey(id, caller.teamId, caller.epochId), memberRequest, { appId: caller.callerAppId, origin: caller.origin })
        await deps.onCreated?.(member)
        check()
        const delivery = await runtime().bus.send({ teamId: caller.teamId, epochId: caller.epochId, fromAppId: caller.callerAppId,
          to: member.appId, message: input.prompt, requestId: memberRequest, ...(caller.origin ? { origin: caller.origin } : {}) })
        if ('delivery' in delivery && delivery.delivery === 'undelivered') throw new Error('The initial assignment was not delivered.')
        return member
      } catch (error) {
        if (!inserted) {
          await releaseMemberWorkspace(workspace)
          await rm(directory, { recursive: true, force: true }).catch(cleanup => console.warn('[TeamParticipants] Cancelled allocation metadata cleanup failed', cleanup))
        } else {
          console.warn(`[TeamParticipants] Allocated participant retained: team=${caller.teamId} epoch=${caller.epochId} app=${id} reason=${error instanceof Error ? error.message : String(error)}`)
          throw new CollaborationRefusal('participant_retained', `Collaborator ${member.memberName} was created with handle ${id}, but dispatch is unconfirmed. Its identity is retained. Read the board and send any further assignment to this same handle; do not repeat spawn_agent.`, caller)
        }
        throw error
      }
    })
    const settled = task.catch(() => {})
    creation.set(chainKey, settled)
    void settled.finally(() => { if (creation.get(chainKey) === settled) creation.delete(chainKey) })
    return task
  }

  function assignmentMatches(caller: CollaborationCaller, targetId: string): boolean {
    const assignment = store.requests.assignment(buildTeamSessionKey(targetId, caller.teamId, caller.epochId))
    if (!assignment?.controller || assignment.controller.appId !== caller.callerAppId) return false
    if (assignment.controller.origin !== caller.origin) return false
    return true
  }

  function prepareAssignmentStop(target: { teamId: string; epochId: string; appId: string }, expectedRequestId: string, controller?: TeamStopController) {
    const caller = { teamId: target.teamId, epochId: target.epochId, callerAppId: controller?.appId ?? target.appId, origin: controller?.origin }
    const targetKey = buildTeamSessionKey(target.appId, target.teamId, target.epochId)
    const assignment = store.requests.assignment(targetKey)
    if (!assignment || assignment.requestId !== expectedRequestId || (controller && (!assignment.controller
      || assignment.controller.appId !== controller.appId || assignment.controller.origin !== controller.origin))) {
      return fail('stop_assignment_changed', 'This assignment is no longer controlled by the requester. The current work was not interrupted.', caller)
    }
    const snapshots = new Map<string, string>()
    const controllers = new Map<string, ReturnType<TeamStore['requests']['assignment']>>()
    snapshots.set(target.appId, assignment.requestId)
    for (const member of store.participants.list(target.teamId, target.epochId)) {
      const current = store.requests.current(buildTeamSessionKey(member.appId, target.teamId, target.epochId))
      if (current?.startsWith(`${assignment.requestId}/`)) snapshots.set(member.appId, current)
    }
    for (const [appId] of snapshots) {
      controllers.set(appId, store.requests.assignment(buildTeamSessionKey(appId, target.teamId, target.epochId)))
      markStopped({ ...caller, callerAppId: appId })
      runtime().bus.cancelSession(buildTeamSessionKey(appId, target.teamId, target.epochId))
    }
    return {
      appIds: [...snapshots.keys()],
      isCurrent(appId: string) {
        const current = store.requests.assignment(buildTeamSessionKey(appId, target.teamId, target.epochId))
        const observed = controllers.get(appId)
        return snapshots.get(appId) === current?.requestId && observed?.controller?.appId === current?.controller?.appId
          && observed?.controller?.origin === current?.controller?.origin
      },
    }
  }

  async function stop(caller: CollaborationCaller, target: string) {
    capture(caller)()
    const members = listWorkMembers(store, caller.teamId, caller.epochId)
    const targets = target === 'all' ? members.filter(member => member.appId !== caller.callerAppId && !parseSpaceCoordinatorAppId(member.appId)
      && controls(caller, member.appId) && assignmentMatches(caller, member.appId))
      : [getWorkMember(store, caller.teamId, caller.epochId, runtime().bus.resolveMemberAppId(caller.teamId, target, caller.epochId))!]
    if (targets.some(member => !member || member.appId === caller.callerAppId || !controls(caller, member.appId) || !assignmentMatches(caller, member.appId))) {
      fail('stop_forbidden', 'You may stop only assignments you currently control. The current owner work was not interrupted.', caller)
    }
    if (targets.some(isRemoteMember)) {
      fail('remote_stop_unsupported', 'Stopping a controlled assignment on another machine is not supported. Ask its owner to stop it; no assignments were changed.', caller)
    }
    const snapshots = targets.map(member => ({ member, controller: { appId: caller.callerAppId,
      requestId: store.requests.assignment(buildTeamSessionKey(member.appId, caller.teamId, caller.epochId))!.requestId,
      origin: caller.origin } }))
    const nestedStops: Promise<void>[] = []
    for (const { member, controller } of snapshots) {
      const memberKey = buildTeamSessionKey(member.appId, caller.teamId, caller.epochId)
      if (store.getCollabTeamByConversation(memberKey)) nestedStops.push(stopSource(memberKey))
      for (const descendant of members) {
        const token = store.requests.current(buildTeamSessionKey(descendant.appId, caller.teamId, caller.epochId))
        if (descendant.appId === member.appId || token?.startsWith(`${controller.requestId}/`)) {
          markStopped({ ...caller, callerAppId: descendant.appId })
          runtime().bus.cancelSession(buildTeamSessionKey(descendant.appId, caller.teamId, caller.epochId))
        }
      }
    }
    const results = await Promise.all(snapshots.map(async ({ member, controller }) => {
      try { return { member: member.appId, stopped: await runtime().stopMemberTurn({ ...caller, appId: member.appId, controller }), pending: false } }
      catch (error) {
        console.warn(`[TeamParticipants] Stop not confirmed: team=${caller.teamId} epoch=${caller.epochId} app=${member.appId}`, error)
        return { member: member.appId, stopped: false, pending: true }
      }
    }))
    await Promise.all(nestedStops)
    return results
  }

  async function stopSource(conversationId: string): Promise<void> {
    if (stopped.has(conversationId)) return
    sourceGenerations.set(conversationId, (sourceGenerations.get(conversationId) ?? 0) + 1)
    const parsed = parseTeamSessionKey(conversationId)
    const privateTeam = store.getCollabTeamByConversation(conversationId)
    const team = parsed ? store.getTeamById(parsed.teamId) : privateTeam
    const executingRequest = store.requests.current(conversationId)
    const ownsRequest = !parsed || inputs.has(conversationId) || !!store.participants.get(parsed.teamId, parsed.epochId, parsed.appId)
    if (ownsRequest && (usedSources.has(conversationId) || executingRequest || team)) {
      store.requests.cancel(sourceRequestId(conversationId))
      store.requests.cancelSource(conversationId)
    }
    for (const requestId of store.sourceBindings.revokeSource(conversationId)) store.requests.cancel(requestId)
    stopped.add(conversationId)
    const scopes = [
      ...(team ? (parsed ? [store.getEpochById(parsed.epochId)].filter((epoch): epoch is NonNullable<typeof epoch> => !!epoch)
        : store.listOpenEpochs(team.id)).map(epoch => ({ team, epoch, appId: parsed?.appId ?? team.leadAppId! })) : []),
      ...(parsed && privateTeam ? store.listOpenEpochs(privateTeam.id).map(epoch => ({ team: privateTeam, epoch, appId: privateTeam.leadAppId! })) : []),
    ]
    for (const { team, epoch, appId } of scopes) {
      const caller = { teamId: team.id, epochId: epoch.id, callerAppId: appId }
      if (caller.callerAppId === team.leadAppId) {
        reportGenerations.set(scopeKey(caller), (reportGenerations.get(scopeKey(caller)) ?? 0) + 1)
        deps.getRuntime()?.discardReports?.(caller.epochId)
      }
      const targets = listWorkMembers(store, team.id, epoch.id).filter(member => member.appId !== caller.callerAppId && controls(caller, member.appId))
        .map(member => ({ member, requestId: store.requests.current(buildTeamSessionKey(member.appId, team.id, epoch.id)) }))
        .filter((target): target is { member: typeof target.member; requestId: string } => !!target.requestId && store.requests.cancelled(target.requestId))
      markStopped(caller, ownsRequest || team.id === privateTeam?.id)
      runtime().bus.cancelSession(key(caller))
      const nestedStops: Promise<void>[] = []
      for (const { member } of targets) {
        const memberKey = buildTeamSessionKey(member.appId, team.id, epoch.id)
        if (store.getCollabTeamByConversation(memberKey)) nestedStops.push(stopSource(memberKey))
        markStopped({ ...caller, callerAppId: member.appId })
        runtime().bus.cancelSession(buildTeamSessionKey(member.appId, team.id, epoch.id))
      }
      await Promise.all([...nestedStops, ...targets.map(async ({ member, requestId }) => {
        try { await runtime().stopMemberTurn({ teamId: team.id, epochId: epoch.id, appId: member.appId, expectedRequestId: requestId }) }
        catch (error) { console.warn(`[TeamParticipants] Source stop not confirmed: team=${team.id} epoch=${epoch.id} app=${member.appId}`, error) }
      })])
    }
  }

  return {
    recipientFence: target => store.recipientFences.read(target),
    acceptRecipientFence: (target, fence) => store.recipientFences.accepts(target, fence),
    invalidateRecipientFences: (teamId, epochId) => store.recipientFences.clearEpoch(teamId, epochId),
    registerSource: conversationId => { endpoints.add(conversationId) },
    hasSource: conversationId => endpoints.has(conversationId),
    capture, spawn, stop, markStopped, beginRequest, requestId, sourceRequestId, captureSource, stopSource,
    requestAllowed: id => !store.requests.cancelled(id),
    sourceGeneration: conversationId => sourceGenerations.get(conversationId) ?? 0,
    generation: caller => `${generations.get(key(caller)) ?? 0}:${sourceGenerations.get(sourceOf(caller)) ?? 0}`,
    prepareControlledStop: (target, controller) => prepareAssignmentStop(target, controller.requestId, controller),
    prepareSourceStop: (target, expectedRequestId) => prepareAssignmentStop(target, expectedRequestId),
    sourceState(conversationId) {
      const id = inputs.get(conversationId) ?? store.requests.current(conversationId)
      return { ...(id ? { requestId: id } : {}), stopped: stopped.has(conversationId) || (!!id && store.requests.cancelled(id)) }
    },
    adoptRequest(caller, id, controller) {
      const execution = store.participants.getExecution(caller.teamId, caller.epochId, caller.callerAppId)
      if (store.requests.cancelled(id)) return false
      if (stopped.has(key(caller)) || execution?.stopped) {
        const assignment = store.requests.assignment(key(caller))
        const controllerCaller = controller ? { ...caller, callerAppId: controller.appId, origin: controller.origin } : undefined
        if (!controllerCaller || !assignment || id === assignment.requestId
          || !assignmentMatches(controllerCaller, caller.callerAppId) || !controls(controllerCaller, caller.callerAppId)) return false
        stopped.delete(key(caller))
        runtime().bus.continueSession(key(caller))
        if (execution) store.participants.updateExecution(caller.teamId, caller.epochId, caller.callerAppId, { ...execution, requestId: id, stopped: false })
      }
      usedSources.add(sourceOf(caller))
      const current = store.requests.current(key(caller)) ?? store.requests.current(sourceOf(caller))
      if (current && (id === current || id.startsWith(`${current}/`))) return current
      const mayAssign = !!controller && controls({ ...caller, callerAppId: controller.appId, origin: controller.origin }, caller.callerAppId)
      if (current && controller && !mayAssign) {
        store.requests.associate(key(caller), id)
        return current
      }
      store.requests.track(key(caller), id, mayAssign ? controller : undefined)
      if (execution) store.participants.updateExecution(caller.teamId, caller.epochId, caller.callerAppId, { ...execution, requestId: id, stopped: false })
      return id
    },
    reportGuard(teamId, epochId, id) {
      const scope = `${teamId}:${epochId}`
      const observed = reportGenerations.get(scope) ?? 0
      const team = store.getTeamById(teamId)
      const source = team?.coordinatorConversationId
      const request = id ?? (source ? store.requests.current(source) : null)
      return () => (reportGenerations.get(scope) ?? 0) === observed && (!source || !stopped.has(source))
        && (!request || !store.requests.cancelled(request))
    },
    canRead: (caller, targetId) => !caller.origin && controls(caller, targetId),
    continueTarget(caller, targetId, proposed) {
      capture(caller)()
      const execution = store.participants.getExecution(caller.teamId, caller.epochId, targetId)
      const targetKey = buildTeamSessionKey(targetId, caller.teamId, caller.epochId)
      const team = store.getTeamById(caller.teamId)
      const assignmentKey = team?.leadAppId === targetId && team.coordinatorConversationId ? team.coordinatorConversationId : targetKey
      const previous = execution?.requestId ?? store.requests.current(assignmentKey)
      const parent = requestId(caller)
      const assignment = store.requests.assignment(assignmentKey)
      const wasStopped = !!execution?.stopped || stopped.has(targetKey) || (!!previous && store.requests.cancelled(previous))
      const needsNew = !previous || wasStopped || assignment?.controller?.appId !== caller.callerAppId
        || previous.split('/')[0] !== parent.split('/')[0]
      const controlled = controls(caller, targetId)
      if ((execution?.stopped || stopped.has(targetKey) || (previous && store.requests.cancelled(previous))) && (!controlled || !assignmentMatches(caller, targetId))) {
        fail('target_stopped', 'This collaborator needs a new assignment from its controller.', caller)
      }
      if (!controlled) {
        const id = `${parent}/${randomUUID()}`
        store.requests.associate(targetKey, id)
        return id
      }
      const id = proposed ?? (needsNew ? `${parent}/${randomUUID()}` : previous!)
      if (store.requests.cancelled(id)) fail('request_stopped', 'This assignment belongs to a cancelled request.', caller)
      if (wasStopped) {
        store.requests.track(targetKey, id, { appId: caller.callerAppId, origin: caller.origin })
        if (execution) store.participants.updateExecution(caller.teamId, caller.epochId, targetId, { ...execution, requestId: id, stopped: false })
        stopped.delete(targetKey)
        runtime().bus.continueSession(targetKey)
      } else if (isRemoteMember(getWorkMember(store, caller.teamId, caller.epochId, targetId)!)) {
        store.requests.track(targetKey, id, { appId: caller.callerAppId, origin: caller.origin })
      } else store.requests.associate(targetKey, id)
      return id
    },
  }
}

import { randomUUID } from 'node:crypto';
import { BoardPages } from './board-pages.js';
import { createMessageBus, type MessageBus, type TeamDelivery, type TurnCompletion } from './message-bus.js';
import { createBlackboardWriter, type BlackboardWriteStore } from './board-writes.js';
import { CollaborationRefusal } from './errors.js';
import { collaborationText, createCollaborationServer } from './tools.js';
import { buildTeamSessionKey, spaceCoordinatorAppId, TEAM_LEAD_ADDRESS, teamMemberAddress, type TeamEnvelope, type TeamRequestOrigin, type TeamTriggerContext } from './protocol.js';
import type { BlackboardTask, BlackboardFinding, TeamActivity } from './records.js';
import type { CollaborationOperations, CollaborationServer, SpawnInput } from './types.js';

export interface CollaborationMember {
  id: string;
  name: string;
  parentId: string;
  prompt: string;
  cwd?: string;
  isolation?: 'worktree';
  origin?: TeamRequestOrigin;
  createdAt: number;
  state?: 'idle' | 'queued' | 'running' | 'stopped' | 'error';
  /** Set by an execution host, never by the model-facing spawn input. */
  model?: string;
  /** Resolved by the host; retained so a caller can locate isolated work. */
  workingDirectory?: string;
  worktreePath?: string;
}

export interface MemberExecutionRequest {
  member: CollaborationMember;
  deliveries: readonly TeamDelivery[];
  signal: AbortSignal;
  server: CollaborationServer;
  ready(): void;
}

/** Execution and history remain the host's responsibility, never another model loop. */
export interface CollaborationExecutor {
  execute(request: MemberExecutionRequest): Promise<TurnCompletion>;
  inject(memberId: string, deliveries: readonly TeamDelivery[]): boolean;
  interrupt(memberId: string): Promise<boolean>;
  release(memberId: string): Promise<void>;
  readMember(memberId: string, before?: number): Promise<string>;
  readArtifact(ref: string, requesterId: string): Promise<string>;
  validateArtifact(ref: string, producerId: string): Promise<string>;
}

export interface CollaborationScopeStore extends BlackboardWriteStore {
  readonly teamId: string;
  readonly epochId: string;
  getMember(id: string): CollaborationMember | undefined;
  findMember(name: string): CollaborationMember | undefined;
  members(): readonly CollaborationMember[];
  addMember(member: CollaborationMember): void;
  removeMember(id: string): void;
  tasks(): readonly BlackboardTask[];
  findings(): readonly BlackboardFinding[];
  activities(): readonly TeamActivity[];
  /** Persist all accepted mutations before a tool reports success. */
  flush(): Promise<void>;
}

export interface CollaborationRuntimeOptions {
  store: CollaborationScopeStore;
  executor: CollaborationExecutor;
  /** Delivers to the source conversation, which owns its own admission and execution. */
  deliverToSource(envelope: TeamEnvelope, trigger: TeamTriggerContext): Promise<'dispatched' | 'mid_turn' | 'buffered'>;
  maxConcurrentTurns: number;
  /** New collaborators admitted for one source request, including all nested delegation. */
  maxMembers: number;
  idleTimeoutMs?: number;
  origin?: TeamRequestOrigin;
  onChange?: () => void;
}

interface ActiveExecution {
  controller: AbortController;
  trigger: TeamTriggerContext;
  done: Promise<void>;
  state: 'queued' | 'running';
}

interface Permit {
  signal: AbortSignal;
  resolve(): void;
  reject(error: Error): void;
  abort(): void;
}

/** A host-owned collaboration, shared by every member, including further delegation. */
export class CollaborationRuntime {
  readonly coordinatorId: string;
  readonly bus: MessageBus;
  private readonly boardPages = new BoardPages();
  private readonly board: ReturnType<typeof createBlackboardWriter>;
  private readonly active = new Map<string, ActiveExecution>();
  private readonly executions = new Set<ActiveExecution>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly resident = new Set<string>();
  private readonly allocating = new Set<string>();
  private readonly permits: Permit[] = [];
  private readonly changeListeners = new Set<() => void>();
  private readonly stopVersions = new Map<string, number>();
  private readonly unsubscribeBreach: () => void;
  private running = 0;
  private revisionValue = 0;
  private closed = false;
  private stopVersion = 0;
  private createdForRequest = 0;
  private creation: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: CollaborationRuntimeOptions) {
    for (const [name, value] of Object.entries({ maxConcurrentTurns: options.maxConcurrentTurns, maxMembers: options.maxMembers })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
    }
    if (options.idleTimeoutMs !== undefined && (!Number.isFinite(options.idleTimeoutMs) || options.idleTimeoutMs < 1)) {
      throw new TypeError('idleTimeoutMs must be positive');
    }
    const { store } = options;
    this.coordinatorId = spaceCoordinatorAppId(store.epochId);
    const root = { appId: this.coordinatorId, memberName: TEAM_LEAD_ADDRESS, origin: 'local' as const };
    const memberView = (member: CollaborationMember) => ({ appId: member.id, memberName: member.name, origin: 'local' as const });
    this.board = createBlackboardWriter({ store, onChange: () => this.changed() });
    this.bus = createMessageBus({
      store: {
        getMember: (team, id) => team !== store.teamId || this.allocating.has(id) ? null : id === root.appId ? root : store.getMember(id) ? memberView(store.getMember(id)!) : null,
        getMemberByName: (team, name) => {
          if (team !== store.teamId) return null;
          if (name === root.memberName) return root;
          const member = store.findMember(name);
          return member && !this.allocating.has(member.id) ? memberView(member) : null;
        },
        listMembersByTeam: team => team === store.teamId ? [root, ...store.members().filter(member => !this.allocating.has(member.id)).map(memberView)] : [],
        isEdgeAllowed: team => team === store.teamId,
        getTeamById: team => team === store.teamId && !this.closed ? { leadAppId: root.appId } : null,
        getEpochById: epoch => epoch === store.epochId ? { endedAt: this.closed ? Date.now() : null } : null,
      },
      hooks: {
        isBusy: key => this.active.has(this.memberId(key)),
        getTurnIdentity: key => this.active.get(this.memberId(key))?.trigger.origin ?? 'owner',
        wakeTarget: async request => {
          const member = this.requireMember(request.appId);
          this.start(member, request.deliveries ?? [{ envelope: request.envelope, trigger: request.trigger }]);
        },
        deliverMidTurn: request => {
          const execution = this.active.get(request.appId);
          if (!execution || execution.state !== 'running' || execution.controller.signal.aborted) return false;
          return this.options.executor.inject(request.appId, request.deliveries ?? [{ envelope: request.envelope, trigger: request.trigger }]);
        },
        deliverToCoordinator: request => this.options.deliverToSource(request.envelope, request.trigger),
      },
      recordActivity: input => { this.board.postActivity(input); },
    });
    this.unsubscribeBreach = this.bus.onBreach(() => {
      void this.stop(this.coordinatorId, 'all').catch(error => console.error('[Collaboration] Circuit stop failed', error));
    });
  }

  get activeCount(): number { return this.executions.size; }
  get revision(): number { return this.revisionValue; }

  beginRequest(): boolean {
    this.requireOpen();
    if (this.executions.size > 0) return false;
    this.createdForRequest = 0;
    this.bus.resetCircuit(this.options.store.epochId);
    return true;
  }

  private memberId(key: string): string { return key.split(':')[1] ?? ''; }
  private key(id: string): string { return buildTeamSessionKey(id, this.options.store.teamId, this.options.store.epochId); }
  private requireOpen(): void {
    if (this.closed) throw new CollaborationRefusal('closed', 'This collaboration host has closed.');
  }
  private requireMember(id: string): CollaborationMember {
    const member = this.options.store.getMember(id);
    if (!member || this.allocating.has(id)) throw new CollaborationRefusal('member_missing', 'The collaborator is not available in this work context.');
    return member;
  }
  private requireCaller(id: string): void {
    this.requireOpen();
    if (id !== this.coordinatorId) this.requireMember(id);
    if (this.isStopped(id)) throw new CollaborationRefusal('caller_stopped', 'This execution was stopped and cannot dispatch new work.');
  }
  private admission(id: string, signal?: AbortSignal): () => void {
    const scopeVersion = this.stopVersion;
    const memberVersion = this.stopVersions.get(id) ?? 0;
    const check = () => {
      signal?.throwIfAborted();
      this.requireCaller(id);
      if (scopeVersion !== this.stopVersion || memberVersion !== (this.stopVersions.get(id) ?? 0)) {
        throw new CollaborationRefusal('execution_replaced', 'This operation belongs to work that was stopped.');
      }
    };
    check();
    return check;
  }
  private isStopped(id: string): boolean { return this.options.store.getMember(id)?.state === 'stopped'; }
  private setState(id: string, state: CollaborationMember['state']): void {
    const member = this.options.store.getMember(id);
    if (member) this.options.store.addMember({ ...member, state });
  }
  private origin(id: string): TeamRequestOrigin | undefined {
    return id === this.coordinatorId ? this.options.origin : this.active.get(id)?.trigger.origin ?? this.requireMember(id).origin;
  }
  private changed(): void {
    this.revisionValue++;
    for (const listener of [...this.changeListeners]) listener();
    try { this.options.onChange?.(); } catch (error) { console.error('[Collaboration] State observer failed', error); }
  }

  waitForChange(after: number, signal?: AbortSignal): Promise<void> {
    if (after !== this.revisionValue || this.closed || signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => {
        this.changeListeners.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      this.changeListeners.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.running < this.options.maxConcurrentTurns) { this.running++; return; }
    await new Promise<void>((resolve, reject) => {
      const permit: Permit = {
        signal, resolve: () => { signal.removeEventListener('abort', permit.abort); resolve(); },
        reject: error => { signal.removeEventListener('abort', permit.abort); reject(error); },
        abort: () => {
          const index = this.permits.indexOf(permit);
          if (index !== -1) this.permits.splice(index, 1);
          permit.reject(new Error('Queued collaboration execution was cancelled.'));
        },
      };
      this.permits.push(permit);
      signal.addEventListener('abort', permit.abort, { once: true });
    });
  }
  private releasePermit(): void {
    const next = this.permits.shift();
    if (next) next.resolve();
    else this.running--;
  }

  private start(member: CollaborationMember, deliveries: readonly TeamDelivery[]): void {
    this.requireOpen();
    if (this.active.has(member.id)) throw new Error('A collaborator already owns a running turn.');
    clearTimeout(this.idleTimers.get(member.id));
    this.idleTimers.delete(member.id);
    const controller = new AbortController();
    const trigger = deliveries[0].trigger;
    const execution: ActiveExecution = { controller, trigger, state: 'queued', done: Promise.resolve() };
    this.active.set(member.id, execution);
    this.executions.add(execution);
    this.resident.add(member.id);
    this.setState(member.id, 'queued');
    execution.done = (async () => {
      let acquired = false;
      let outcome: TurnCompletion = { kind: 'error', message: 'Execution did not start.' };
      try {
        await this.acquire(controller.signal);
        acquired = true;
        await this.retiring.get(member.id);
        controller.signal.throwIfAborted();
        this.setState(member.id, 'running');
        await this.options.store.flush();
        controller.signal.throwIfAborted();
        outcome = await this.options.executor.execute({
          member, deliveries, signal: controller.signal, server: this.serverFor(member.id),
          ready: () => {
            if (controller.signal.aborted || this.active.get(member.id) !== execution) return;
            execution.state = 'running';
            this.bus.notifySessionReady(this.key(member.id));
            this.changed();
          },
        });
      } catch (error) {
        const stopped = controller.signal.aborted;
        outcome = { kind: 'error', message: stopped ? 'Execution was stopped.' : 'Collaborator execution failed.' };
        if (!stopped) console.error(`[Collaboration] Member execution failed: member=${member.id}`, error);
      } finally {
        if (acquired) this.releasePermit();
        if (this.active.get(member.id) === execution) this.active.delete(member.id);
        if (!this.isStopped(member.id)) this.setState(member.id, outcome.kind === 'error' ? 'error' : 'idle');
        this.bus.completeTurn({ sessionKey: this.key(member.id), trigger, outcome, sealPending: this.closed || this.isStopped(member.id) });
        if (!this.closed && !this.isStopped(member.id) && !controller.signal.aborted) {
          try {
            const placement = this.options.store.getMember(member.id);
            const workspace = placement?.workingDirectory || placement?.worktreePath
              ? `\nWorkspace: ${JSON.stringify({ cwd: placement.workingDirectory, worktree: placement.worktreePath })}` : '';
            const detail = (outcome.kind === 'result' ? outcome.content.slice(0, 4000) : outcome.kind) + workspace;
            const envelope: TeamEnvelope = {
              id: randomUUID(), teamId: this.options.store.teamId, epochId: this.options.store.epochId,
              fromAppId: null, toAppId: this.coordinatorId, correlationId: trigger.correlationId,
              createdAt: Date.now(), body: `[System] ${member.name}'s turn ended (${outcome.kind}). This is an execution fact, not a completion claim or a delivered reply.\n${detail}`,
            };
            await this.options.deliverToSource(envelope, { ...trigger, fromAppId: null, kind: 'member_stopped', wait: false });
          } catch (error) { console.warn(`[Collaboration] End notice could not reach source: member=${member.id}`, error); }
        }
        await this.options.store.flush().catch(error => console.error('[Collaboration] Record flush failed after turn', error));
        this.armIdle(member.id);
        this.changed();
      }
    })().catch(error => {
      console.error(`[Collaboration] Execution settlement failed: member=${member.id}`, error);
    }).finally(() => {
      this.executions.delete(execution);
      this.changed();
    });
    this.changed();
  }

  private armIdle(id: string): void {
    if (this.closed || this.active.has(id) || this.bus.isSessionOccupied(this.key(id))) return;
    clearTimeout(this.idleTimers.get(id));
    const timer = setTimeout(() => {
      this.idleTimers.delete(id);
      if (this.closed || this.active.has(id) || this.bus.isSessionOccupied(this.key(id))) return;
      const closing = this.options.executor.release(id).catch(error => {
        console.warn(`[Collaboration] Idle resource release failed: member=${id}`, error);
      }).finally(() => {
        if (this.retiring.get(id) === closing) this.retiring.delete(id);
        if (!this.active.has(id)) this.resident.delete(id);
      });
      this.retiring.set(id, closing);
    }, this.options.idleTimeoutMs ?? 120_000);
    timer.unref?.();
    this.idleTimers.set(id, timer);
  }

  async spawn(callerId: string, input: SpawnInput, signal?: AbortSignal): Promise<string> {
    const admitted = this.admission(callerId, signal);
    const operation = this.creation.then(async () => {
      admitted();
      const { store } = this.options;
      if (this.createdForRequest >= this.options.maxMembers) throw new CollaborationRefusal('member_limit', 'This request has reached its collaborator creation limit. Reuse an existing collaborator.');
      const base = input.name?.trim() || 'collaborator';
      if (base === 'all' || base === TEAM_LEAD_ADDRESS) throw new CollaborationRefusal('reserved_name', 'Choose a collaborator name other than all or lead.');
      let name = base;
      for (let suffix = 2; name === this.coordinatorId || store.findMember(name) || store.getMember(name); suffix++) name = `${base}-${suffix}`;
      const member: CollaborationMember = {
        id: randomUUID(), name, parentId: callerId, prompt: input.prompt,
        ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.isolation ? { isolation: input.isolation } : {}),
        origin: this.origin(callerId), createdAt: Date.now(), state: 'queued',
      };
      this.allocating.add(member.id);
      try {
        store.addMember(member);
        await store.flush();
        admitted();
        this.createdForRequest++;
      } catch (error) {
        store.removeMember(member.id);
        await store.flush().catch(rollbackError => console.error('[Collaboration] Member allocation rollback could not be persisted', rollbackError));
        throw error;
      } finally { this.allocating.delete(member.id); }
      await this.send(callerId, member.name, input.prompt, signal);
      return member.name;
    });
    this.creation = operation.catch(() => {});
    return operation;
  }

  async send(callerId: string, to: string, message: string, signal?: AbortSignal): Promise<string> {
    const admitted = this.admission(callerId, signal);
    const targetId = this.bus.resolveMemberAppId(this.options.store.teamId, to, this.options.store.epochId);
    const target = targetId === this.coordinatorId ? undefined : this.requireMember(targetId);
    if (target && this.isStopped(target.id)) {
      if (callerId !== this.coordinatorId && callerId !== target.parentId) {
        throw new CollaborationRefusal('target_stopped', 'The collaborator was stopped. Its controller must explicitly continue it.');
      }
      this.setState(target.id, 'idle');
      await this.options.store.flush();
    }
    admitted();
    if (target && (callerId === this.coordinatorId || callerId === target.parentId)) this.bus.continueSession(this.key(target.id));
    const result = await this.bus.send({
      teamId: this.options.store.teamId, epochId: this.options.store.epochId,
      fromAppId: callerId, to: targetId, message, origin: this.origin(callerId),
      forwardDepth: this.active.get(callerId)?.trigger.forwardDepth ?? 0,
    });
    await this.options.store.flush();
    this.changed();
    return JSON.stringify(result);
  }

  async stop(callerId: string, to: string): Promise<string> {
    this.requireCaller(callerId);
    const { store } = this.options;
    const targets = to === 'all' ? store.members() : [store.findMember(to) ?? this.requireMember(to)];
    if (targets.some(member => member.id === callerId)) throw new CollaborationRefusal('stop_self', 'End your own turn instead of interrupting the tool call you are executing.');
    if (callerId !== this.coordinatorId && targets.some(member => member.id !== callerId && member.parentId !== callerId)) {
      throw new CollaborationRefusal('stop_forbidden', 'You may stop only yourself or collaborators you created.');
    }
    const results: Array<{ member: string; stopped: boolean; pending: boolean }> = [];
    if (to === 'all') this.stopVersion++;
    for (const member of targets) {
      this.stopVersions.set(member.id, (this.stopVersions.get(member.id) ?? 0) + 1);
      this.setState(member.id, 'stopped');
      this.bus.cancelSession(this.key(member.id));
      this.active.get(member.id)?.controller.abort();
    }
    for (const member of targets) {
      const execution = this.active.get(member.id);
      const stopped = await this.options.executor.interrupt(member.id);
      results.push({ member: member.name, stopped, pending: !!execution && !stopped });
    }
    await store.flush();
    this.changed();
    return JSON.stringify(results);
  }

  serverFor(callerId = this.coordinatorId): CollaborationServer {
    const { store } = this.options;
    const operations: CollaborationOperations = {
      spawn_agent: async (input, context) => collaborationText(`Collaborator created: ${await this.spawn(callerId, input, context.signal)}. The assignment was accepted; replies arrive asynchronously.`),
      team_send: async (input, context) => collaborationText(await this.send(callerId, input.to, input.message, context.signal)),
      team_stop: async input => collaborationText(await this.stop(callerId, input.to)),
      team_read_board: async input => {
        this.requireCaller(callerId);
        const key = JSON.stringify([this.revisionValue, callerId, input.mine, input.status]);
        return collaborationText(this.boardPages.preview(key, () => ({
          members: [{ name: TEAM_LEAD_ADDRESS, to: TEAM_LEAD_ADDRESS }, ...store.members().filter(member => !this.allocating.has(member.id)).map(member => ({ name: member.name, to: teamMemberAddress({ appId: member.id, memberName: member.name }), cwd: member.workingDirectory, worktree: member.worktreePath, state: this.active.get(member.id)?.state ?? (member.state === 'running' || member.state === 'queued' ? 'interrupted' : member.state ?? 'idle') }))],
          tasks: store.tasks().filter(task => (!input.mine || task.assigneeAppId === callerId) && (!input.status || task.status === input.status)),
          findings: store.findings(), activities: store.activities(),
        })));
      },
      team_read_member: async input => {
        this.requireCaller(callerId);
        const member = store.findMember(input.member) ?? this.requireMember(input.member);
        if (callerId !== this.coordinatorId && member.parentId !== callerId) throw new CollaborationRefusal('record_forbidden', 'This member record is not available to you.');
        return collaborationText(await this.options.executor.readMember(member.id, input.before));
      },
      team_read_artifact: async input => {
        this.requireCaller(callerId);
        try {
          const archive = this.boardPages.read(input.ref);
          if (archive !== undefined) return collaborationText(archive);
        } catch (error) {
          throw new CollaborationRefusal('board_archive_unavailable', error instanceof Error ? error.message : 'The board archive is unavailable.');
        }
        return collaborationText(await this.options.executor.readArtifact(input.ref, callerId));
      },
      team_post_finding: async (input, context) => {
        const admitted = this.admission(callerId, context.signal);
        const ref = input.ref ? await this.options.executor.validateArtifact(input.ref, callerId) : undefined;
        admitted();
        const result = this.board.postFinding({ teamId: store.teamId, epochId: store.epochId, callerAppId: callerId, content: input.content, ref });
        await store.flush();
        return collaborationText(JSON.stringify(result));
      },
      team_post_task: async input => {
        this.requireCaller(callerId);
        const assignee = store.findMember(input.assignee) ?? this.requireMember(input.assignee);
        const result = this.board.postTask({ ...input, teamId: store.teamId, epochId: store.epochId, callerAppId: callerId, assigneeAppId: assignee.id });
        await store.flush();
        return collaborationText(JSON.stringify(result));
      },
      team_update_task: async (input, context) => {
        const admitted = this.admission(callerId, context.signal);
        const task = store.getTaskById(input.taskId);
        if (!task || (callerId !== this.coordinatorId && task.assigneeAppId !== callerId)) throw new CollaborationRefusal('task_forbidden', 'You may update only your own task.');
        const resultRef = input.resultRef ? await this.options.executor.validateArtifact(input.resultRef, task.assigneeAppId ?? callerId) : undefined;
        admitted();
        this.board.updateTask({ ...input, resultRef, teamId: store.teamId, epochId: store.epochId, callerAppId: callerId });
        await store.flush();
        return collaborationText('Task updated.');
      },
    };
    return createCollaborationServer(operations);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.boardPages.clear();
    this.unsubscribeBreach();
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    for (const execution of this.active.values()) execution.controller.abort();
    const results = await Promise.allSettled([...this.active.keys()].map(id => this.options.executor.interrupt(id)));
    results.forEach(result => { if (result.status === 'rejected') console.error('[Collaboration] Shutdown interrupt failed', result.reason); });
    await this.creation.catch(() => {});
    await Promise.all([...this.executions].map(execution => execution.done));
    this.bus.resetEpoch(this.options.store.epochId);
    await Promise.all(this.retiring.values());
    const released = await Promise.allSettled([...this.resident].map(id => this.options.executor.release(id)));
    this.resident.clear();
    released.forEach(result => { if (result.status === 'rejected') console.error('[Collaboration] Shutdown release failed', result.reason); });
    try { await this.options.store.flush(); } finally { this.changed(); }
  }
}

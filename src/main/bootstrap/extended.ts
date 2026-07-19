/**
 * Extended Services - Deferred Loading
 *
 * These services are loaded AFTER the window is visible.
 * They use lazy initialization - actual initialization happens on first use.
 *
 * GUIDELINES:
 *   - DEFAULT location for all new features
 *   - Services here do NOT block startup
 *   - Use lazy initialization pattern for heavy modules
 *
 * CURRENT SERVICES:
 *   - Background: Process keep-alive, system tray, daemon browser (automation infra)
 *   - Onboarding: First-time user guide (only needed once)
 *   - Remote: Remote access feature (optional)
 *   - Browser: Embedded browser for Content Canvas (V2 feature)
 *   - AIBrowser: AI browser automation tools (self-initializing via MCP server)
 *   - Overlay: Floating UI elements (optional)
 *   - Search: Global search (optional)
 *   - Performance: Developer monitoring tools (dev only)
 *   - GitBash: Windows Git Bash setup (Windows optional)
 *   - Platform: Store, Scheduler, Memory (automation infrastructure)
 *   - Apps: AppManager, AppRuntime (automation App lifecycle + event routing)
 */

import { registerOnboardingHandlers } from '../ipc/onboarding'
import { registerRemoteHandlers } from '../ipc/remote'
import { powerMonitor } from 'electron'
import { registerSecurityHandlers } from '../ipc/security'
import { enableRemoteAccess } from '../services/remote.service'
import { getConfig, getFederationGatewayUrl, migrateCredentialEncryption } from '../foundation/config.service'
import { registerBrowserHandlers } from '../ipc/browser'
import { registerBrowserPolicyHandlers } from '../ipc/browser-policy'
import { cleanupAIBrowser } from '../services/ai-browser'
import { registerOverlayHandlers, cleanupOverlayHandlers } from '../ipc/overlay'
import { initializeSearchHandlers, cleanupSearchHandlers } from '../ipc/search'
import { registerPerfHandlers } from '../ipc/perf'
import { registerGitBashHandlers, initializeGitBashOnStartup } from '../ipc/git-bash'
import { cleanupAllCaches } from '../services/artifact-cache.service'
import { flushSpaceActivity } from '../services/space.service'
import { disposeSearchContext } from '../services/web-search'
import { markExtendedServicesReady } from './state'
import { getMainWindow, sendToRenderer } from '../foundation/window.service'
import { initializeHealthSystem, setSessionCleanupFn } from '../services/health'
import { closeAllV2Sessions, activeSessions } from '../services/agent/session-manager'
import { registerHealthHandlers } from '../ipc/health'
import { initBackground, shutdownBackground, getBackgroundService, setDaemonStealthInjector } from '../platform/background'
import { injectStealthScripts } from '../services/stealth'
import { initStore, shutdownStore } from '../platform/store'
import type { DatabaseManager } from '../platform/store'
import { initScheduler, shutdownScheduler } from '../platform/scheduler'
import { initMemory } from '../platform/memory'
import { setMemorySdk } from '../platform/memory/sdk'
import { tool as sdkTool, createSdkMcpServer as sdkCreateMcpServer } from '../services/agent/resolved-sdk'
import { initAppManager, shutdownAppManager } from '../apps/manager'
import { initAppRuntime, shutdownAppRuntime, getEventRouter } from '../apps/runtime'
import { initTeamStore, shutdownTeamStore, getTeamStore, initTeamService, shutdownTeamService, getTeamService } from '../apps/team'
import type { TeamStore } from '../apps/team'
import { initFederationStore, shutdownFederationStore, getFederationStore, getAuthorityStore } from '../apps/federation'
import { recoverPersistedOffices } from './office-recovery'
import { initIdentity, getLocalIdentity, getLocalPublicKeyPem, signWithLocalKey } from '../http/identity'
import { verifyOfficeCredential } from '../http/auth'
import { setFederationInbound, sendFederationFrameToClient, listOfficeClientIds, broadcastToAll, getSessionIdentity } from '../http/websocket'
import { createFederationManager, setFederationManager, getFederationManager, makeLocationAwareSessionDeps, withOwnerResolvedSpace, createRelayCapture, createLocationAwareBlackboard, WsFederationClient, classifyArtifactFetchFailure } from '../apps/runtime/federation'
import { getRemoteAccessStatus } from '../services/remote.service'
import type { OwnerStatus, MemberWriteRecord, ArtifactRef } from '../apps/runtime/federation'
import { SELF_NODE_ID, TEAM_EVENTS, buildTeamSessionKey } from '../../shared/apps/team-types'
import type { BlackboardTask, BlackboardFinding, TaskStatus, TeamUpdatedEvent } from '../../shared/apps/team-types'
import { parseTeamSessionKey } from '../../shared/apps/im-keys'
import { createTeamRuntime, setActiveTeamRuntime, getActiveTeamRuntime, createTeamTriggerScheduler, createDefaultSessionDeps, createTeamArtifactReader, createLocalArtifactResolver, RemoteArtifactError } from '../apps/runtime/team'
import { readTeamMemberMessages } from '../apps/runtime/app-chat'
import type { TeamTriggerScheduler } from '../apps/runtime/team'
import { createSpace, deleteSpace, getSpace } from '../services/space.service'
import { listArtifacts } from '../services/artifact.service'
import { installAppsSubscribers } from '../services/analytics/subscribers/apps.subscriber'
import { runStartupSnapshot } from '../services/analytics/snapshot'
import { analytics } from '../services/analytics/analytics.service'
import { registerAppHandlers } from '../ipc/app'
import { registerTeamIpc } from '../ipc/team'
import { registerAnalyticsHandlers } from '../ipc/analytics'
import { registerNotificationChannelHandlers } from '../ipc/notification-channels'
import { registerWecomBotHandlers } from '../ipc/wecom-bot'
import { registerImChannelHandlers } from '../ipc/im-channels'
import { registerImSessionHandlers } from '../ipc/im-sessions'
import { registerStoreHandlers } from '../ipc/store'
import { registerCliConfigHandlers } from '../ipc/cli-config'
import { registerModelCapabilitiesHandlers } from '../ipc/model-capabilities'
import { registerWeixinIlinkHandlers } from '../ipc/weixin-ilink'
import { initRegistryService, shutdownRegistryService } from '../store'
import { startUpgradeScheduler, stopUpgradeScheduler } from '../store/upgrade.service'
import { cleanupImChannelTempFiles } from '../apps/runtime/im-channels'
import { registerIdleTask, startIdleDrain } from './idle-queue'
import { seedDefaultAppIfNeeded } from '../apps/manager/seed'
import { loadBuiltinApps } from '../apps/manager/builtin-loader'

// Module-level reference to db for cleanup
let platformDb: DatabaseManager | null = null
// relayCapture.start() returns an IDisposable (agent-event subscription), not
// a bare function — dispose() it on shutdown.
let disposeRelayCapture: { dispose(): void } | null = null
let flushRelayCapture: (() => void) | null = null
let onSystemResume: (() => void) | null = null

/**
 * Initialize platform (store, scheduler, memory) and apps
 * (manager, runtime) modules. Runs asynchronously after extended services
 * are registered, so it does not block startup or the UI.
 *
 * Initialization order:
 *   Phase 0: initStore()
 *   Phase 1 (parallel): initScheduler, initMemory
 *   Phase 2: initAppManager
 *   Phase 3: initAppRuntime  (creates EventRouter, wires sources, starts everything)
 *
 * scheduler.start() is called after all sources are registered,
 * ensuring no events are missed. The EventRouter is started internally
 * by initAppRuntime().
 */
async function initPlatformAndApps(): Promise<void> {
  console.log('[Bootstrap] Platform+Apps initialization starting...')
  const t0 = performance.now()

  // ── Pre-init: Background cleanup (non-blocking) ─────────────────────────
  // Remove stale IM channel media temp files from previous sessions (>24h old).
  cleanupImChannelTempFiles()

  // ── Phase 0: Store ──────────────────────────────────────────────────────
  // Note: SDK is initialized earlier in index.ts (before essential services)
  const db = await initStore()
  platformDb = db

  // ── Phase 1: Platform services (parallel) ───────────────────────────────
  const [scheduler, memory] = await Promise.all([
    initScheduler({ db }),
    initMemory(),
  ])

  // Inject the resolved agent-SDK MCP primitives into the memory tier, so
  // platform/memory builds its MCP server without importing the services
  // tier. The SDK is already initialized (see index.ts) and these refs are
  // only invoked later, when a session's memory MCP server is built.
  setMemorySdk({ tool: sdkTool, createSdkMcpServer: sdkCreateMcpServer })

  // Get the background service singleton (already initialized by initBackground())
  const background = getBackgroundService()
  if (!background) {
    throw new Error('[Bootstrap] BackgroundService not available -- initBackground() must be called first')
  }

  // ── Phase 2: App Manager ─────────────────────────────────────────────────
  const appManager = await initAppManager({ db })

  // ── Phase 2.1: Team data layer ───────────────────────────────────────────
  // Peer of the App Manager: owns the six Digital Team tables under the
  // 'app_team' migration namespace on the shared app database.
  initTeamStore({ db })

  // ── Federation data layer ────────────────────────────────────────────────
  // Peer of the Team data layer: owns the office_nodes / office_credentials
  // tables under the isolated 'app_federation' namespace — the node roster and
  // the credential revocation ledger the auth gate consults. No coordination
  // semantics; that lives in the federation manager.
  initFederationStore({ db })

  // Node's stable Ed25519 identity, established once at boot since
  // office-credential signing/verification (http/auth) anchor to it.
  initIdentity()

  // ── Phase 2.5: Migrate legacy config.mcpServers → DB ────────────────────
  // One-time migration: config.json mcpServers (dead storage from Issue #74)
  // are imported into the App Manager DB where getDbMcpServers() can read them.
  try {
    const { migrateConfigMcpToDb } = await import('../ipc/cli-config')
    await migrateConfigMcpToDb()
  } catch (err) {
    console.warn('[Bootstrap] Failed to run config.mcpServers migration:', err)
  }

  // ── Phase 3: App Runtime ─────────────────────────────────────────────────
  // initAppRuntime creates the EventRouter internally, wires source adapters
  // (FileWatcherSource, WebhookSource), activates Apps, and starts the router.
  const runtime = await initAppRuntime({ db, appManager, scheduler, memory, background })

  // ── Analytics subscribers ───────────────────────────────────────────────
  // Wire lifecycle events (install/uninstall/run) into the analytics pipeline.
  // Must come after both appManager and runtime are ready.
  installAppsSubscribers(appManager, runtime)

  // ── Phase 3.6: Team runtime + service ────────────────────────────────────
  // The team coordination kernel reuses the app-chat session layer (resume,
  // MCP injection), so it is constructed only after the App Runtime is ready.
  // setActiveTeamRuntime publishes it through the accessor app-chat/report-tool
  // read; initTeamService wires lifecycle deps (App Manager, the runtime
  // accessor, space + artifact helpers).
  const teamStore = getTeamStore()
  // Late-bound so the team service can resolve the trigger scheduler (created
  // after the service, since the scheduler needs the service's runTeam).
  let teamTriggerScheduler: TeamTriggerScheduler | null = null
  if (teamStore) {
    // Local session layer: runs members OWNED by this node (origin=local).
    const localSessionDeps = createDefaultSessionDeps(teamStore)

    // Local artifact byte resolution (apps/runtime/team/artifact-read): bootstrap
    // only supplies the app→space path lookup. Shared by the federation
    // owner-serve path and the team_read_artifact reader below.
    const readLocalArtifactBytes = createLocalArtifactResolver({
      store: teamStore,
      getSpacePathForApp: (appId) => {
        const app = appManager.getApp(appId)
        return app?.spaceId ? getSpace(app.spaceId)?.path ?? null : null
      },
    })

    // Federation manager: per-office host/joiner coordinators. Bootstrap is the
    // only tier bridging http and apps, so the http send/listing + credential
    // verifier are injected here. Owner role runs a brought member's turn via
    // the local session layer (runLocalTurn); inbound federation frames on the
    // WS server route back via setFederationInbound.
    const fedStore = getFederationStore()
    const authStore = getAuthorityStore()
    if (fedStore) {
      // ── Authority/replication wiring helpers (the authority modules stay decoupled) ──

      // Owner reachability: a member's owner node presence (offline / suspect)
      // takes precedence; otherwise busy/idle from the live session set.
      const computeOwnerStatus = (officeId: string, appId: string): OwnerStatus => {
        const member = teamStore.listMembersByTeam(officeId).find((m) => m.appId === appId)
        const ownerNode = member?.ownerNodeId
        if (ownerNode && ownerNode !== SELF_NODE_ID) {
          const node = fedStore.getNode(officeId, ownerNode)
          if (node?.status === 'offline') return 'confirmed-offline'
          if (node?.status === 'suspect') return 'suspect'
        }
        const ep = teamStore.getCurrentEpochForTeam(officeId)
        if (ep && activeSessions.has(buildTeamSessionKey(appId, officeId, ep.id))) return 'busy'
        return 'idle'
      }

      const emitBlackboard = (payload: Record<string, unknown>) => {
        broadcastToAll(TEAM_EVENTS.blackboard, payload)
        sendToRenderer(TEAM_EVENTS.blackboard, payload)
      }
      // Apply a remote member's admitted write to the authority's blackboard,
      // PRESERVING the owner-generated id (so the owner's optimistic copy and the
      // authority converge), then replicate it to hot-standbys.
      const applyAuthorityMemberWrite = (record: MemberWriteRecord) => {
        try {
          if (record.op === 'post_task') {
            const task = record.payload as unknown as BlackboardTask
            try { teamStore.insertTask(task) } catch { /* duplicate id (retry) → idempotent */ }
            emitBlackboard({ teamId: record.teamId, epochId: task.epochId, kind: 'task', task })
          } else if (record.op === 'update_task') {
            const p = record.payload as { taskId?: string; status?: TaskStatus; resultRef?: string | null; note?: string | null; updatedAt?: number }
            const taskId = record.taskId ?? p.taskId
            if (taskId && p.status) {
              teamStore.updateTask(
                taskId,
                { status: p.status, ...(p.resultRef !== undefined ? { resultRef: p.resultRef } : {}), ...(p.note !== undefined ? { note: p.note } : {}) },
                p.updatedAt ?? Date.now()
              )
              const task = teamStore.getTaskById(taskId)
              if (task) emitBlackboard({ teamId: record.teamId, epochId: task.epochId, kind: 'task', task })
            }
          } else if (record.op === 'post_finding') {
            const finding = record.payload as unknown as BlackboardFinding
            try { teamStore.insertFinding(finding) } catch { /* duplicate id → idempotent */ }
            emitBlackboard({ teamId: record.teamId, epochId: finding.epochId, kind: 'finding', finding })
          }
        } catch (err) {
          console.error('[Bootstrap] applyAuthorityMemberWrite failed:', err)
          return
        }
        // Replicate the admitted member write to hot-standbys (single-writer log).
        getFederationManager()?.routeAuthorityWrite({
          teamId: record.teamId,
          epochId: record.epochId,
          op: record.op,
          payload: record.payload,
          ...(record.taskId ? { taskId: record.taskId } : {}),
        })
      }

      // Owner-side artifact resolution (federation serve path): delegates to the
      // shared, path-traversal-guarded local resolver. Only a published ref of a
      // locally-owned producer resolves; never an arbitrary path or shell.
      const resolveOfficeArtifactBytes = (ref: ArtifactRef): Promise<Uint8Array | null> =>
        readLocalArtifactBytes({ teamId: ref.teamId, epochId: ref.epochId, ref: ref.ref })

      // Joiner leg of the node-identity handshake: sign a host's one-shot auth
      // nonce with this node's device key so the session binds the portable
      // identity (the receiving side then enforces fromNode === session id).
      // Shared by the primary join client and the peer dialer's re-form client.
      const makeAuthProof = (nonce: string) => {
        const identity = getLocalIdentity()
        return {
          method: 'device-key',
          identityId: identity.id,
          publicKey: getLocalPublicKeyPem(),
          displayName: identity.displayName,
          challenge: nonce,
          signature: signWithLocalKey(Buffer.from(nonce, 'base64')).toString('base64'),
        }
      }

      // Owner-side transcript serialization, shared by the pull path
      // (readMemberHistory) and the proactive session-feed replication
      // (readOwnedTranscript) so both surfaces always agree. seq is the 1-based
      // ordinal in the append-only transcript — stable across reads, so viewers
      // pull/replicate only the tail. Carries the thoughts/tool trace so a remote
      // viewer's backfill shows the same thinking the live relay did.
      const serializeTeamTranscript = (teamId: string, appId: string, epochId: string) => {
        const messages = readTeamMemberMessages(appId, teamId, epochId)
        return messages.map((m, i) => ({
          seq: i + 1,
          role: m.role,
          content: m.content,
          ...(m.thoughts ? { thoughts: m.thoughts } : {}),
          ...(m.thoughtsSummary ? { thoughtsSummary: m.thoughtsSummary } : {}),
          ...(m.timestamp ? { ts: Date.parse(m.timestamp) || undefined } : {}),
        }))
      }

      const federationManager = createFederationManager({
        hostSend: sendFederationFrameToClient,
        hostListOfficeClients: listOfficeClientIds,
        federationStore: fedStore,
        teamStore,
        verifyCredential: (token) => verifyOfficeCredential(token),
        // Anti-spoof: the host asserts an inbound frame's self-reported fromNode
        // against the node identity the sending session proved at the credential
        // handshake. Null (unknown/unauthenticated client) skips the assertion.
        getSessionIdentity: (clientId) => getSessionIdentity(clientId),
        getLocalNodeId: () => getLocalIdentity().id,
        makeAuthProof,
        // Address book: what this node advertises so peers can dial it after a
        // transport loss. Null while remote access is off — the node can then
        // dial out but not be dialed.
        getLocalAdvertisedUrl: () => {
          const status = getRemoteAccessStatus()
          return status.server.running ? status.server.lanUrl ?? null : null
        },
        // Production peer dialer: open a federation WS client against the target
        // node's advertised URL. Auth rides the saved invite token when the peer
        // can still verify it, and falls back to roster re-entry (device-key
        // proof + admitted-node check) when it cannot — e.g. dialing a newly-
        // elected authority that never issued our invite.
        peerDialer: (officeId, authorityNodeId) => {
          const manager = getFederationManager()
          const url = manager?.getNodeAddress(officeId, authorityNodeId)
          if (!url) {
            console.warn(`[Federation] peer dialer: no advertised URL office=${officeId} node=${authorityNodeId}`)
            return null
          }
          const savedToken = getFederationStore()
            ?.listJoinedOfficeConnections()
            .find((c) => c.officeId === officeId)?.inviteToken
          const client = new WsFederationClient({
            serverUrl: url,
            credentialToken: savedToken ?? '',
            officeId,
            makeAuthProof,
            onFrame: (frame) => getFederationManager()?.deliverInbound(officeId, frame, authorityNodeId),
            // Reconnect of the dialed leg: re-drive the join-request so the newly
            // elected authority re-enrolls this survivor (first-dial enrollment is
            // done by redialToAuthority; this covers a later drop+reconnect).
            onReauth: () => getFederationManager()?.reenrollWithAuthority(officeId),
          })
          return {
            sender: (to, frame) => client.send(frame, to),
            dispose: () => client.close(),
          }
        },
        // Advertised on join so the host renders the owner badge ("brought by
        // Alice") instead of a generic label on the members this node brings.
        getLocalDisplayName: () => getLocalIdentity().displayName,
        // Gateway relay: when configured (user setting or product default), a
        // hosted office also attaches to the gateway so off-LAN members can be
        // relayed. The announce signature uses the same device key as the
        // auth proof, keeping the federation layer identity-import-free.
        getGatewayUrl: () => getFederationGatewayUrl(),
        signGatewayAnnounce: (payload) =>
          signWithLocalKey(Buffer.from(payload, 'utf8')).toString('base64'),
        // Stamp each member's live status into the roster snapshot so a joiner's
        // topology animates the working pulse in step with the host. Reads the
        // team runtime's host-local getMemberStatus; idle when the runtime is not
        // yet wired.
        getMemberRuntimeStatus: (appId) => getActiveTeamRuntime()?.getMemberStatus(appId) ?? 'idle',
        // Owner-authoritative space resolution: a wake's request.spaceId is the
        // SENDER's sentinel for a member it does not own (see withOwnerResolvedSpace).
        // The owner runs the member locally, so it substitutes its own real space
        // before running; otherwise the transcript persists under getSpace(appId)
        // (which does not exist) and is silently never written — the cause of
        // "history-not-found" on a viewer and a member's reply flashing then
        // vanishing with no record on either side.
        runLocalTurn: (request) =>
          localSessionDeps.sendAppChatMessage(
            withOwnerResolvedSpace(request, (appId) => localSessionDeps.getMemberSpaceId(appId))
          ),
        // Deliberately NO kernel unblock on confirmed-offline: over a WAN tunnel
        // a confirmed-offline is routinely a transient outage, and the durable
        // ctrl outbox delivers the wake when the owner returns. Failing the wait
        // here judged live members "undelivered" on every flap; the ctrl-feed
        // give-up deadline is now the sole bounded arbiter of a wake that truly
        // never lands.
        // Presence projection → office-scoped UI event (teamId === officeId, so
        // broadcastToAll's per-credential filter delivers it only to that office).
        onPresenceChange: (officeId, snapshot) => {
          const payload = { teamId: officeId, nodes: snapshot.nodes }
          broadcastToAll('team:presence', payload)
          sendToRenderer('team:presence', payload)
        },
        // Roster changed (a member joined / the joiner materialized its shadow
        // office) → refresh the relationship graph + member list on both ends by
        // emitting team:updated, the event the renderer re-fetches the team on.
        onRosterChanged: (officeId) => {
          const team = teamStore.getTeamById(officeId)
          const payload = team ? { teamId: officeId, team } : { teamId: officeId }
          broadcastToAll(TEAM_EVENTS.updated, payload)
          sendToRenderer(TEAM_EVENTS.updated, payload)
        },
        // ── Authority/replication/resilience (falls back to local-only behaviour when absent) ──
        authorityStore: authStore ?? undefined,
        applyMemberWrite: (record) => applyAuthorityMemberWrite(record),
        getCurrentRunEpoch: (officeId) => {
          const ep = teamStore.getCurrentEpochForTeam(officeId)
          return ep ? { teamId: officeId, epochId: ep.id } : null
        },
        getOwnerStatus: (officeId, appId) => computeOwnerStatus(officeId, appId),
        reassignTask: (officeId, task) => {
          // An orphaned in_progress task (owner gone) resets to pending so the
          // lead re-dispatches it, via the authority's kernel board.
          getActiveTeamRuntime()?.blackboard.updateTask({
            teamId: officeId,
            epochId: task.epochId,
            taskId: task.id,
            status: 'pending',
            note: 'Reassigned automatically: the previous owner became unavailable.',
          })
        },
        resolveArtifactBytes: (ref) => resolveOfficeArtifactBytes(ref),
        // Authority changed / office paused → code-only status signal; the renderer
        // maps the kind to neutral copy (t('Reconnected automatically') etc.). No
        // technical words ever travel in a user-facing string.
        onAuthorityChange: (officeId) => {
          broadcastToAll('team:office-status', { teamId: officeId, kind: 'authority-changed' })
          sendToRenderer('team:office-status', { teamId: officeId, kind: 'authority-changed' })
          const team = teamStore.getTeamById(officeId)
          if (team) {
            broadcastToAll(TEAM_EVENTS.updated, { teamId: officeId, team })
            sendToRenderer(TEAM_EVENTS.updated, { teamId: officeId, team })
          }
        },
        onOfficePaused: (officeId, paused) => {
          broadcastToAll('team:office-status', { teamId: officeId, kind: paused ? 'paused' : 'resumed' })
          sendToRenderer('team:office-status', { teamId: officeId, kind: paused ? 'paused' : 'resumed' })
        },
        // Membership refused on re-entry: reconnecting alone cannot fix it, so
        // the renderer tells the user to rejoin with a fresh invite. The wire
        // reason stays in the log only — the kind is code-only, per the event's
        // no-technical-words contract.
        onOfficeAccessLost: (officeId, reason) => {
          console.warn(`[Bootstrap] office access lost office=${officeId} reason=${reason}`)
          broadcastToAll('team:office-status', { teamId: officeId, kind: 'access-lost' })
          sendToRenderer('team:office-status', { teamId: officeId, kind: 'access-lost' })
        },
        // Owner-side transcript reader: serve a member's team-channel history to a
        // viewer over the office link. Reuses the same read as the IPC/HTTP chat
        // surfaces so all three agree; the federation layer never opens chat
        // storage itself. An empty transcript is a VALID answer (the member just
        // hasn't spoken in this epoch) — answering not-found here made viewers
        // show "history temporarily unavailable" (502) for a perfectly healthy
        // member, diverging from how the same member reads on its own node.
        readMemberHistory: ({ teamId, appId, epochId }) =>
          serializeTeamTranscript(teamId, appId, epochId),
        // The same read without the request-scoped seam, driving the session-feed
        // plane's proactive replication of owned transcripts to every office node.
        readOwnedTranscript: (teamId, appId, epochId) =>
          serializeTeamTranscript(teamId, appId, epochId),
        // A session with a live turn has a provisional trailing message the
        // publisher must withhold (session keys ARE conversation ids).
        isSessionActive: (sessionKey) => activeSessions.has(sessionKey),
        // A member's local transcript replica grew → tell any open member panel
        // to silently reload (the read path serves the local copy instantly;
        // this signal is what keeps it live across nodes).
        onMemberHistoryUpdated: ({ officeId, appId, epochId }) => {
          const payload = { teamId: officeId, appId, epochId }
          broadcastToAll(TEAM_EVENTS.memberHistory, payload)
          sendToRenderer(TEAM_EVENTS.memberHistory, payload)
        },
        // A hot-standby applied a replicated task/finding to its replica store.
        // The signal carries no concrete task/finding object (only op + taskId),
        // so it's a refresh trigger, not a blackboard merge: emit team:updated so
        // the open detail re-fetches and the replicated row appears live, instead
        // of staying silent until a manual refresh.
        onReplicaApplied: (info) => {
          const team = teamStore.getTeamById(info.officeId)
          const payload = team ? { teamId: info.officeId, team } : { teamId: info.officeId }
          broadcastToAll(TEAM_EVENTS.updated, payload)
          sendToRenderer(TEAM_EVENTS.updated, payload)
        },
        // Joiner-side: the host kicked a member → drop the row by re-fetching the
        // office. The roster also re-converges via the accompanying re-broadcast.
        // A kick of one of THIS node's own members additionally carries a
        // memberKicked notice so the renderer tells the user (never silent). The
        // name is resolved before the roster converges past the removed row.
        onMemberRemovedRemote: (officeId, appId, ownMember) => {
          const team = teamStore.getTeamById(officeId)
          const kickedName = ownMember
            ? teamStore.listMembersByTeam(officeId).find((m) => m.appId === appId)?.memberName
            : undefined
          const payload: TeamUpdatedEvent = {
            teamId: officeId,
            ...(team ? { team } : {}),
            ...(ownMember ? { memberKicked: { appId, ...(kickedName ? { memberName: kickedName } : {}) } } : {}),
          }
          broadcastToAll(TEAM_EVENTS.updated, payload as unknown as Record<string, unknown>)
          sendToRenderer(TEAM_EVENTS.updated, payload)
        },
        // Joiner-side: the host dissolved the office → tear down the local shadow
        // exactly like an explicit leave. The manager already dropped the re-join
        // connection record via leaveOffice; here we ALSO purge the mirrored team
        // rows (team/members/edges/triggers) so the dissolved office does not
        // resurrect in the list on the next restart, then project the removal to
        // every view — mirroring leaveTeamOffice's teardown sequence.
        onOfficeDissolvedRemote: (officeId) => {
          teamStore.purgeJoinedOffice(officeId)
          // Mark it host-initiated so the renderer tells the user their office was
          // closed (a self leave / self dissolve stays silent — no reason set).
          const event: TeamUpdatedEvent = { teamId: officeId, removed: true, removedReason: 'dissolved-remote' }
          broadcastToAll(TEAM_EVENTS.updated, event as unknown as Record<string, unknown>)
          sendToRenderer(TEAM_EVENTS.updated, event)
        },
        // Host-side: a joiner left → remove the members it brought via the same
        // path as a kick (member-removed projection + roster re-broadcast + lead
        // reassignment). The manager already verified ownership against the leaver.
        onMemberLeft: (officeId, appIds) => {
          const svc = getTeamService()
          if (!svc) return
          for (const appId of appIds) {
            svc.removeMember(officeId, appId).catch((err) => {
              console.warn(`[Bootstrap] onMemberLeft removeMember failed office=${officeId} app=${appId}:`, err)
            })
          }
        },
      })
      setFederationManager(federationManager)
      setFederationInbound((ctx) => federationManager.handleHostInbound(ctx))

      // Activity-stream relay: capture this node's own team-session events
      // (owner-only, to respect the privacy boundary and avoid re-relaying an
      // event that arrived from elsewhere) and relay them so every office node
      // sees the member work live; the renderer is unchanged because replay
      // re-fires through emitAgentEvent.
      const relayCapture = createRelayCapture({
        isOwnTeamSession: (conversationId) => {
          const parsed = parseTeamSessionKey(conversationId)
          if (!parsed) return false
          // Scoped to the session's own team — a cross-team first-match could
          // read another office's owner for the same appId (see resolveOwnerNode).
          return (
            teamStore
              .listMembersByAppId(parsed.appId)
              .find((m) => m.teamId === parsed.teamId)?.ownerNodeId === SELF_NODE_ID
          )
        },
        resolveOffice: (conversationId) => parseTeamSessionKey(conversationId)?.teamId ?? null,
        sink: (officeId, batch) => federationManager.relaySink(officeId, batch),
      })
      disposeRelayCapture = relayCapture.start()
      flushRelayCapture = () => relayCapture.flushAll()

      // Waking from sleep must not register the sleep as peer silence: grant
      // every office a presence grace window on the OS resume event. This is the
      // platform-independent path; the coordinator's clock-delta guard is a
      // secondary net (performance.now() advances across sleep on some OSes).
      onSystemResume = () => getFederationManager()?.handleSystemResume()
      powerMonitor.on('resume', onSystemResume)

      console.log('[Bootstrap] Federation manager + activity relay initialized')
    } else {
      console.warn('[Bootstrap] Federation store unavailable; federation manager not initialized')
    }

    // Position-transparent session deps: local members run here; remote members
    // are woken on their owner node and their result flows back via turn-complete.
    // No "local/remote" parameter ever reaches the agent calling convention — the
    // split lives entirely inside sendAppChatMessage. Falls back to plain local
    // deps when the federation manager is unavailable.
    const fedManager = getFederationManager()
    const teamSessionDeps = fedManager
      ? makeLocationAwareSessionDeps({
          local: localSessionDeps,
          selfNodeId: getLocalIdentity().id,
          // Scoped to the turn's team: the same app can be a member of several
          // teams with a different owner in each, so a cross-team first-match
          // would route the wake to another office's owner. Falls back to any
          // membership only for team-agnostic calls (no teamId).
          resolveOwnerNode: (appId, teamId) => {
            const memberships = teamStore.listMembersByAppId(appId)
            const scoped = teamId ? memberships.find((m) => m.teamId === teamId) : undefined
            return (scoped ?? memberships[0])?.ownerNodeId ?? SELF_NODE_ID
          },
          getRemoteSpaceId: (appId) => fedManager.getRemoteMemberSpaceId(appId),
          sendWake: (p) => fedManager.sendWakeToMember(p),
          // Return the unregister closure — session-deps stores it and calls it on
          // settle. A block body without `return` dropped it (unregister became
          // undefined → `unregister()` threw → the remote wake promise never
          // resolved → 30-min hang + "no waiter; dropping").
          registerTurnComplete: (corr, cb) => fedManager.registerTurnComplete(corr, cb),
        })
      : localSessionDeps

    // Replication capture + location-aware blackboard. The decorator routes a
    // shadow office's writes to its host (single-writer); the authority's own
    // office delegates to the kernel board → onBlackboardWrite → replicate. Both
    // are no-ops when the federation manager is unavailable.
    const selfNodeId = getLocalIdentity().id
    // Last board-discard notice per office (see onWriteDiscarded coalescing).
    const boardDiscardNoticeAt = new Map<string, number>()

    // Location-transparent artifact reader powering `team_read_artifact` (logic
    // in apps/runtime/team/artifact-read). Bootstrap only bridges: local bytes
    // via the shared resolver, remote bytes via the federation manager with its
    // fetch failures translated into the reader's typed contract — so raw
    // transport codes never leak into agent-facing messages.
    const readTeamArtifact = createTeamArtifactReader({
      store: teamStore,
      readLocalBytes: readLocalArtifactBytes,
      ...(fedManager
        ? {
            fetchRemote: async ({ teamId, epochId, ref, ownerNodeId }) => {
              try {
                return (
                  (await getFederationManager()?.fetchArtifact({
                    officeId: teamId,
                    ref: { ownerNodeId, teamId, epochId, ref },
                  })) ?? null
                )
              } catch (err) {
                const msg = (err as Error).message
                throw new RemoteArtifactError(classifyArtifactFetchFailure(msg), msg)
              }
            },
          }
        : {}),
    })

    setActiveTeamRuntime(
      createTeamRuntime({
        store: teamStore,
        session: teamSessionDeps,
        readArtifact: readTeamArtifact,
        onBlackboardWrite: (record) => getFederationManager()?.routeAuthorityWrite(record),
        // Auto-seal (quiescence) / breach end a run without going through the
        // service-level pauseTeam, so they must also push the rested run-state to
        // joiners — otherwise a remote roster keeps a member "working" until the
        // next throttled refresh. broadcastRosterFor re-projects the now-idle
        // status + cleared epoch; no-op when the office is not hosted here.
        onRunStateChanged: (teamId) => getFederationManager()?.broadcastRosterFor(teamId),
        // A member executing on a REMOTE owner has no local session, so the
        // runtime's own ledger reads idle. The manager knows the wake is in
        // flight; overlay it so boards/rosters pulse the member everywhere.
        getMemberStatusOverlay: (appId) =>
          getFederationManager()?.isMemberRemoteBusy(appId) ? 'working' : null,
        // Immediate reachability for the wait=false honest-delivery gate: a member
        // owned by an offline/unreachable remote node is reported "not delivered" at
        // send time. No federation manager (non-federated) → default reachable.
        checkMemberReachable: (appId, teamId) =>
          getFederationManager()?.isMemberReachable(appId, teamId) ?? true,
        // Push each status flip (turn start/end, escalation) to joiners via the
        // coalesced roster refresh — without it a viewer's board froze on the
        // last projected status until an unrelated write refreshed the roster.
        onMemberStatusChanged: (teamId) => getFederationManager()?.scheduleRosterRefresh(teamId),
        wrapBlackboard: fedManager
          ? (base) =>
              createLocationAwareBlackboard({
                base,
                store: teamStore,
                selfNodeId,
                sendBlackboardWrite: (hostNodeId, write) =>
                  getFederationManager()?.sendMemberWrite({ ...write, hostNodeId }),
                // Partition write gate: while this node sees the office paused
                // (authority lost, no elected successor / minority side), shadow
                // writes are refused with a calm retryable error instead of
                // piling up divergent optimistic rows (AC-5.4).
                isOfficePaused: (teamId) =>
                  getFederationManager()?.getOfficeAuthority(teamId)?.isPaused() ?? false,
                // A rolled-back optimistic write must reach the user, not just the
                // log: emit team:updated with the discard notice so the renderer
                // toasts + refetches the open board (the phantom row disappears).
                // Coalesced per office — a partition can expire several pending
                // writes at once and one notice covers the whole burst.
                onWriteDiscarded: (teamId) => {
                  const now = Date.now()
                  const last = boardDiscardNoticeAt.get(teamId) ?? 0
                  if (now - last < 5_000) return
                  boardDiscardNoticeAt.set(teamId, now)
                  const event: TeamUpdatedEvent = { teamId, boardWriteDiscarded: true }
                  broadcastToAll(TEAM_EVENTS.updated, event as unknown as Record<string, unknown>)
                  sendToRenderer(TEAM_EVENTS.updated, event)
                },
              })
          : undefined,
      })
    )
    initTeamService({
      store: teamStore,
      appManager,
      getRuntime: () => getActiveTeamRuntime(),
      getTriggerSync: () => teamTriggerScheduler,
      spaces: {
        spaceExists: (spaceId) => getSpace(spaceId) != null,
        // AI-provisioned members get their own independent space under the
        // owning team. createSpace centralizes data; the name carries
        // the team + member handle for human-readable grouping.
        createMemberSpace: ({ teamName, memberName }) =>
          createSpace({ name: `${teamName} · ${memberName}`, icon: 'users' }).id,
        // Fire-and-forget on dissolve orphan cleanup: deleteSpace is async but
        // the service contract is sync (best-effort); errors are logged inside.
        deleteMemberSpace: (spaceId) => {
          void deleteSpace(spaceId).catch((err) =>
            console.warn('[Bootstrap] Team member space delete failed:', err)
          )
        },
        // Resolve a space to its absolute path so relative artifact refs
        // (e.g. "brief.md") can be opened.
        resolveSpacePath: (spaceId) => getSpace(spaceId)?.path ?? null,
      },
      listArtifacts: (spaceId) => listArtifacts(spaceId),
      // Federation egress: project membership/lifecycle mutations to a hosted
      // office's joiners so a remote roster converges on every change. The manager
      // no-ops each when the office is not hosted here, so an unhosted office or a
      // non-federated build is safe. A member removal projects the frame AND
      // re-broadcasts the roster (the frame lets a joiner drop the row immediately;
      // the roster re-broadcast is the convergent source of truth).
      onRosterMutated: (teamId) => getFederationManager()?.broadcastRosterFor(teamId),
      onMemberRemoved: (teamId, appId) => {
        const mgr = getFederationManager()
        mgr?.projectMemberRemoved(teamId, appId)
        mgr?.broadcastRosterFor(teamId)
      },
      onOfficeDissolved: (teamId) => getFederationManager()?.projectOfficeDissolved(teamId),
      // Run start/stop → push the live run-state (team running status + active
      // epoch) to joiners immediately so a remote status board goes live the
      // instant the host presses Run (and rests when it stops). Start/stop are
      // infrequent discrete events, so they re-project at once (not throttled);
      // the high-frequency member-status churn during the run rides the throttled
      // scheduleRosterRefresh off each board write.
      onRunStateChanged: (teamId) => getFederationManager()?.broadcastRosterFor(teamId),
    })

    // Team triggers: register the kind='team' scheduler handler and rehydrate
    // persisted triggers — schedule triggers become scheduler jobs, event
    // triggers (webhook/file/wecom) become EventRouter subscriptions. Must run
    // before scheduler.start(). The EventRouter is created inside initAppRuntime
    // above, so it is available here.
    const teamService = getTeamService()
    const eventRouter = getEventRouter()
    if (teamService && eventRouter) {
      teamTriggerScheduler = createTeamTriggerScheduler({
        scheduler,
        store: teamStore,
        eventRouter,
        runTeam: (teamId, trigger) => teamService.runTeam(teamId, trigger),
      })
      teamTriggerScheduler.registerHandler()
      teamTriggerScheduler.rehydrate()
    } else if (teamService && !eventRouter) {
      console.warn('[Bootstrap] EventRouter unavailable; team trigger scheduler not initialized')
    }
  } else {
    console.warn('[Bootstrap] Team store unavailable; team service not initialized')
  }

  // ── Phase 4: Registry Service (App Store) ─────────────────────────────
  initRegistryService({ db })

  // ── Upgrade Scheduler ─────────────────────────────────────────────────
  // 6h periodic check + auto-apply for patch/minor on 'auto' strategy.
  // Surfaces 'store:upgrade-available' events for major/notify/manual.
  startUpgradeScheduler()

  // ── Start timer loops AFTER all wiring is complete ──────────────────────
  // This ensures no events fire before subscriptions are registered.
  scheduler.start()

  // ── Office lifecycle recovery ────────────────────────────────────────────
  // Without this an office exists only while the invite dialog is open: nothing
  // re-hosts a prior office or re-joins a prior connection after an app restart.
  // Runs as an idle task: recovery is non-essential and must never block startup;
  // a joiner's own client reconnects on backoff, so readiness arriving shortly
  // after boot is in time.
  registerIdleTask('recover-offices', () => {
    recoverPersistedOffices(teamStore)
  })

  // ── Tier 3: Idle tasks ─────────────────────────────────────────────────
  // Non-critical tasks that run after all essential infrastructure is ready.
  // Failures are logged as warnings and never affect core functionality.
  //
  // Order matters here: the built-in loader installs bundled digital humans
  // declared in product.json's `builtinApps` list. The default-app seed then
  // checks whether any automation app exists (or any built-in is bundled) to
  // decide if the "Halo 助手" placeholder should be created. Running the loader
  // first ensures the seed makes its decision against the post-loader state.
  registerIdleTask('load-builtin-apps', () => loadBuiltinApps(appManager))
  registerIdleTask('seed-default-app', () => seedDefaultAppIfNeeded(appManager))
  registerIdleTask('startup-snapshot', () => runStartupSnapshot(appManager, runtime))
  startIdleDrain()

  const dt = performance.now() - t0
  console.log(`[Bootstrap] Platform+Apps initialized in ${dt.toFixed(1)}ms`)
}

/**
 * Initialize extended services after window is visible
 *
 * Window reference is managed by window.service.ts, no need to pass here.
 *
 * These services are loaded asynchronously and do not block the UI.
 * Heavy modules use lazy initialization - they only fully initialize
 * when their features are first accessed.
 */
export function initializeExtendedServices(): void {
  const start = performance.now()
  console.log('[Bootstrap] Extended services starting...')

  console.log(`[Startup] proxy env_http=${process.env.HTTP_PROXY || ''} env_https=${process.env.HTTPS_PROXY || ''} env_no_proxy=${process.env.NO_PROXY || ''} app_proxy=${getConfig().network?.proxy || ''}`)

  // Get main window for services that still need it directly
  const mainWindow = getMainWindow()

  // === EXTENDED SERVICES ===
  // These services are loaded after the window is visible.
  // New features should be added here by default.

  // Onboarding: First-time user guide, only needed once
  registerOnboardingHandlers()

  // Remote: Remote access feature, optional functionality
  registerRemoteHandlers()

  // Security: expose renderer-safe security policy flags so the UI can
  // gate features (e.g. Tunnel section visibility under tunnelSafe).
  registerSecurityHandlers()

  // Move credentials still under the legacy machine key (or plaintext) onto the
  // persisted master key. No-op on open-source and already-migrated installs.
  registerIdleTask('migrate-credential-encryption', async () => {
    try {
      migrateCredentialEncryption()
    } catch (err) {
      console.warn(
        '[Bootstrap] Credential encryption migration failed:',
        (err as Error).message,
      )
    }
  })

  // Auto-restore so paired devices keep working without manual re-enable.
  // CF tunnel is intentionally not restored — its Quick Tunnel URL changes per
  // run, which would break any previously shared link.
  //
  // Errors are caught here (rather than letting the idle task crash) so a
  // corrupted credential at rest cannot block other extended bootstrap
  // tasks. enableRemoteAccess has already disabled the persisted flag and
  // pushed a status update, so the UI will reflect the failure when the
  // settings page is opened.
  registerIdleTask('restore-remote-access', async () => {
    const cfg = getConfig()
    if (!cfg.remoteAccess.enabled) return
    try {
      await enableRemoteAccess(cfg.remoteAccess.port)
    } catch (err) {
      console.warn(
        '[Bootstrap] Remote access auto-restore failed:',
        (err as Error).message,
      )
    }
  })

  // Browser: Embedded BrowserView for Content Canvas
  // Note: BrowserView is created lazily when Canvas is opened
  registerBrowserHandlers(mainWindow)

  // Browser Policy: user-extensible allowlist (Settings + blocked-page action)
  registerBrowserPolicyHandlers()

  // AI Browser: No startup registration needed.
  // Initialization is self-contained in createAIBrowserMcpServer() (called on
  // demand by send-message, app-chat, and execute). See ai-browser/DESIGN.md.

  // Overlay: Floating UI elements (chat capsule, etc.)
  // Already implements lazy initialization internally
  registerOverlayHandlers(mainWindow)

  // Search: Global search functionality
  initializeSearchHandlers()

  // Performance: Developer monitoring tools (only if window is available)
  if (mainWindow) {
    registerPerfHandlers(mainWindow)
  }

  // GitBash: Windows Git Bash detection and setup
  registerGitBashHandlers()

  // Health: System health monitoring and recovery
  // Register IPC handlers for health queries from renderer
  registerHealthHandlers()

  // Background: Process keep-alive, system tray, daemon browser
  // Provides infrastructure for automation Apps to keep the process alive
  // and access a shared hidden BrowserWindow with stealth injection
  const backgroundService = initBackground()
  backgroundService.initTray()

  // Wire browser-domain stealth injection into the platform daemon browser
  // without the platform tier importing services (keeps platform → services
  // direction clean). Best-effort: the daemon window runs without it if unset.
  setDaemonStealthInjector(injectStealthScripts)

  // Analytics: fire-and-forget IPC channel for renderer telemetry
  registerAnalyticsHandlers()

  // App management IPC handlers (app:install, app:list, etc.)
  registerAppHandlers()

  // Digital Team IPC handlers (team:list, team:create, team:run, etc.)
  registerTeamIpc()

  // Notification channel IPC handlers (notify-channels:test, etc.)
  registerNotificationChannelHandlers()

  // WeCom Bot IPC handlers — legacy compat, delegates to ImChannelManager
  registerWecomBotHandlers()

  // IM Channel IPC handlers (multi-instance: im-channels:status, im-channels:reconnect, etc.)
  registerImChannelHandlers()

  // IM Session IPC handlers (im-sessions:list, im-sessions:set-proactive)
  registerImSessionHandlers()

  // Store: IPC handlers for App Store registry operations
  registerStoreHandlers()

  // CLI Config: IPC handlers for Claude CLI config dir + migration
  registerCliConfigHandlers()

  // Model Capabilities: IPC handlers for model capability lookups (preset + user overrides)
  registerModelCapabilitiesHandlers()

  // WeChat iLink Bot: QR code login + token management IPC handlers
  registerWeixinIlinkHandlers()

  // Windows-specific: Initialize Git Bash in background
  if (process.platform === 'win32') {
    initializeGitBashOnStartup()
      .then((status) => {
        console.log('[Bootstrap] Git Bash status:', status)
      })
      .catch((err) => {
        console.error('[Bootstrap] Git Bash initialization failed:', err)
      })
  }

  // Initialize health system asynchronously (non-blocking)
  // This runs startup checks and starts fallback polling
  setSessionCleanupFn(closeAllV2Sessions)
  initializeHealthSystem()
    .then(() => {
      console.log('[Bootstrap] Health system initialized')
    })
    .catch((err) => {
      console.error('[Bootstrap] Health system initialization failed:', err)
    })

  // Platform + Apps: Store, Scheduler, Memory, AppManager, AppRuntime
  // Runs fully asynchronously -- does not block the UI or extended-ready event.
  initPlatformAndApps().catch((err) => {
    console.error('[Bootstrap] Platform+Apps initialization failed:', err)
  })

  const duration = performance.now() - start
  console.log(`[Bootstrap] Extended services registered in ${duration.toFixed(1)}ms`)

  // Mark state as ready (for Pull-based queries from renderer)
  // This enables renderer to query status on HMR reload or error recovery
  markExtendedServicesReady()

  // Notify renderer that extended services are ready (Push-based)
  // This allows renderer to safely call extended service APIs
  sendToRenderer('bootstrap:extended-ready', {
    timestamp: Date.now(),
    duration: duration
  })
  console.log('[Bootstrap] Sent bootstrap:extended-ready to renderer')
}

/**
 * Cleanup extended services on app shutdown
 *
 * Called during window-all-closed to properly release resources.
 */
export async function cleanupExtendedServices(): Promise<void> {
  // Space: Flush any throttled activity timestamps to disk before teardown
  flushSpaceActivity()

  // Store: Stop upgrade scheduler before tearing down registry / app manager
  stopUpgradeScheduler()

  // Store: Shutdown registry service (before app manager)
  shutdownRegistryService()

  // Team: Tear down the service + runtime accessor and the data layer before
  // the App Manager goes away (the service holds an App Manager reference).
  shutdownTeamService()
  setActiveTeamRuntime(null)
  if (onSystemResume) {
    powerMonitor.removeListener('resume', onSystemResume)
    onSystemResume = null
  }
  try {
    flushRelayCapture?.()
    disposeRelayCapture?.dispose()
  } catch (err) {
    console.error('[Bootstrap] Relay capture teardown error:', err)
  }
  disposeRelayCapture = null
  flushRelayCapture = null
  getFederationManager()?.stopAll()
  setFederationManager(null)
  setFederationInbound(null)
  shutdownTeamStore()
  shutdownFederationStore()

  // Apps: Shutdown runtime first (deactivates all apps, stops event router, cancels runs).
  // This is intentionally ahead of `analytics.destroy()` so that any final
  // `RunFinishedEvent`s fired during deactivation are still delivered to the
  // analytics pipeline and buffered by the telemetry provider.
  await shutdownAppRuntime().catch(err => console.error('[Bootstrap] AppRuntime shutdown error:', err))
  await shutdownAppManager().catch(err => console.error('[Bootstrap] AppManager shutdown error:', err))

  // Analytics: Flush pending events (including anything buffered from the
  // runtime shutdown above). The provider applies its own bounded flush
  // timeout so we never hang here.
  await analytics.destroy().catch(err => console.error('[Bootstrap] Analytics shutdown error:', err))

  // Platform: Shutdown scheduler (stop timers)
  await shutdownScheduler().catch(err => console.error('[Bootstrap] Scheduler shutdown error:', err))

  // Platform: Close database connections
  if (platformDb) {
    await shutdownStore(platformDb).catch(err => console.error('[Bootstrap] Store shutdown error:', err))
    platformDb = null
  }

  // Background: Shutdown daemon browser, clear keep-alive, destroy tray
  shutdownBackground()

  // AI Browser: Cleanup global singleton context (scoped contexts are cleaned
  // up by their owners: app-chat.ts / execute.ts)
  cleanupAIBrowser()

  // Web Search: Dispose search context (cleanup any in-flight BrowserViews)
  await disposeSearchContext().catch(err => console.error('[Bootstrap] WebSearch shutdown error:', err))

  // Overlay: Cleanup overlay BrowserView
  cleanupOverlayHandlers()

  // Search: Cancel any ongoing searches
  cleanupSearchHandlers()

  // Artifact Cache: Close file watchers and clear caches
  await cleanupAllCaches()

  console.log('[Bootstrap] Extended services cleaned up')
}

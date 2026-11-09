import type Database from 'better-sqlite3'
import type { InstalledApp, ExecutionEnvironment } from '../../../shared/apps/app-types'
import type { AgentModelSelection } from '../../../shared/types/ai-sources'
import type { EngineId } from '../../../shared/types/engine'
import type { TeamParticipant, TeamDelegatedPolicy, TeamRequestOrigin } from '../../../shared/apps/team-types'
import { SELF_NODE_ID } from '../../../shared/apps/team-types'
import type { TurnFileAccess } from '../../../shared/apps/capability-policy'
import type { MemberWorkspace } from '@hello-halo/agent-sdk/collaboration/workspaces'

/** Local execution configuration never enters participant replication records. */
export interface ParticipantExecution {
  sourceAppId?: string
  modelSelection: AgentModelSelection
  engineId: EngineId
  environment: ExecutionEnvironment
  prompt: string
  permissions: InstalledApp['permissions']
  delegatedPolicy?: TeamDelegatedPolicy
  origin?: TeamRequestOrigin
  workspace?: MemberWorkspace
  fileAccess?: TurnFileAccess
  permissionMode?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  allowDangerouslySkipPermissions?: boolean
  mcpServerNames?: string[]
  requestId?: string
  stopped?: boolean
}

interface ParticipantRow {
  app_id: string
  team_id: string
  epoch_id: string
  parent_app_id: string
  member_name: string
  owner_node_id: string
  origin: 'local' | 'remote'
  added_at: number
  metadata_json: string
  execution_json: string | null
}

export interface TeamParticipants {
  getById(appId: string): TeamParticipant | null
  get(teamId: string, epochId: string, appId: string): TeamParticipant | null
  findByName(teamId: string, epochId: string, name: string): TeamParticipant | null
  list(teamId: string, epochId: string): TeamParticipant[]
  listByTeam(teamId: string): TeamParticipant[]
  insert(participant: TeamParticipant, execution?: ParticipantExecution): void
  applyReplica(participant: TeamParticipant, selfNodeId: string): void
  getExecution(teamId: string, epochId: string, appId: string): ParticipantExecution | null
  updateExecution(teamId: string, epochId: string, appId: string, execution: ParticipantExecution): void
  remove(teamId: string, epochId: string, appId: string): boolean
}

function fromRow(row: ParticipantRow): TeamParticipant {
  const metadata = JSON.parse(row.metadata_json) as Pick<TeamParticipant, 'role' | 'duty' | 'memberIdentity' | 'ownerDisplayName'>
  return {
    teamId: row.team_id, epochId: row.epoch_id, appId: row.app_id, parentAppId: row.parent_app_id,
    memberName: row.member_name, ownerNodeId: row.owner_node_id, origin: row.origin, addedAt: row.added_at,
    role: metadata.role, duty: metadata.duty, memberIdentity: metadata.memberIdentity, ownerDisplayName: metadata.ownerDisplayName,
    isLead: false, aiProvisioned: false, isTemporary: true, acceptsChecks: false,
  }
}

export function createTeamParticipants(db: Database.Database, identityExists: (id: string) => boolean = () => false): TeamParticipants {
  const get = db.prepare('SELECT * FROM team_participants WHERE team_id = ? AND epoch_id = ? AND app_id = ?')
  const byId = db.prepare('SELECT * FROM team_participants WHERE app_id = ?')
  const permanent = db.prepare('SELECT 1 FROM team_members WHERE app_id = ? LIMIT 1')
  const named = db.prepare('SELECT * FROM team_participants WHERE team_id = ? AND epoch_id = ? AND member_name = ?')
  const list = db.prepare('SELECT * FROM team_participants WHERE team_id = ? AND epoch_id = ? ORDER BY added_at, app_id')
  const all = db.prepare('SELECT * FROM team_participants WHERE team_id = ? ORDER BY epoch_id, added_at, app_id')
  const epoch = db.prepare('SELECT 1 FROM team_epochs WHERE team_id = ? AND id = ?')
  const insert = db.prepare(`INSERT INTO team_participants (
    app_id, team_id, epoch_id, parent_app_id, member_name, owner_node_id, origin, added_at, metadata_json, execution_json
  ) VALUES (@app_id, @team_id, @epoch_id, @parent_app_id, @member_name, @owner_node_id, @origin, @added_at, @metadata_json, @execution_json)`)
  const update = db.prepare(`UPDATE team_participants SET execution_json = ?
    WHERE team_id = ? AND epoch_id = ? AND app_id = ? AND origin = 'local' AND owner_node_id = ?`)
  const remove = db.prepare('DELETE FROM team_participants WHERE team_id = ? AND epoch_id = ? AND app_id = ?')
  const row = (teamId: string, epochId: string, appId: string) => get.get(teamId, epochId, appId) as ParticipantRow | undefined
  return {
    getById(appId) { const found = byId.get(appId) as ParticipantRow | undefined; return found ? fromRow(found) : null },
    get(teamId, epochId, appId) { const found = row(teamId, epochId, appId); return found ? fromRow(found) : null },
    findByName(teamId, epochId, name) { const found = named.get(teamId, epochId, name) as ParticipantRow | undefined; return found ? fromRow(found) : null },
    list: (teamId, epochId) => (list.all(teamId, epochId) as ParticipantRow[]).map(fromRow),
    listByTeam: teamId => (all.all(teamId) as ParticipantRow[]).map(fromRow),
    insert(participant, execution) {
      if (permanent.get(participant.appId) || identityExists(participant.appId)) throw new Error('A participant identity conflicts with an existing App or standing member.')
      if (!epoch.get(participant.teamId, participant.epochId)) throw new Error('The participant work scope does not belong to this team.')
      const owner = participant.ownerNodeId ?? SELF_NODE_ID
      const origin = participant.origin ?? 'local'
      if (execution && (origin !== 'local' || owner !== SELF_NODE_ID)) throw new Error('A remote participant cannot install local execution configuration.')
      insert.run({
        app_id: participant.appId, team_id: participant.teamId, epoch_id: participant.epochId,
        parent_app_id: participant.parentAppId, member_name: participant.memberName,
        owner_node_id: owner, origin, added_at: participant.addedAt,
        metadata_json: JSON.stringify({ role: participant.role, duty: participant.duty,
          memberIdentity: participant.memberIdentity, ownerDisplayName: participant.ownerDisplayName }),
        execution_json: execution ? JSON.stringify(execution) : null,
      })
    },
    applyReplica(participant, selfNodeId) {
      if (permanent.get(participant.appId) || identityExists(participant.appId)) throw new Error('A participant identity conflicts with an existing App or standing member.')
      const owner = participant.ownerNodeId === selfNodeId ? SELF_NODE_ID : participant.ownerNodeId
      if (!owner || participant.ownerNodeId === SELF_NODE_ID) throw new Error('A replica participant requires a portable owner identity.')
      const existing = byId.get(participant.appId) as ParticipantRow | undefined
      if (existing) {
        if (existing.team_id !== participant.teamId || existing.epoch_id !== participant.epochId
          || existing.parent_app_id !== participant.parentAppId || existing.owner_node_id !== owner
          || existing.member_name !== participant.memberName || existing.added_at !== participant.addedAt) {
          throw new Error('A participant identity cannot be reassigned by replication.')
        }
        return
      }
      this.insert({ ...participant, ownerNodeId: owner, origin: owner === SELF_NODE_ID ? 'local' : 'remote' })
    },
    getExecution(teamId, epochId, appId) {
      const found = row(teamId, epochId, appId)
      return found?.origin === 'local' && found.owner_node_id === SELF_NODE_ID && found.execution_json
        ? JSON.parse(found.execution_json) as ParticipantExecution : null
    },
    updateExecution(teamId, epochId, appId, execution) {
      if (update.run(JSON.stringify(execution), teamId, epochId, appId, SELF_NODE_ID).changes !== 1) {
        throw new Error('The local participant is not available in this work scope.')
      }
    },
    remove: (teamId, epochId, appId) => remove.run(teamId, epochId, appId).changes > 0,
  }
}

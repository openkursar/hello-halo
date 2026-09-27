/**
 * Seeds one live temporary space collaboration into a fresh E2E profile.
 *
 * Both halves are written through the REAL stores — the space conversation
 * through conversation.service (JSON files) and the collaboration through
 * TeamStore (app_team tables) — so the spec reaches the team view the way a
 * person does: the conversation's collaboration card, which resolves the team
 * through `getCollabTeamByConversation`. Binding that projection instead would
 * test the stub, not the lookup that binds the two.
 *
 * Runs under Electron's own Node binary (see seed-app.ts for why), before the
 * app launches: conversation.service caches reads by file path and the app opens
 * the database on boot.
 *
 * Contract: argv[2] is a JSON-encoded payload; the seeded ids are printed to
 * stdout as the last line.
 */

import { mkdirSync } from 'fs'
import { join } from 'path'
import { createConversation, addMessage, updateConversation } from '../../../src/main/services/conversation.service'
import { createDatabaseManager } from '../../../src/main/platform/store/database-manager'
import { migrations as managerMigrations } from '../../../src/main/apps/manager/migrations'
import { migrations as runtimeMigrations } from '../../../src/main/apps/runtime/migrations'
import { migrations as teamMigrations } from '../../../src/main/apps/team/migrations'
import { TeamStore } from '../../../src/main/apps/team/store'
import {
  SPACE_COORDINATOR_MEMBER_NAME,
  spaceCollabChatKey,
  spaceCoordinatorAppId,
} from '../../../src/shared/apps/team-types'

interface SeedPayload {
  directory: string
  teamName: string
  memberName: string
  conversationTitle: string
}

export interface SeededCollaboration {
  conversationId: string
  teamId: string
  roomId: string
  memberAppId: string
}

const { directory, teamName, memberName, conversationTitle } = JSON.parse(process.argv[2]) as SeedPayload

const conversation = createConversation('halo-temp')
addMessage('halo-temp', conversation.id, { role: 'user', content: 'Compare the two pricing tiers.' })
addMessage('halo-temp', conversation.id, { role: 'assistant', content: 'I have gathered both tiers and handed the review to the team.' })
// A rename, not a creation title: the first message auto-titles a conversation
// until the user names it themselves.
updateConversation('halo-temp', conversation.id, { title: conversationTitle })

const manager = createDatabaseManager(join(directory, '.halo', 'halo.db'))
const db = manager.getAppDatabase()
manager.runMigrations(db, 'app_manager', managerMigrations)
manager.runMigrations(db, 'app_runtime', runtimeMigrations)
manager.runMigrations(db, 'app_team', teamMigrations)
const teams = new TeamStore(db)

const now = Date.now() - 60000
// The member's digital human, installed like any other (the roster projects it
// as this machine's own, which is what makes the room writable).
const memberAppId = 'collab-member'
db.prepare(`INSERT INTO installed_apps
  (id, spec_id, space_id, spec_json, status, user_config_json, user_overrides_json, permissions_json, installed_at)
  VALUES (?, ?, 'halo-temp', ?, 'paused', '{}', '{}', '{"granted":[],"denied":[]}', ?)`).run(
  memberAppId,
  memberAppId,
  JSON.stringify({
    spec_version: '1', name: memberName, version: '1.0', author: 'e2e', type: 'automation',
    description: 'Pricing analyst', system_prompt: 'Report back to the coordinator.', subscriptions: [], requires: {}, config_schema: [], permissions: [],
  }),
  now
)
mkdirSync(join(directory, '.halo', 'temp', '.halo', 'apps', memberAppId, 'sessions'), { recursive: true })

const teamId = 'collab-team'
const roomId = 'collab-room'
teams.insertTeam({
  id: teamId, name: teamName, goal: 'Compare competitors', owningSpaceId: 'halo-temp',
  // A collaboration has no lead app: the space conversation coordinates it.
  leadAppId: spaceCoordinatorAppId(conversation.id),
  memberSourcing: 'ai', collabMode: 'free', escalationRouting: 'user',
  status: 'idle', currentEpochId: null, createdAt: now, updatedAt: now,
  ephemeral: true, coordinatorConversationId: conversation.id,
})
teams.addMember({
  teamId, appId: spaceCoordinatorAppId(conversation.id), memberName: SPACE_COORDINATOR_MEMBER_NAME,
  role: 'Coordinator', isLead: true, aiProvisioned: false, isSystemCoordinator: true, addedAt: now,
})
teams.addMember({
  teamId, appId: memberAppId, memberName, role: 'Pricing analyst',
  duty: 'Collect both pricing tiers and report the differences.',
  isLead: false, aiProvisioned: true, addedAt: now,
})
teams.insertEpoch({
  id: roomId, teamId, startedAt: now, endedAt: null, endReason: null, summary: null,
  lifecycle: 'conversation', chatKey: spaceCollabChatKey(conversation.id), title: teamName,
  lastActivityAt: now,
})
manager.closeAll()

const seeded: SeededCollaboration = { conversationId: conversation.id, teamId, roomId, memberAppId }
process.stdout.write(JSON.stringify(seeded) + '\n')
process.exit(0)

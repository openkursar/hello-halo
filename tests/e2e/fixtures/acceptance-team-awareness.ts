/**
 * A saved team for asking a digital human about its team work: the asker, one
 * teammate, and two open conversations of which the newer one is unrelated —
 * the shape in which a message once landed in the wrong task.
 */

import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { Team, TeamConversation } from '../../../src/shared/apps/team-types'
import { expect } from './acceptance-app'
import { contentText, type ModelRequest } from './acceptance-model'

export interface AwareTeam {
  team: Team
  /** The conversation the work belongs to, opened first. */
  intended: { epochId: string; label: string }
  /** A newer, unrelated conversation. */
  unrelated: { epochId: string; label: string }
}

/** Everything the model was given for a turn: its system prompt and its messages. */
export function promptOf(request: ModelRequest): string {
  return `${contentText(request.body.system)}\n${request.text}`
}

export function hasOperateHalo(request: ModelRequest): boolean {
  return request.tools.some(name => name.endsWith('__halo_api_ref'))
}

/** A self-API call the way the manual shows it, run through the engine's own shell. */
export function selfApi(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): string {
  const auth = '-H "Authorization: Bearer $HALO_API_TOKEN"'
  if (method === 'GET') return `curl -s "$HALO_API_URL${path}" ${auth}`
  return `curl -sX POST "$HALO_API_URL${path}" ${auth} -H "Content-Type: application/json" -d '${JSON.stringify(body ?? {})}'`
}

export async function installTeammate(page: Page, spaceId: string, name: string, systemPrompt: string): Promise<string> {
  const installed = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.appInstall({
    spaceId: input.spaceId,
    spec: {
      spec_version: '1.0', type: 'automation', version: '1.0.0', name: input.name, author: 'Acceptance author',
      description: 'An isolated teammate for team awareness.', system_prompt: input.systemPrompt,
      subscriptions: [], requires: {}, config_schema: [], permissions: [],
    },
  }), { spaceId, name, systemPrompt })
  expect(installed.success, 'A teammate must be installed through production orchestration').toBe(true)
  const appId = (installed.data as { appId: string }).appId
  const quiet = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appUpdateOverrides({
    appId, overrides: { notificationLevel: 'none', memory: { enabled: false, autoConsolidate: false } },
  }), appId)
  expect(quiet.success).toBe(true)
  return appId
}

export async function createAwareTeam(page: Page, input: {
  spaceId: string; name: string; askerAppId: string; askerRole: string; teammateAppId: string; teammateRole: string
  intendedLabel: string; unrelatedLabel: string
}): Promise<AwareTeam> {
  const created = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.teamCreate({ input }), {
    name: input.name, goal: 'Ship isolated work without mixing its conversations.', owningSpaceId: input.spaceId,
    memberSourcing: 'manual' as const, collabMode: 'free' as const, escalationRouting: 'user' as const, leadAppId: input.askerAppId,
    members: [
      { appId: input.askerAppId, memberName: 'Coordinator', role: input.askerRole, duty: 'Coordinate the release.' },
      { appId: input.teammateAppId, memberName: 'Tester', role: input.teammateRole, duty: 'Verify finished requirements.' },
    ],
  })
  expect(created.success, 'The team must be created through production orchestration').toBe(true)
  const team = created.data as Team
  const open = async (title: string) => {
    const opened = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.teamOpenConversation(input), {
      teamId: team.id, title, memberAppId: input.teammateAppId,
    })
    expect(opened.success).toBe(true)
    return { epochId: (opened.data as { epochId: string }).epochId, label: title }
  }
  const intended = await open(input.intendedLabel)
  const unrelated = await open(input.unrelatedLabel)
  const listed = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.teamListConversations(id), team.id)
  expect(listed.success).toBe(true)
  const conversations = listed.data as TeamConversation[]
  expect(conversations.find(item => item.epochId === intended.epochId)).toMatchObject({ label: intended.label, completed: false })
  expect(conversations.find(item => item.epochId === unrelated.epochId)).toMatchObject({ label: unrelated.label, completed: false })
  return { team, intended, unrelated }
}

/** One member's stored messages in one conversation, read the way the team view reads them. */
export async function memberTranscript(page: Page, input: { appId: string; spaceId: string; teamId: string; epochId: string }) {
  const result = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.teamChatMessages(input), input)
  expect(result.success).toBe(true)
  return (result.data as Array<{ role: string; content: string }>).map(({ role, content }) => ({ role, content }))
}

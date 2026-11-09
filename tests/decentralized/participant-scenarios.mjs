import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { buildTeamSessionKey } from '@hello-halo/agent-sdk/collaboration/protocol'
import { PROJECT_ROOT, api, apiOk, pollUntil, sleep, detailOnAll, chatOnAll } from './_lib.mjs'

export const participantScenarioIds = ['P1', 'P2', 'P3']

export async function assertParticipantScopeAbsent(node, scopePath, message) {
  const response = await api(node, 'GET', scopePath)
  assert.equal(response.status, 200, `Private scope lookup failed: ${response.error ?? response.status}`)
  assert.equal(response.json?.success, true, 'Private scope lookup did not return a successful API envelope.')
  assert.equal(response.json.data, null, message)
}

export async function startParticipantModel(outputDirectory) {
  const { build } = await import('esbuild')
  await fs.mkdir(outputDirectory, { recursive: true })
  const output = path.join(outputDirectory, 'participant-model.mjs')
  await build({ entryPoints: [path.join(PROJECT_ROOT, 'tests/e2e/fixtures/acceptance-federated-participants.ts')],
    outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { startFederatedParticipantModel } = await import(pathToFileURL(output).href)
  const fixture = await startFederatedParticipantModel()
  for (const name of ['HALO_TEST_MODEL_API_KEY', 'HALO_TEST_MODEL_BASE_URL', 'HALO_TEST_MODEL_ID', 'HALO_TEST_MODEL_PROVIDER', 'HALO_TEST_SIGNED_IN_SOURCE', 'HALO_TEST_OAUTH_SOURCE']) process.env[name] = ''
  Object.assign(process.env, { HALO_TEST_API_KEY: 'acceptance-scripted-cluster', HALO_TEST_API_URL: fixture.model.url,
    HALO_TEST_MODEL: 'gpt-4o', HALO_TEST_PROVIDER: 'openai', HALO_TEST_API_TYPE: 'chat_completions', HALO_TEST_SDK_ENGINE: 'halo' })
  return {
    ...fixture,
    async close() {
      await fixture.close()
      await fs.writeFile(path.join(outputDirectory, 'participant-model-evidence.json'), JSON.stringify({ errors: [...fixture.errors, ...fixture.model.errors], exchanges: fixture.model.exchanges }, null, 2))
    },
  }
}

export async function runParticipantScenarios({ host, joiners, fixture, buildOffice, reporter, want }) {
  const selected = participantScenarioIds.filter(want)
  if (!selected.length) return
  if (!fixture) {
    for (const id of selected) reporter.skip(id, 'Select the scripted participant group separately; acceptance runs group model modes automatically.')
    return
  }
  assert(joiners.length >= 2, 'Internal assistant isolation requires authority, owner and observer nodes.')
  for (const node of [host, ...joiners.slice(0, 2)]) {
    const engine = await apiOk(node, 'GET', '/api/agent/engine-availability')
    assert.equal(engine.activeEngine, 'halo', 'The participant scenario must execute Halo SDK, without fallback.')
    assert.equal(engine.degradedFrom, null)
  }
  for (const nativeId of selected) await reporter.run(nativeId, async mark => {
    const action = nativeId === 'P1' ? 'exchange' : nativeId === 'P2' ? 'stop' : 'delete'
    const id = randomUUID(), marker = randomUUID()
    const nodes = [host, joiners[0], joiners[1]], owner = joiners[0]
    const office = await buildOffice(host, joiners.slice(0, 2), nativeId)
    const teamId = office.officeId, parent = office.broughtAppIds[0]
    assert(await pollUntil(async () => {
      const detail = await apiOk(owner, 'GET', `/api/teams/${teamId}/detail`)
      return detail?.members?.some(member => member.appId === parent && member.origin !== 'remote')
    }, { timeoutMs: 20000, intervalMs: 250 }), 'The member owner has not materialized its joined membership.')
    // Joining starts with read-only lending; the owner explicitly authorizes this fixture's delegation and file work.
    const grant = await apiOk(owner, 'PATCH', `/api/teams/${teamId}/members/${parent}`, {
      delegatedPolicy: { allowedTools: ['Read', 'Write'], allowCollaboration: true },
    })
    assert.equal(grant.delegatedPolicy?.allowCollaboration, true, 'The member owner did not authorize collaboration.')
    assert.deepEqual(grant.delegatedPolicy.allowedTools, ['Read', 'Write'])
    const initial = await detailOnAll(nodes, teamId)
    const standing = initial.map(value => value.detail.members.map(member => member.appId).sort())
    const lead = initial[0].detail.team.leadAppId
    const work = await apiOk(host, 'POST', `/api/teams/${teamId}/conversations`, { title: `Participant work ${nativeId}` })
    const epochId = work.epochId
    fixture.register({ id, marker, file: `evidence-${id}.txt`, lead, action })
    const fixtureErrorsBefore = fixture.errors.length
    const providerErrorsBefore = fixture.model.errors.length
    const errorsBefore = fixtureErrorsBefore + providerErrorsBefore
    const assertModel = () => {
      const errors = [...fixture.errors.slice(fixtureErrorsBefore), ...fixture.model.errors.slice(providerErrorsBefore)]
      assert.equal(errors.length, 0, errors.join('\n') || 'The scripted provider failed.')
    }
    const send = async (appId, message) => {
      const result = await apiOk(host, 'POST', `/api/teams/${teamId}/members/${appId}/send`, { epochId, message })
      assertModel()
      assert.equal(result?.ok, true, `Member send was refused: app=${appId} epoch=${epochId} reason=${result?.reason ?? 'unknown'}`)
      return result
    }
    const hasReply = async (appId, expected, readers = nodes) => {
      let observed = []
      const result = await pollUntil(async () => {
        assertModel()
        const chats = await chatOnAll(readers, teamId, appId, epochId)
        observed = chats.map(chat => ({ node: chat.node.index, status: chat.status, error: chat.error,
          rows: Array.isArray(chat.messages) ? chat.messages.length : null,
          expectedReply: Array.isArray(chat.messages) && chat.messages.some(message => message.role === 'assistant' && message.content.includes(expected)) }))
        return observed.every(value => value.status === 200 && value.expectedReply) ? chats : null
      }, { timeoutMs: 45000, intervalMs: 500 })
      if (!result) console.error(`[ParticipantScenario] History check failed: case=${nativeId} app=${appId} epoch=${epochId}`, JSON.stringify(observed))
      return result
    }
    await send(lead, fixture.prompt(id, 'lead'))
    assert(await hasReply(lead, `SOURCE_READY_${id}`), 'The authority source did not initialize.')
    await send(parent, fixture.prompt(id, 'parent'))
    const child = await pollUntil(() => { assertModel(); return fixture.child(id) }, { timeoutMs: 45000, intervalMs: 250 })
    assert(child, 'The owner did not create a temporary collaborator.')
    const sourceKey = buildTeamSessionKey(parent, teamId, epochId)
    const scopePath = `/api/teams/collab-for-conversation/${encodeURIComponent(sourceKey)}`
    const scope = await pollUntil(async () => {
      const value = await apiOk(owner, 'GET', scopePath)
      return value?.members?.some(member => member.appId === child) ? value : null
    }, { timeoutMs: 15000, intervalMs: 250 })
    assert(scope, 'The owner did not expose the internal scope through the source conversation lookup.')
    assert.notEqual(scope.teamId, teamId, 'The helper reused the public team.')
    assert.notEqual(scope.epochId, epochId, 'The helper reused the public epoch.')
    const assertPrivate = async () => {
      const after = await detailOnAll(nodes, teamId)
      assert.deepEqual(after.map(value => value.detail.members.map(member => member.appId).sort()), standing, 'Internal creation changed standing membership.')
      for (const node of nodes) {
        const roster = await apiOk(node, 'GET', `/api/teams/${teamId}/epochs/${epochId}/roster`)
        assert(Array.isArray(roster?.members), 'The public roster was unavailable.')
        assert(!roster.members.some(member => member.appId === child), 'The internal identity entered the public epoch roster.')
        const board = await apiOk(node, 'GET', `/api/teams/${teamId}/epochs/${epochId}/board`)
        assert(!JSON.stringify(board).includes(child), 'The public board disclosed the internal identity.')
        assert(!JSON.stringify(board).includes(`PRIVATE_FINDING_${id}`), 'A private finding entered the public board.')
        const history = await api(node, 'GET', `/api/teams/${teamId}/chat-messages?appId=${child}&epochId=${epochId}`)
        assert(history.status === 403 || history.status === 404 || history.json?.success === false
          || (Array.isArray(history.json?.data) && history.json.data.length === 0), 'Public team history disclosed the internal record.')
        const refused = await api(node, 'POST', `/api/teams/${teamId}/members/${child}/send`, { epochId, message: `FORBIDDEN_PUBLIC_SEND_${id}` })
        assert(refused.status === 403 || refused.status === 404 || refused.json?.success === false || refused.json?.data?.ok === false,
          'Public team send accepted an internal assistant handle.')
      }
      for (const node of [host, joiners[1]]) {
        await assertParticipantScopeAbsent(node, scopePath, 'The private scope identity replicated to another node.')
        const history = await api(node, 'GET', `/api/teams/${scope.teamId}/chat-messages?appId=${child}&epochId=${scope.epochId}`)
        assert(history.status === 403 || history.status === 404 || history.json?.success === false
          || (Array.isArray(history.json?.data) && history.json.data.length === 0), 'Another node read the private scope record.')
      }
    }
    await assertPrivate()

    if (action === 'exchange') {
      assert(await hasReply(parent, `HELPER_REVIEWED_${id}`, [owner]), 'The parent did not receive and inspect the internal result.')
      assert.deepEqual(fixture.seen(id), { returned: true, history: true, bytes: true, followedUp: false, summary: false })
      const finding = await pollUntil(async () => {
        const board = await apiOk(owner, 'GET', `/api/teams/${scope.teamId}/epochs/${scope.epochId}/board`)
        return board.findings.find(finding => finding.authorAppId === child && finding.ref)
      }, { timeoutMs: 15000, intervalMs: 250 })
      assert(finding, 'The helper did not retain its private published reference.')
      await send(parent, `FOLLOW_UP_PARENT_${id}`)
      assert(await hasReply(parent, `SUMMARY_SHARED_${id}`, [owner]), 'The parent did not continue its helper and share its own summary.')
      assert(await hasReply(lead, `SUMMARY_RECEIVED_${id}`), 'The remote public lead did not receive the parent summary.')
      assert.deepEqual(fixture.seen(id), { returned: true, history: true, bytes: true, followedUp: true, summary: true })
      assert(await pollUntil(async () => {
        const boards = await Promise.all(nodes.map(node => apiOk(node, 'GET', `/api/teams/${teamId}/epochs/${epochId}/board`)))
        return boards.every(board => board.findings.some(finding => finding.authorAppId === parent && finding.body === `PARENT_SUMMARY_${id}`))
      }, { timeoutMs: 20000, intervalMs: 500 }), 'The parent summary was not shared across the public board.')
      await send(lead, `VERIFY_ISOLATION_${id} ${JSON.stringify({ ref: finding.ref, member: child })}`)
      assert(await hasReply(lead, `ISOLATION_VERIFIED_${id}`), 'The public lead did not observe private artifact and record refusals.')
      await assertPrivate()
      const leadHistory = await chatOnAll([host], teamId, lead, epochId)
      assert(!JSON.stringify(leadHistory[0].messages).includes(`PRIVATE_DETAIL_${marker}`), 'Private file contents leaked to the public lead.')
      assert(!JSON.stringify(leadHistory[0].messages).includes(`HELPER_RESULT_${id}`), 'A private child result automatically reached the public lead.')
      const other = await apiOk(host, 'POST', `/api/teams/${teamId}/conversations`, { title: 'Independent control work' })
      assert(await pollUntil(async () => {
        const scopes = await Promise.all(nodes.map(node => apiOk(node, 'GET', `/api/teams/${teamId}/epochs/${other.epochId}/roster`)))
        return scopes.every(scope => scope && Array.isArray(scope.members) && !scope.members.some(member => member.appId === child))
      }, { timeoutMs: 20000, intervalMs: 500 }), 'The independent work was not replicated without the temporary participant.')
      for (const node of nodes) {
        const wrong = await api(node, 'GET', `/api/teams/${teamId}/chat-messages?appId=${child}&epochId=${other.epochId}`)
        assert(wrong.status !== 200 || wrong.json?.success === false || (Array.isArray(wrong.json?.data) && wrong.json.data.length === 0), 'A different work scope disclosed the child history.')
      }
      assert.equal(fixture.errors.length + fixture.model.errors.length, errorsBefore, 'The scripted provider observed a tool failure.')
      mark('PASS', 'standing cross-node work preserved; local helper return, private bytes/record and handle follow-up verified; only parent summary shared; public roster/history/send and artifact isolation verified')
      return
    }

    assert(await pollUntil(() => fixture.held(id), { timeoutMs: 30000, intervalMs: 250 }), 'The child never reached the controlled active response.')
    assert(await pollUntil(async () => {
      const roster = await apiOk(owner, 'GET', `/api/teams/${scope.teamId}/epochs/${scope.epochId}/roster`)
      return roster.roster.some(member => member.appId === child && member.status === 'working')
    }, { timeoutMs: 15000, intervalMs: 250 }), 'The owner did not see its active internal assistant.')
    if (action === 'stop') {
      await send(parent, `STOP_CHILD_${id}`)
      assert(await hasReply(parent, `STOP_CONFIRMED_${id}`), 'The real controller did not confirm the child stop.')
    } else {
      await apiOk(host, 'DELETE', `/api/teams/${teamId}`)
      assert(await pollUntil(async () => {
        const states = await Promise.all(nodes.map(node => api(node, 'GET', `/api/teams/${teamId}`)))
        return states.every(state => state.status === 404 || state.json?.success === false || state.json?.data == null)
      }, { timeoutMs: 20000, intervalMs: 500 }), 'Office deletion did not remove all node replicas after closure.')
      const parentApp = await apiOk(owner, 'GET', `/api/apps/${parent}`)
      assert(parentApp && parentApp.status !== 'uninstalled', 'Deleting the shared source removed the owner’s independent digital human.')
    }
    assert(await pollUntil(() => fixture.cancelled(id), { timeoutMs: 10000, intervalMs: 250 }), 'The owner did not cancel the actual held model stream.')
    const parentRequests = fixture.parentRequests(id)
    fixture.release(id)
    // Bound the observation beyond the existing remote turn-report window.
    await sleep(20000)
    assert.equal(fixture.parentRequests(id), parentRequests, 'An invalidated child result woke its parent again.')
    if (action === 'stop') {
      const roster = await apiOk(owner, 'GET', `/api/teams/${scope.teamId}/epochs/${scope.epochId}/roster`)
      assert(roster.roster.every(member => member.appId !== child || member.status !== 'working'), 'The stopped internal assistant still appeared working.')
      for (const appId of [parent, lead]) {
        const source = await chatOnAll([owner], teamId, appId, epochId)
        assert(Array.isArray(source[0].messages), 'The public source history was unavailable.')
        assert(!source[0].messages.some(message => message.content.includes(`LATE_RESULT_${marker}`)), 'The stopped child result leaked into public history.')
      }
      const history = await chatOnAll([owner], scope.teamId, child, scope.epochId)
      assert.equal(history[0].status, 200, `Stopped internal history unavailable: status=${history[0].status}, error=${history[0].error ?? 'none'}`)
      assert(Array.isArray(history[0].messages) && history[0].messages.length > 0, 'Stopping lost the internal assistant record.')
      await send(parent, `FRESH_AFTER_STOP_${id}`)
      assert(await hasReply(parent, `FRESH_RESPONSE_${id}`), 'A fresh human request could not continue the parent.')
      await assertPrivate()
    } else {
      await assertParticipantScopeAbsent(owner, scopePath, 'Deleting the public team retained its private helper scope.')
    }
    assert.equal(fixture.errors.length + fixture.model.errors.length, errorsBefore, 'The scripted provider observed a cancellation failure.')
    mark('PASS', `${action}: real owner execution cancelled; delayed provider completion did not wake source; scoped records ${action === 'stop' ? 'retained' : 'removed only after owner closure'}`)
  })
}

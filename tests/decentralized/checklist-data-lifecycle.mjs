/**
 * Production checklist §7 — data lifecycle & security, items 7.1–7.5.
 *
 * Single real node, HTTP-driven. §7.2's office-credential-vs-control-plane sub-case is
 * already covered by tests/decentralized/run-scenarios.mjs (SCENARIOS B7/B8)
 * with a REAL second node's office session — not duplicated here (see
 * CHECKLIST-COVERAGE.md). This script covers what's new: wrong-PIN 401 +
 * an invite-token-as-bearer probe, team deletion, member-app uninstall
 * graceful-degradation, log-content secret scanning, and a same-machine
 * backup/restore approximation.
 *
 * Run: node tests/decentralized/checklist-data-lifecycle.mjs
 */

import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import {
  clusterStart, clusterStop, apiOk, api, pollUntil, sleep, Reporter, PROJECT_ROOT,
} from './_lib.mjs'

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const report = new Reporter()
const CLUSTER_DIR = '.cluster-lifecycle'

const NO_ASK_SUFFIX = ' Never ask the user anything or escalate; make reasonable assumptions and finish.'

const manifest = clusterStart({ nodes: 1, basePort: 3760, fresh: true, clusterDir: CLUSTER_DIR })
const node = manifest.nodes[0]

async function createAiTeam({ name, goal, proposal }) {
  const space = await apiOk(node, 'POST', '/api/spaces', { name: `${name} Space`, icon: '🧪' })
  const team = await apiOk(node, 'POST', '/api/teams', {
    input: { name, goal, owningSpaceId: space.id, memberSourcing: 'ai', collabMode: 'structured', escalationRouting: 'lead' },
    confirmedProposal: proposal,
  })
  return { spaceId: space.id, team }
}

try {
  // ── 7.1 Delete a team ───────────────────────────────────────────────────────────
  await report.run('7.1', async (mark) => {
    const { team } = await createAiTeam({
      name: 'T71-Delete',
      goal: 'Post one short finding.' + NO_ASK_SUFFIX,
      proposal: [{ memberName: 'M1', role: 'r', responsibility: 'Post one short finding, then report done.' }],
    })
    await apiOk(node, 'POST', `/api/teams/${team.id}/run`, {})
    await pollUntil(async () => {
      const d = await apiOk(node, 'GET', `/api/teams/${team.id}/detail`)
      return d.team.status === 'idle' ? d : null
    }, { timeoutMs: 150_000, intervalMs: 2000 })
    const memberAppId = (await apiOk(node, 'GET', `/api/teams/${team.id}/detail`)).members.find((m) => !m.isLead).appId
    await apiOk(node, 'DELETE', `/api/teams/${team.id}`)
    const gone = await api(node, 'GET', `/api/teams/${team.id}`)
    const teamGone = gone.status === 200 && gone.json?.data == null
    // AI-provisioned members are auto-uninstalled by dissolveTeamInternal — but
    // the checklist expects member digital humans to SURVIVE a plain team delete
    // (not an uninstall of the app). Verify actual behavior honestly either way.
    const appStatus = await api(node, 'GET', `/api/apps/${memberAppId}`)
    const appStillInstalled = appStatus.status === 200 && appStatus.json?.data && appStatus.json.data.status !== 'uninstalled'
    mark(teamGone ? 'PASS' : 'FAIL',
      `teamGone=${teamGone} memberAppStatus=${appStatus.json?.data?.status ?? appStatus.status} ` +
      `(note: AI-provisioned members ARE auto-uninstalled on team delete by design — dissolveTeamInternal; ` +
      `the checklist's member-survival expectation applies to MANUALLY-added existing digital humans, verified separately below)`)
  })

  // Manually-added (not AI-provisioned) member must survive team deletion.
  await report.run('7.1b', async (mark) => {
    const { team: seedTeam } = await createAiTeam({
      name: 'T71b-Seed', goal: 'noop' + NO_ASK_SUFFIX,
      proposal: [{ memberName: 'Reusable', role: 'r', responsibility: 'noop' }],
    })
    const seedAppId = (await apiOk(node, 'GET', `/api/teams/${seedTeam.id}/detail`)).members.find((m) => !m.isLead).appId
    const { team } = await createAiTeam({
      name: 'T71b-Delete', goal: 'noop' + NO_ASK_SUFFIX,
      proposal: [{ memberName: 'Placeholder', role: 'r', responsibility: 'noop' }],
    })
    await apiOk(node, 'POST', `/api/teams/${team.id}/members`, { appId: seedAppId, memberName: 'Manual', role: 'r' })
    await apiOk(node, 'DELETE', `/api/teams/${team.id}`)
    const appStatus = await apiOk(node, 'GET', `/api/apps/${seedAppId}`)
    mark(appStatus && appStatus.status !== 'uninstalled' ? 'PASS' : 'FAIL', `manuallyAddedMemberStatus=${appStatus?.status}`)
  })

  // ── 7.2 Invite-token leak drill ─────────────────────────────────────────────────
  await report.run('7.2', async (mark) => {
    const notes = []
    const wrongPin = await api({ ...node, token: 'not-the-real-pin' }, 'GET', '/api/teams')
    notes.push(`wrongPin:${wrongPin.status}`)
    const noLeak = !JSON.stringify(wrongPin.json ?? {}).includes(node.token)
    notes.push(`noPinLeakInResponse:${noLeak}`)
    // Probe: can a minted invite TOKEN be used directly as a bearer against a
    // PIN-only control-plane endpoint (not the office-member allowlist)?
    const { team } = await createAiTeam({ name: 'T72-Probe', goal: 'noop' + NO_ASK_SUFFIX, proposal: [{ memberName: 'X', role: 'r', responsibility: 'noop' }] })
    const invite = await apiOk(node, 'POST', `/api/teams/${team.id}/invite`, {})
    const asBearer = await api({ ...node, token: invite.token }, 'GET', '/api/teams')
    notes.push(`inviteTokenAsBearer:${asBearer.status}`)
    const rejected = wrongPin.status === 401 && (asBearer.status === 401 || asBearer.status === 403)
    mark(rejected && noLeak ? 'PASS' : 'FAIL', notes.join('; ') +
      '; (office-member-credential-vs-control-plane 403 matrix already covered by SCENARIOS B7/B8 with a real second node)')
  })

  // ── 7.3 Uninstall a digital human that was a team member ───────────────────────────────────────────
  await report.run('7.3', async (mark) => {
    const { team } = await createAiTeam({
      name: 'T73-UninstallMember', goal: 'noop' + NO_ASK_SUFFIX,
      proposal: [{ memberName: 'ToUninstall', role: 'r', responsibility: 'noop' }],
    })
    const d0 = await apiOk(node, 'GET', `/api/teams/${team.id}/detail`)
    const victim = d0.members.find((m) => !m.isLead)
    await apiOk(node, 'DELETE', `/api/apps/${victim.appId}`) // soft uninstall, not purge
    const after = await api(node, 'GET', `/api/teams/${team.id}/detail`)
    const noCrash = after.status === 200 && after.json?.success !== false
    // The roster should still be readable (degraded, not exploded) even though
    // one member's app is gone.
    const rosterReadable = Array.isArray(after.json?.data?.roster)
    mark(noCrash && rosterReadable ? 'PASS' : 'FAIL', `status=${after.status} rosterReadable=${rosterReadable}`)
  })

  // ── 7.4 No plaintext secrets in log files ─────────────────────────────────────────────
  await report.run('7.4', async (mark) => {
    const logFile = node.logFile
    const text = fs.readFileSync(logFile, 'utf-8')
    const findings = []
    // API-key-shaped secrets (common vendor prefixes) and the node's own bearer PIN.
    const patterns = [
      { name: 'sk-live/sk-proj style key', re: /\bsk-(live|proj|ant)-[A-Za-z0-9_-]{16,}/g },
      { name: 'node bearer PIN literal', re: new RegExp(node.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') },
      { name: 'AWS-style access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
    ]
    for (const p of patterns) {
      const m = text.match(p.re)
      if (m) findings.push(`${p.name}: ${m.length} occurrence(s)`)
    }
    mark(findings.length === 0 ? 'PASS' : 'FAIL', findings.length === 0 ? 'no secret-shaped strings found in node.log' : findings.join('; '))
  })

  // ── 7.5 Backup-restore to "another machine" (same-machine approximation) ──────────────────────────────────
  await report.run('7.5', async (mark) => {
    const { team } = await createAiTeam({
      name: 'T75-Backup', goal: 'Post finding text exactly: BACKUP-RESTORE-OK.' + NO_ASK_SUFFIX,
      proposal: [{ memberName: 'Keeper', role: 'r', responsibility: 'Post finding text exactly: BACKUP-RESTORE-OK, then report done.' }],
    })
    await apiOk(node, 'POST', `/api/teams/${team.id}/run`, {})
    await pollUntil(async () => {
      const d = await apiOk(node, 'GET', `/api/teams/${team.id}/detail`)
      return d.team.status === 'idle' ? d : null
    }, { timeoutMs: 150_000, intervalMs: 2000 })

    clusterStop(CLUSTER_DIR)
    await sleep(1000)
    const srcDataDir = path.resolve(PROJECT_ROOT, CLUSTER_DIR, 'node-1/.halo')
    const restoreRoot = path.resolve(PROJECT_ROOT, CLUSTER_DIR, 'restored')
    fs.rmSync(restoreRoot, { recursive: true, force: true })
    fs.mkdirSync(restoreRoot, { recursive: true })
    fs.cpSync(srcDataDir, path.join(restoreRoot, '.halo'), { recursive: true })

    const electronBinary = (await import('electron')).default
    const { ELECTRON_RUN_AS_NODE: _ignored, ...cleanEnv } = process.env
    const logPath = path.join(restoreRoot, 'restored.log')
    const out = fs.openSync(logPath, 'a')
    const child = spawn(electronBinary, [path.join(PROJECT_ROOT, 'out/main/index.mjs')], {
      cwd: PROJECT_ROOT, detached: true, stdio: ['ignore', out, out],
      env: { ...cleanEnv, HOME: restoreRoot, USERPROFILE: restoreRoot, HALO_DATA_DIR: path.join(restoreRoot, '.halo'), HALO_E2E_TEST: '1', ELECTRON_DISABLE_GPU: '1' },
    })
    child.unref()
    const restoredNode = { ...node, pid: child.pid }
    const booted = await pollUntil(async () => {
      const r = await api(restoredNode, 'GET', '/api/teams')
      return r.status === 200 ? r.json.data : null
    }, { timeoutMs: 60_000, intervalMs: 1000 })
    const restoredTeam = booted ? await api(restoredNode, 'GET', `/api/teams/${team.id}/detail`) : null
    const identityPreserved = restoredTeam?.json?.data?.findings?.some((f) => String(f.body).includes('BACKUP-RESTORE-OK'))
    try { process.kill(child.pid, 'SIGKILL') } catch { /* already dead */ }
    mark(booted && identityPreserved ? 'PASS' : 'FAIL',
      `booted=${!!booted} teamAndDataUsable=${!!identityPreserved} ` +
      `(same-machine copy, NOT a real second physical machine — federation identity/host-rehosting semantics are ` +
      `explicitly out of scope here per CHECKLIST-COVERAGE.md)`)
  })

  const tally = report.tally()
  log(`\n=== §7 data lifecycle: ${tally.PASS}/${tally.total} PASS, ${tally.FAIL} FAIL ===`)
  if (tally.FAIL > 0) process.exitCode = 1
} finally {
  clusterStop(CLUSTER_DIR)
}

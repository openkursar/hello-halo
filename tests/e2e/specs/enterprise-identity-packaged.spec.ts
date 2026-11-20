/**
 * Enterprise identity in an installed (packaged) Halo against a local mock
 * identity stack:
 *
 *   Settings QR sign-in (scan → confirm on the "phone") → a credential-bound
 *   preset CLI (gitbeaker) reaches the mock intranet API from the AI terminal
 *   and from a chat session, while the session environment never holds the
 *   credential and an unbound preset (cowsay) gets nothing → sign-out, session
 *   expiry and server-side revocation stop new invocations → declined,
 *   cancelled and expired QR codes are reported → a method with fewer
 *   capabilities only activates the matching tools.
 *
 * Prerequisites (outside this spec, see the evidence README):
 *   - a package whose product.json names a mock provider under
 *     `enterpriseIdentity.provider` and binds `npm.gitbeaker-cli` (capability
 *     intranet, audience code-host, env GITBEAKER_TOKEN) plus a mail-only binding
 *     for a tool that is not installed; gitbeaker and cowsay are injected into
 *     resources/cli-preset;
 *   - the mock provider offers two QR methods: the first grants intranet and
 *     mail, the second intranet only;
 *   - the mock identity server on IDENTITY_MOCK_URL (default 127.0.0.1:18295).
 * The identity protocol is simulated; only the client contract is real.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { EnterpriseIdentityState, EnterpriseLoginPollResult } from '../../../src/shared/types/enterprise-identity'
import { test, expect } from '../fixtures/electron-packaged'
import { navigateToSettings } from '../fixtures/helpers'
import { initialUserInput, startAcceptanceModel, type ModelRequest, type ModelReply } from '../fixtures/acceptance-model'
import { planModelTool } from '../fixtures/acceptance-tool-discovery'
import { startProbe, useScriptedModel } from '../fixtures/cli-tools-entries'

test.setTimeout(20 * 60 * 1000)

const MOCK = process.env.IDENTITY_MOCK_URL ?? 'http://127.0.0.1:18295'
const EVIDENCE = process.env.IDENTITY_E2E_EVIDENCE ?? ''
const GB = 'npm.gitbeaker-cli'
const MAIL_PLACEHOLDER = 'npm.mail-cli-placeholder'

type Api = HaloAPI
const halo = (page: Page) => ({
  state: () => page.evaluate(() => (globalThis as unknown as { halo: Api }).halo.enterpriseIdentityState()),
  begin: (methodId: string) => page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.enterpriseIdentityBegin(input), { methodId }),
  poll: (flowId: string) => page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.enterpriseIdentityPoll(input), { flowId }),
  signOut: () => page.evaluate(() => (globalThis as unknown as { halo: Api }).halo.enterpriseIdentitySignOut()),
})

function data<T>(label: string, response: { success: boolean; data?: unknown; error?: string }): T {
  expect(response.success, `${label}: ${response.error ?? ''}`).toBe(true)
  return response.data as T
}

async function mock(route: string, body?: unknown): Promise<any> {
  const res = await fetch(`${MOCK}${route}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return res.json()
}

/** Runs one shell line in a new AI terminal and returns what it printed between two markers. */
async function shell(page: Page, command: string): Promise<string> {
  const created = await page.evaluate(() => (globalThis as unknown as { halo: Api }).halo.createTerminal({ spaceId: 'halo-temp' }))
  expect(created.success, `createTerminal: ${created.error ?? ''}`).toBe(true)
  const sessionId = await page.evaluate(async () => {
    const result = await (globalThis as unknown as { halo: Api }).halo.listTerminals()
    return (result.data as Array<{ id: string }>).at(-1)!.id
  })
  const line = `printf 'R_%s\\n' BEGIN; ${command}; printf 'R_%s\\n' END`
  await page.evaluate(input => (globalThis as unknown as { halo: Api }).halo.terminalInput({ sessionId: input.sessionId, data: `${input.line}\r` }), { sessionId, line })
  let out = ''
  await expect.poll(async () => {
    const replay = await page.evaluate(id => (globalThis as unknown as { halo: Api }).halo.getTerminalReplay({ sessionId: id }), sessionId)
    const raw = typeof replay.data === 'string' ? replay.data : JSON.stringify(replay.data)
    const text = raw.replace(/\\r\\n|\\n|\r/g, '\n').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\\"/g, '"')
    const match = /^R_BEGIN$([\s\S]*?)^R_END$/m.exec(text)
    out = match ? match[1].trim() : ''
    return Boolean(match)
  }, { timeout: 60000, message: `terminal: ${command}` }).toBe(true)
  await page.evaluate(id => (globalThis as unknown as { halo: Api }).halo.killTerminal({ sessionId: id }), sessionId)
  return out
}

const GB_CALL = 'gb users show-current-user 2>&1 | head -c 300; echo'
/** Session tokens and login tickets the mock stack issues; none may leak. */
const TICKET = '\\b[A-Z]{3}-[0-9a-f]{32}\\b'
/** Any identity material in state or model requests (prefixes are enough there). */
const IDENTITY_MATERIAL = new RegExp(`glmock-|hcs-|${TICKET}`)
/** Full tokens only, for scanning every file the app wrote. */
const IDENTITY_TOKEN = new RegExp(`hcs-[0-9a-f]{48}|${TICKET}`)

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Matches the API reply naming `account` as the current user. */
const userIs = (account: string, flags = '') => new RegExp(`"username": ?"${escapeRegExp(account)}"`, flags)

/** Signs in through the API with the mock phone confirming; used where the UI flow is already covered. */
async function apiSignIn(page: Page, methodId: string): Promise<EnterpriseIdentityState> {
  const begun = data<EnterpriseIdentityState>('begin', await halo(page).begin(methodId))
  const flowId = begun.flow!.flowId
  await mock('/phone/confirm', { sid: 'latest' })
  let result: EnterpriseLoginPollResult | undefined
  for (let i = 0; i < 5; i++) {
    result = data<EnterpriseLoginPollResult>('poll', await halo(page).poll(flowId))
    if (!['pending', 'scanned'].includes(result.outcome)) break
  }
  expect(result?.outcome).toBe('ready')
  return result!.state
}

async function screenshots(page: Page, dir: string, prefix: string): Promise<string[]> {
  if (!dir) return []
  fs.mkdirSync(dir, { recursive: true })
  const files: string[] = []
  // Electron pages report no viewport size; take the window's own size so it can be restored.
  const original = page.viewportSize() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  for (const theme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.evaluate(value => {
      document.documentElement.classList.toggle('light', value === 'light')
      document.documentElement.classList.toggle('theme-dark', value === 'dark')
      document.documentElement.style.colorScheme = value
    }, theme)
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(viewport.width)
      const target = page.getByTestId('enterprise-identity-dialog').or(page.getByTestId('enterprise-identity-section')).first()
      await target.evaluate(element => element.scrollIntoView({ block: 'start' }))
      // Measured after two frames so the layout reflects the new width.
      const overflow = await target.evaluate(element => new Promise<boolean>(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(element.scrollWidth > element.clientWidth + 1)))
      }))
      expect.soft(overflow, `${prefix}/${theme}/${viewport.width} horizontal overflow`).toBe(false)
      const file = path.join(dir, `${prefix}-${theme}-${viewport.width}.png`)
      await page.screenshot({ path: file })
      files.push(path.basename(file))
    }
  }
  await page.emulateMedia({ colorScheme: null })
  await page.setViewportSize(original)
  expect(await page.evaluate(() => window.innerWidth)).toBe(original.width)
  return files
}

test.describe('Enterprise identity with Halo', () => {
  test.use({ sdkEngine: 'halo', hostCommands: 'system-only' })

  test('QR sign-in, bound CLI credential, sign-out, expiry, revocation and failed scans', async ({ electronApp, window }) => {
    expect(await electronApp.evaluate(({ app }) => app.isPackaged)).toBe(true)
    expect((await mock('/health')).ok, `mock identity server on ${MOCK}`).toBe(true)
    await mock('/admin/reset', {})
    const runtime = await electronApp.evaluate(({ app }) => ({ userData: app.getPath('userData'), home: process.env.HOME ?? '' }))
    const credentialFile = path.join(runtime.userData, 'enterprise-identity', 'code-host.json')
    const shots = EVIDENCE ? path.join(EVIDENCE, 'screenshots') : ''
    const steps: Array<{ step: string; result: unknown }> = []
    const record = (step: string, result: unknown) => { steps.push({ step, result }) }
    const seenTokens = new Set<string>()
    const readToken = () => {
      const raw = JSON.parse(fs.readFileSync(credentialFile, 'utf8')) as { token: string; expiresAt: number }
      seenTokens.add(raw.token)
      return raw
    }

    // Scripted model for the chat entry: one Bash call, then done.
    const model = await startAcceptanceModel()
    const chatResults = new Map<string, string>()
    const chatCommands = new Map<string, string>()
    model.respond((request: ModelRequest): ModelReply => {
      const found = /CLI_PROBE\[chat:([A-Za-z0-9_-]+)\]/.exec(initialUserInput(request))
      if (!found) return { text: 'ok' }
      const round = found[1]
      const id = `identity-${round}`
      const result = request.toolResults.find(item => item.id === id)
      if (result) { chatResults.set(round, result.text); return { text: 'Done.' } }
      const input = { command: chatCommands.get(round) ?? 'true', description: 'Check the company tool' }
      const shellTool = request.tools.find(tool => tool === 'Bash' || tool === 'bash')
      if (shellTool) return { tools: [{ id, name: shellTool, input }] }
      const next = planModelTool(request, 'Bash', input, id)
      if ('error' in next) return { text: next.error }
      return { tools: [next.call] }
    })
    const chat = async (round: string, command: string) => {
      chatCommands.set(round, command)
      await startProbe(window, 'chat', round)
      await expect.poll(() => chatResults.has(round), { timeout: 150000, message: `chat ${round}` }).toBe(true)
      return chatResults.get(round)!
    }

    try {
      await useScriptedModel(window, model.url)
      await window.reload()

      // ---- Before sign-in: the section is offered, nothing is active, the bound CLI is rejected.
      await navigateToSettings(window)
      const section = window.getByTestId('enterprise-identity-section')
      await expect(section).toBeVisible()
      await expect(window.getByTestId('enterprise-identity-status')).toHaveAttribute('data-status', 'signed-out')
      let state = data<EnterpriseIdentityState>('state', await halo(window).state())
      record('state:initial', { status: state.status, methods: state.methods.map(m => `${m.id}:${m.label}`), boundTools: state.boundTools })
      expect(state.methods).toHaveLength(2)
      const [fullMethod, narrowMethod] = state.methods.map(m => m.id)
      expect(state.boundTools.every(tool => !tool.active)).toBe(true)
      const before = await shell(window, `command -v gb; command -v cowsay; ${GB_CALL}`)
      record('terminal:before-sign-in', before)
      expect(before).toMatch(/401 Unauthorized/)
      expect(fs.existsSync(credentialFile)).toBe(false)
      record('screenshots:signed-out', await screenshots(window, shots, '01-signed-out'))

      // ---- QR sign-in through Settings: scan, confirm on the phone, ready.
      await window.getByTestId(`enterprise-identity-method-${fullMethod}`).click()
      await expect(window.getByTestId('enterprise-identity-qr')).toBeVisible()
      await expect(window.getByTestId('enterprise-identity-instruction')).toHaveText('Scan with your company app to sign in')
      record('screenshots:qr', await screenshots(window, shots, '02-qr'))
      const qrSession = await mock('/admin/sessions/latest')
      expect(qrSession.status).toBe('pending')
      await mock('/phone/scan', { sid: 'latest' })
      await expect(window.getByTestId('enterprise-identity-instruction')).toHaveText('Waiting for confirmation on your phone', { timeout: 15000 })
      record('screenshots:scanned', await screenshots(window, shots, '03-scanned'))
      await mock('/phone/confirm', { sid: 'latest' })
      await expect(window.getByTestId('enterprise-identity-success')).toBeVisible({ timeout: 15000 })
      record('screenshots:success', await screenshots(window, shots, '04-success'))
      await window.getByTestId('enterprise-identity-success').getByRole('button', { name: 'Done' }).click()
      await expect(window.getByTestId('enterprise-identity-status')).toHaveAttribute('data-status', 'ready')
      state = data<EnterpriseIdentityState>('state', await halo(window).state())
      record('state:ready', { status: state.status, account: state.account, methodId: state.methodId, capabilities: state.capabilities, boundTools: state.boundTools, flow: state.flow })
      const account = state.account?.id ?? ''
      expect(account).not.toBe('')
      expect(state.boundTools.find(tool => tool.toolId === GB)?.active).toBe(true)
      expect(state.boundTools.find(tool => tool.toolId === MAIL_PLACEHOLDER)?.active).toBe(true)
      expect(JSON.stringify(state)).not.toMatch(IDENTITY_MATERIAL)
      record('screenshots:ready', await screenshots(window, shots, '05-ready'))

      // ---- The credential file: owner-only, capped at the session end.
      const cred = readToken()
      const mode = fs.statSync(credentialFile).mode & 0o777
      const dirMode = fs.statSync(path.dirname(credentialFile)).mode & 0o777
      record('credential-file', { mode: mode.toString(8), dirMode: dirMode.toString(8), expiresAt: cred.expiresAt, sessionExpiresAt: state.expiresAt })
      expect(mode).toBe(0o600)
      expect(dirMode).toBe(0o700)
      expect(cred.expiresAt).toBeLessThanOrEqual(state.expiresAt!)

      // ---- AI terminal: gb reaches the intranet API; the shell itself has no credential; cowsay is unbound.
      const terminal = await shell(window, [
        `printf 'TOKEN_VARS=%s\\n' "$(env | grep -c '^GITBEAKER_TOKEN=')"`,
        GB_CALL,
        `GITBEAKER_TOKEN=forged-by-shell ${GB_CALL}`,
        `cowsay moo | head -3`,
        `printf 'BIN=%s\\n' "$HALO_CLI_TOOLS_BIN"`,
      ].join('; '))
      record('terminal:signed-in', terminal)
      expect(terminal).toMatch(/TOKEN_VARS=0/)
      expect(terminal.match(userIs(account, 'g'))?.length, 'gb succeeds, and an inherited value does not override the binding').toBe(2)
      expect(terminal).toMatch(/moo/)
      const bin = /BIN=(.*)/.exec(terminal)?.[1]?.trim() ?? ''
      expect(fs.existsSync(bin)).toBe(true)
      const view = path.dirname(bin)
      const gbLauncher = fs.readFileSync(path.join(bin, 'gb'), 'utf8')
      const cowsayLauncher = fs.readFileSync(path.join(bin, 'cowsay'), 'utf8')
      const toolsMd = fs.readFileSync(path.join(view, 'TOOLS.md'), 'utf8')
      const credentialPreloads = fs.readdirSync(view).filter(name => /^credential-\d+\.cjs$/.test(name))
      record('view', { view, credentialPreloads, gbUsesPreload: /credential-\d+\.cjs/.test(gbLauncher), cowsayUsesPreload: /credential-\d+\.cjs/.test(cowsayLauncher), toolsMdGbRow: toolsMd.split('\n').find(line => line.includes('`gb`')) })
      expect(credentialPreloads).toHaveLength(1)
      expect(gbLauncher).toMatch(/credential-\d+\.cjs/)
      expect(cowsayLauncher).not.toMatch(/credential-\d+\.cjs/)
      expect(toolsMd).toMatch(/enterprise sign-in \(provided by Halo\)/)

      // ---- Chat session: same result through the engine's shell; the prompt never holds the credential.
      const chatOut = await chat('signed', `printf 'TOKEN_VARS=%s\\n' "$(env | grep -c '^GITBEAKER_TOKEN=')"; ${GB_CALL}; cowsay hi | head -2`)
      record('chat:signed-in', chatOut)
      expect(chatOut).toMatch(/TOKEN_VARS=0/)
      expect(chatOut).toMatch(userIs(account))

      // ---- Sign-out from Settings: the file goes, the next call is rejected, the server revoked the token.
      await navigateToSettings(window)
      await window.getByRole('button', { name: 'Sign out', exact: true }).click()
      await expect(window.getByTestId('enterprise-identity-status')).toHaveAttribute('data-status', 'signed-out')
      expect(fs.existsSync(credentialFile)).toBe(false)
      const afterSignOut = await shell(window, GB_CALL)
      record('terminal:after-sign-out', afterSignOut)
      expect(afterSignOut).toMatch(/401 Unauthorized/)
      const presentedAfterSignOut = await fetch(`${MOCK}/api/v4/user`, { headers: { 'private-token': cred.token } })
      record('server:old-token-after-sign-out', presentedAfterSignOut.status)
      expect(presentedAfterSignOut.status).toBe(401)

      // ---- Session expiry decided by the service.
      await mock('/admin/config', { sessionTtlMs: 20000 })
      state = await apiSignIn(window, fullMethod)
      readToken()
      const beforeExpiry = await shell(window, GB_CALL)
      expect(beforeExpiry).toMatch(userIs(account))
      // Settings opened while signed in re-reads the state when the session is due to end.
      await window.reload()
      await navigateToSettings(window)
      await expect(window.getByTestId('enterprise-identity-status')).toHaveAttribute('data-status', 'ready')
      await expect.poll(async () => data<EnterpriseIdentityState>('state', await halo(window).state()).status, { timeout: 40000, message: 'session expiry' }).toBe('expired')
      expect(fs.existsSync(credentialFile)).toBe(false)
      await expect(window.getByTestId('enterprise-identity-status')).toHaveAttribute('data-status', 'expired', { timeout: 10000 })
      record('screenshots:expired', await screenshots(window, shots, '06-expired'))
      const afterExpiry = await shell(window, GB_CALL)
      record('terminal:after-expiry', { beforeExpiry, afterExpiry })
      expect(afterExpiry).toMatch(/401 Unauthorized/)

      // ---- Revocation at the service while the client still shows ready.
      await mock('/admin/config', { sessionTtlMs: 30 * 60000 })
      await apiSignIn(window, fullMethod)
      readToken()
      expect(await shell(window, GB_CALL)).toMatch(userIs(account))
      const revoked = await mock('/admin/revoke-all', {})
      const afterRevoke = await shell(window, GB_CALL)
      record('terminal:after-server-revoke', { revoked, clientStatus: data<EnterpriseIdentityState>('state', await halo(window).state()).status, afterRevoke })
      expect(afterRevoke).toMatch(/401 Unauthorized/)
      data('sign-out', await halo(window).signOut())

      // ---- Failed scans in the dialog: declined, cancelled, QR code expired.
      await window.reload()
      await navigateToSettings(window)
      await window.getByTestId(`enterprise-identity-method-${fullMethod}`).click()
      await expect(window.getByTestId('enterprise-identity-qr')).toBeVisible()
      await mock('/phone/deny', { sid: 'latest' })
      await expect(window.getByTestId('enterprise-identity-error')).toContainText('Sign-in was declined on your phone', { timeout: 15000 })
      record('screenshots:denied', await screenshots(window, shots, '07-denied'))
      await window.getByTestId('enterprise-identity-error').getByRole('button', { name: 'Cancel' }).click()
      await expect(window.getByTestId('enterprise-identity-dialog')).toHaveCount(0)

      await window.getByTestId(`enterprise-identity-method-${fullMethod}`).click()
      await expect(window.getByTestId('enterprise-identity-qr')).toBeVisible()
      const cancelledId = (await mock('/admin/sessions/latest')).id
      await window.getByTestId('enterprise-identity-dialog').getByRole('button', { name: 'Close' }).click()
      await expect(window.getByTestId('enterprise-identity-dialog')).toHaveCount(0)
      await expect.poll(async () => (await mock('/admin/sessions/latest')).status, { timeout: 10000, message: 'closing the dialog cancels the attempt' }).toBe('cancelled')
      const lateConfirm = await mock('/phone/confirm', { sid: cancelledId })
      record('cancel', { sessionStatus: 'cancelled', lateConfirm })
      expect(lateConfirm.error).toMatch(/cannot confirm in cancelled/)
      await expect(window.getByTestId('enterprise-identity-status')).toHaveAttribute('data-status', 'signed-out')

      await mock('/admin/config', { qrTtlMs: 4000 })
      await window.getByTestId(`enterprise-identity-method-${narrowMethod}`).click()
      await expect(window.getByTestId('enterprise-identity-qr')).toBeVisible()
      await expect(window.getByTestId('enterprise-identity-error')).toContainText('QR code expired', { timeout: 20000 })
      record('screenshots:qr-expired', await screenshots(window, shots, '08-qr-expired'))
      await mock('/admin/config', { qrTtlMs: 120000 })

      // ---- "Try again" regenerates; the second method carries intranet only, so the mail binding stays inactive.
      await window.getByTestId('enterprise-identity-error').getByRole('button', { name: 'Try again' }).click()
      await expect(window.getByTestId('enterprise-identity-qr')).toBeVisible()
      await mock('/phone/scan', { sid: 'latest' })
      await mock('/phone/confirm', { sid: 'latest' })
      await expect(window.getByTestId('enterprise-identity-success')).toBeVisible({ timeout: 15000 })
      await window.getByTestId('enterprise-identity-success').getByRole('button', { name: 'Done' }).click()
      state = data<EnterpriseIdentityState>('state', await halo(window).state())
      record('state:narrow-method', { status: state.status, methodId: state.methodId, capabilities: state.capabilities, boundTools: state.boundTools })
      expect(state.methodId).toBe(narrowMethod)
      expect(state.capabilities).toEqual(['intranet'])
      expect(state.boundTools.find(tool => tool.toolId === GB)?.active).toBe(true)
      expect(state.boundTools.find(tool => tool.toolId === MAIL_PLACEHOLDER)?.active).toBe(false)
      await expect(window.locator('[data-testid="enterprise-identity-tool"][data-active="false"]')).toHaveCount(1)
      record('screenshots:narrow-ready', await screenshots(window, shots, '09-narrow-ready'))
      readToken()
      const narrowOut = await shell(window, GB_CALL)
      record('terminal:narrow-method', narrowOut)
      expect(narrowOut).toMatch(userIs(account))
      expect(fs.existsSync(path.join(runtime.userData, 'enterprise-identity', 'mail.json'))).toBe(false)

      // ---- No credential, proof or session token anywhere the app wrote, nor in any model request.
      const leaks: string[] = []
      const scan = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isSymbolicLink()) continue
          if (entry.isDirectory()) { scan(full); continue }
          if (full === path.join(runtime.userData, 'enterprise-identity', 'code-host.json')) continue
          const stat = fs.statSync(full)
          if (stat.size > 50 * 1024 * 1024) continue
          const text = fs.readFileSync(full).toString('latin1')
          for (const token of seenTokens) if (text.includes(token)) leaks.push(`${full}: tool credential`)
          if (IDENTITY_TOKEN.test(text)) leaks.push(`${full}: session token or ticket`)
        }
      }
      scan(runtime.home)
      if (!runtime.userData.startsWith(runtime.home)) scan(runtime.userData)
      const modelBodies = JSON.stringify(model.exchanges.map(exchange => exchange.request.body))
      for (const token of seenTokens) if (modelBodies.includes(token)) leaks.push('model request: tool credential')
      if (IDENTITY_MATERIAL.test(modelBodies)) leaks.push('model request: identity material')
      record('leak-scan', { tokensChecked: seenTokens.size, modelRequests: model.exchanges.length, leaks })
      expect(leaks).toEqual([])
      expect(model.errors).toEqual([])
      data('sign-out', await halo(window).signOut())
      expect(fs.existsSync(path.dirname(credentialFile))).toBe(false)
    } finally {
      const serverLog = await mock('/admin/log').catch(() => [])
      if (EVIDENCE) {
        fs.mkdirSync(EVIDENCE, { recursive: true })
        fs.writeFileSync(path.join(EVIDENCE, 'enterprise-identity-arm64.json'), JSON.stringify({ platform: `${process.platform}-${process.arch}`, finishedAt: new Date().toISOString(), steps, serverLog }, null, 2))
      }
      await model.close()
    }
  })
})

import { app } from 'electron'
import { spawn } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { stat } from 'node:fs/promises'
import type { BrowserContext } from '../ai-browser'
import { getHaloDir } from '../../foundation/config.service'
import { createHostChannel } from './channel'
import { runBrowserCommand } from './browser'
import { fetchForAdapter, grantSchema, type HostGrant } from './fetch'
import { runPageAdapter } from './page'
import { runAdapterHelper } from './helpers'
import { fail, MAX_BYTES } from './protocol'

const activeContexts = new WeakSet<BrowserContext>()
let activeCalls = 0

export interface WebCliInvocation {
  cliPath: string
  context: BrowserContext
  command: string
  args: Record<string, unknown>
  signal?: AbortSignal
  timeoutMs?: number
}

/** One invocation owns its child and channel; browser ownership stays with AI Browser. */
export async function runWebCli(input: WebCliInvocation): Promise<Record<string, unknown>> {
  if (activeContexts.has(input.context)) return fail('HOST_BUSY', 'Another WebCLI call is using this browser context. Retry after it finishes.')
  if (activeCalls >= 8) return fail('HOST_BUSY', 'The browser host has reached its concurrent call limit.')
  if (!isAbsolute(input.cliPath) || !(await stat(input.cliPath).catch(() => undefined))?.isFile()) return fail('HOST_CLI_INVALID', 'The launcher must supply an installed WebCLI entry file.')
  // Recheck after I/O so two simultaneous calls cannot both acquire the context.
  if (activeContexts.has(input.context) || activeCalls >= 8) return fail('HOST_BUSY', 'The browser context is busy.')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/.test(input.command)) return fail('INVALID_COMMAND', 'Use a WebCLI command name, not shell text.')
  const serialized = JSON.stringify(input.args)
  if (Buffer.byteLength(serialized) > 100000) return fail('HOST_PAYLOAD_TOO_LARGE', 'CLI arguments exceed the size limit.')
  input.signal?.throwIfAborted()
  activeContexts.add(input.context)
  activeCalls++
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('WebCLI invocation cancelled.'))
  const timeout = setTimeout(() => controller.abort(new Error('WebCLI invocation timed out; it was not retried.')), input.timeoutMs ?? 60000)
  input.signal?.addEventListener('abort', abort, { once: true })
  app.once('before-quit', abort)
  let channel: Awaited<ReturnType<typeof createHostChannel>> | undefined
  let grant: HostGrant | undefined
  let requestBusy = false
  let operationFailed = false
  try {
    channel = await createHostChannel(async request => {
      if (requestBusy) return fail('HOST_BUSY', 'Host operations must be sequential.')
      requestBusy = true
      try {
        if (request.operation === 'browser') {
          const command = String(request.command)
          if (input.command !== `browser.${command}` && !(input.command === 'host.catalog' && command === 'doctor')) return fail('HOST_CALL_MISMATCH', 'Host operation does not match the CLI invocation.')
          return await runBrowserCommand(input.context, command, request.args, controller.signal)
        }
        if (request.operation === 'adapter.prepare') {
          if (grant) return fail('HOST_GRANT_EXISTS', 'Adapter context was already initialized.')
          const { schemaVersion: _version, operation: _operation, ...value } = request
          const parsed = grantSchema.safeParse(value)
          if (!parsed.success || (parsed.data.invokedCommand || `${parsed.data.name}.${parsed.data.commandId}`) !== input.command) return fail('HOST_CALL_MISMATCH', 'Adapter context does not match the CLI invocation.')
          grant = parsed.data
          grant.confirmed = grant.confirmed && input.args.__confirmed === true
          return { ready: true }
        }
        if (request.operation === 'adapter.fetch' && grant) return await fetchForAdapter(grant, request, controller.signal)
        if (request.operation === 'adapter.helper' && grant) return await runAdapterHelper(input.context, grant, String(request.action), (request.payload || {}) as Record<string, unknown>, controller.signal, input.args)
        if (request.operation === 'adapter.page' && grant?.pageHosts) {
          const currentGrant = grant
          return await runPageAdapter(input.context, currentGrant, request, controller.signal,
            (action, payload, signal) => runAdapterHelper(input.context, currentGrant, action, payload, signal, input.args))
        }
        return fail('HOST_UNSUPPORTED_OPERATION', 'Host operation is not supported.')
      } catch (error) { operationFailed = true; throw error }
      finally { requestBusy = false }
    }, controller.signal)
    controller.signal.throwIfAborted()
    const stateRoot = join(getHaloDir(), 'webcli')
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
      SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR,
      ELECTRON_RUN_AS_NODE: '1',
      WEBCLI_HOST_ENDPOINT: channel.endpoint, WEBCLI_HOST_TOKEN: channel.token,
      WEBCLI_ADAPTERS_DIR: join(stateRoot, 'adapters'), WEWORKER_USER_ADAPTERS_DIR: join(stateRoot, 'adapters'),
      WEWORKER_ADAPTER_DATA_DIR: join(stateRoot, 'data'),
      WEBCLI_HOST_STATE_DIR: join(stateRoot, 'provider'),
    }
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [input.cliPath, 'call', input.command, '--args', serialized, '--output-format', 'json'], {
        env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      const chunks: Buffer[] = []
      let size = 0
      let failure: Error | undefined
      let escalation: ReturnType<typeof setTimeout> | undefined
      const terminate = () => {
        failure ??= controller.signal.reason || new Error('WebCLI invocation cancelled.')
        if (child.connected) child.send({ type: 'webcli:cancel' }, () => {})
        else child.kill('SIGTERM')
        escalation ??= setTimeout(() => child.kill('SIGKILL'), 1500)
      }
      controller.signal.addEventListener('abort', terminate, { once: true })
      if (controller.signal.aborted) terminate()
      child.stdout!.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BYTES) { failure = new Error('WebCLI output exceeds the size limit.'); terminate() }
        else chunks.push(chunk)
      })
      // Drain diagnostics without leaking source arguments, runtime credentials or user data into logs.
      child.stderr!.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BYTES) { failure = new Error('WebCLI diagnostics exceed the size limit.'); terminate() }
      })
      child.on('error', error => { failure = error })
      child.on('close', (code, exitSignal) => {
        controller.signal.removeEventListener('abort', terminate)
        clearTimeout(escalation)
        if (failure) reject(failure)
        else if (exitSignal || (code !== 0 && code !== 1)) reject(new Error('WebCLI process exited unexpectedly.'))
        else resolve(Buffer.concat(chunks).toString('utf8'))
      })
    })
    let result: Record<string, unknown>
    try { result = JSON.parse(output) } catch { return fail('HOST_CLI_PROTOCOL_ERROR', 'WebCLI did not return a host protocol result. Check the configured CLI version.') }
    if (result?.schemaVersion !== 1 || typeof result.ok !== 'boolean') return fail('HOST_CLI_PROTOCOL_ERROR', 'The configured WebCLI does not support this host protocol.')
    if (!result.ok && !operationFailed) console.warn('[WebCLI Host] CLI command failed', { code: (result.error as { code?: string } | undefined)?.code || 'HOST_CLI_FAILED' })
    return result
  } finally {
    controller.abort()
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', abort)
    app.removeListener('before-quit', abort)
    try { await channel?.close() } finally { activeContexts.delete(input.context); activeCalls-- }
  }
}

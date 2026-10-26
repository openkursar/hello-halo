import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type * as WorkerSdk from '@hello-halo/agent-sdk/worker'
import type { Options } from '@hello-halo/agent-sdk'

/** Host lifecycle and opaque grouping; thread management belongs entirely to the SDK. */
export function createHaloSdkModule(sdk: typeof WorkerSdk) {
  const unpack = (path: string) => app.isPackaged ? path.replace(/\.asar([/\\])/, '.asar.unpacked$1') : path
  const runtime = sdk.createWorkerRuntime({
    workerUrl: pathToFileURL(unpack(fileURLToPath(sdk.getWorkerEntryUrl()))),
    // Leave room for the remaining services within the application's five-second quit budget.
    shutdownTimeoutMs: 3000,
  })
  const appPath = app.getAppPath()
  const builtSetup = join(appPath, 'worker/halo-setup.cjs')
  const setupPath = !app.isPackaged && existsSync(builtSetup)
    ? builtSetup
    : join(appPath, 'out/main/worker/halo-setup.cjs')
  const setupModule = pathToFileURL(unpack(setupPath)).href
  const prepare = (options: Record<string, any>) => {
    const { haloRequestIdentity, workerGroup, ...sessionOptions } = options
    if (haloRequestIdentity) delete sessionOptions.requestIdentity
    if (sessionOptions.env?.CLAUDE_CODE_GIT_BASH_PATH && !sessionOptions.env.AGENT_GIT_BASH_PATH) {
      sessionOptions.env = { ...sessionOptions.env, AGENT_GIT_BASH_PATH: sessionOptions.env.CLAUDE_CODE_GIT_BASH_PATH }
    }
    return {
      options: sessionOptions as Options,
      placement: { group: workerGroup, setup: haloRequestIdentity ? { module: setupModule, data: haloRequestIdentity } : undefined },
    }
  }
  return {
    tool: sdk.tool,
    createSdkMcpServer: sdk.createSdkMcpServer,
    setLogger: sdk.setLogger,
    initialize: () => runtime.initialize(),
    close: () => runtime.close(),
    diagnostics: () => runtime.diagnostics(),
    createSession(options: Record<string, any>) {
      const prepared = prepare(options)
      return runtime.createSession(prepared.options, prepared.placement)
    },
    query(params: { prompt: string; options?: Record<string, any> }) {
      const prepared = prepare(params.options ?? {})
      return runtime.query({ prompt: params.prompt, options: prepared.options }, prepared.placement)
    },
  }
}

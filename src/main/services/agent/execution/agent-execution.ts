import { allowsCollaboration } from '../../../../shared/apps/capability-policy'
import { Emitter, type IDisposable } from '../../../platform/event'
import { getExecutionWorkHost } from '../../app-bridge'
import { isCollaborationEnabled } from '../user-agent-settings'
import { driveSession } from './drive'
import { createEngineStop, type EngineStop } from './engine-stop'
import { createUsageLedger } from './usage'
import type {
  AgentExecution,
  AgentExecutionOptions,
  AuthorizedInput,
  ExecutionBinding,
  ExecutionInputPort,
  ExecutionReader,
  ExecutionSessionHandle,
  ExecutionSessionPort,
  InputDisposition,
} from './types'

const LOG_TAG = '[AgentExecution]'

/**
 * Begin one execution. Nothing is created for work that is never delegated: the
 * host binds its tools, and members, requests and subscriptions appear only when
 * the model first uses them.
 */
export function openAgentExecution(options: AgentExecutionOptions): AgentExecution {
  const { key, principal, requester, signal } = options
  const source = options.source ?? { kind: 'run' as const }
  const disabledTools = principal.disabledTools
  const changed = new Emitter<void>()
  const ledger = createUsageLedger()
  let open = true
  let reading = false
  let readEnded: Promise<void> = Promise.resolve()
  let session: ExecutionSessionPort | undefined
  let handle: ExecutionSessionHandle | undefined
  let binding: ExecutionBinding = {}
  let engineStop: EngineStop | undefined
  let revision = 0
  let deliveries = 0
  let sending: Promise<void> = Promise.resolve()
  let closing: Promise<void> | undefined
  let stopping: Promise<void> | undefined

  const isLive = () => open && !signal?.aborted
  const mayDelegate = () => isLive() && isCollaborationEnabled(disabledTools)
    && (!requester?.delegation || allowsCollaboration(requester.delegation.policy, requester.delegation.mode))
  const pendingInput = () => session?.hasPendingInput?.() === true
  const noteInput = () => { revision++; changed.fire() }

  function closeAdmission(): void {
    if (!open) return
    open = false
    changed.fire()
  }

  const input: ExecutionInputPort = {
    async accept(authorizedInput: AuthorizedInput, authorized: () => boolean): Promise<InputDisposition> {
      const admissible = () => isLive() && session !== undefined && authorized()
      if (!admissible()) {
        console.warn(`${LOG_TAG} Input discarded: execution=${key} reason=unavailable`)
        return 'discarded'
      }
      deliveries++
      let disposition: InputDisposition = 'discarded'
      const task = sending.then(async () => {
        if (!admissible()) {
          console.warn(`${LOG_TAG} Queued input discarded: execution=${key} reason=unavailable`)
          return
        }
        const live = session!
        const accepted = live.sendIntoLiveTurn?.(authorizedInput.text) === true
        if (accepted) noteInput()
        else {
          // The lease is what refuses a send whose engine instance was replaced.
          await (binding.send ? binding.send(authorizedInput.text) : live.send(authorizedInput.text))
          noteInput()
        }
        disposition = accepted ? 'mid_turn' : 'buffered'
        try { binding.record?.(authorizedInput.record) }
        catch (error) {
          // The engine already has it; retrying would run the work twice.
          console.error(`${LOG_TAG} Accepted input could not be recorded: execution=${key}`, error)
        }
      })
      sending = task.catch(() => {})
      try { await task } finally { deliveries--; changed.fire() }
      return disposition
    },
  }

  const work = getExecutionWorkHost()?.open({
    key, principal, modelSelection: options.modelSelection, requester, source,
    grants: options.grants, modelContext: options.modelContext, isLive, mayDelegate, input,
  })

  const hasPendingWork = () => deliveries > 0 || work?.hasPending() === true

  /** Resolves true when the engine will have more to read: unread input, or owned work still to report. */
  function awaitContinuation(): Promise<boolean> {
    if (!isLive()) return Promise.resolve(false)
    if (pendingInput()) return Promise.resolve(true)
    if (!hasPendingWork()) return Promise.resolve(false)
    return new Promise<boolean>((resolve, reject) => {
      const subscriptions: IDisposable[] = []
      let settled = false
      const settle = (finish: () => void) => {
        if (settled) return
        settled = true
        for (const subscription of subscriptions) subscription.dispose()
        finish()
      }
      const check = () => {
        try {
          if (!isLive()) settle(() => resolve(false))
          else if (pendingInput()) settle(() => resolve(true))
          else if (!hasPendingWork()) settle(() => resolve(false))
        } catch (error) {
          settle(() => reject(error))
        }
      }
      const wake = () => queueMicrotask(check)
      subscriptions.push(changed.event(wake))
      const observed = work?.onChanged(wake)
      if (observed) subscriptions.push(observed)
      check()
    })
  }

  function bind(value: ExecutionSessionPort, next: ExecutionBinding = {}): void {
    session = value
    binding = next
    handle = {
      send: message => {
        if (!open) throw new Error('The execution has ended and no longer accepts input.')
        return value.send(message)
      },
      ...(value.sendIntoLiveTurn ? {
        sendIntoLiveTurn: (message: string, liveOptions?: { onWithdrawn?: () => void }) => {
          if (!open) return false
          const accepted = value.sendIntoLiveTurn!(message, liveOptions)
          if (accepted) noteInput()
          return accepted
        },
      } : {}),
      ...(value.hasPendingInput ? { hasPendingInput: () => value.hasPendingInput!() } : {}),
      ...(value.withdrawUnreadInput ? { withdrawUnreadInput: () => value.withdrawUnreadInput!() } : {}),
    }
  }

  async function read(message: string, reader: ExecutionReader): Promise<void> {
    const live = session
    if (!live) throw new Error('The execution has no engine session bound.')
    if (!isLive()) return
    reading = true
    try {
      await (binding.send ? binding.send(message) : live.send(message))
      reader.onSent?.()
      await driveSession(live, { isLive, awaitContinuation, addUsage: ledger.add, closeAdmission }, reader)
    } finally {
      reading = false
      engineStop?.release()
    }
  }

  function submit(message: string, reader: ExecutionReader): Promise<void> {
    const run = read(message, reader)
    readEnded = run.then(() => undefined, () => undefined)
    return run
  }

  function close(): Promise<void> {
    if (closing) return closing
    closeAdmission()
    closing = (async () => {
      try {
        try { await work?.end() }
        finally { await sending }
      } finally {
        ledger.add(work?.takeUsage())
        signal?.removeEventListener('abort', onAbort)
        changed.dispose()
      }
    })()
    return closing
  }

  function stop(): Promise<void> {
    stopping ??= (async () => {
      closeAdmission()
      if (reading && binding.engine) {
        engineStop ??= createEngineStop(binding.engine, { label: key })
        engineStop.stop()
      }
      try { await close() }
      finally { await readEnded }
    })()
    return stopping
  }

  const onAbort = () => {
    void stop().catch(error => console.error(`${LOG_TAG} Stop failed: execution=${key}`, error))
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  return {
    tools: work?.tools ?? {},
    guidance: work?.guidance,
    mayDelegate,
    bind,
    get session(): ExecutionSessionHandle {
      if (!handle) throw new Error('The execution has no engine session bound.')
      return handle
    },
    submit,
    get inputRevision() { return revision },
    canComplete: () => !hasPendingWork() && !pendingInput(),
    usage: ledger.total,
    stop,
    close,
  }
}

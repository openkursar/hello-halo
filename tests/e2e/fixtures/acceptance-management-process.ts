import { execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

interface ManagedApplication {
  process(): ChildProcess
  close(): Promise<void>
}

export interface OwnedManagementApp {
  application: ManagedApplication
  closed: boolean
  completion: Promise<void>
}

const execute = promisify(execFile)

export function trackManagementApp(application: ManagedApplication): OwnedManagementApp {
  const owned: OwnedManagementApp = { application, closed: false, completion: Promise.resolve() }
  owned.completion = new Promise<void>(resolve => {
    application.process().once('close', () => {
      owned.closed = true
      resolve()
    })
  })
  return owned
}

async function within(completion: Promise<unknown>, timeoutMs: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      completion,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function closeManagementApp(owned: OwnedManagementApp, timeoutMs = 15000) {
  if (owned.closed) return
  try {
    await within(Promise.all([owned.application.close(), owned.completion]), timeoutMs, 'Management acceptance application did not close within its deadline')
  } catch (error) {
    try {
      if (!owned.closed) {
        const child = owned.application.process()
        if (!child.pid) throw new Error('The owned management application has no process identity')
        try {
          if (process.platform === 'win32') {
            await execute('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000 })
          } else {
            // Playwright launches each POSIX application as its own process-group leader.
            process.kill(-child.pid, 'SIGKILL')
          }
        } catch (killError) {
          if (!owned.closed && (killError as NodeJS.ErrnoException).code !== 'ESRCH') throw killError
        }
        await within(owned.completion, 5000, 'The owned management application did not exit after forced shutdown')
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Management application shutdown and owned-process cleanup both failed')
    }
    throw error
  }
}

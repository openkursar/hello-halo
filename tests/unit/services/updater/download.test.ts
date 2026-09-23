/**
 * A staged download has to end, one way or another.
 *
 * The coordinator will not start another check while one preparation is in
 * flight, so a download that neither finishes nor fails blocks updating for
 * the rest of the session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { mkdtempSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

class FakeResponse extends EventEmitter {
  statusCode = 200
  pause = vi.fn()
  resume = vi.fn()
}

class FakeRequest extends EventEmitter {
  aborted = false
  abort = vi.fn(() => { this.aborted = true })
  end = vi.fn()
}

const requests: FakeRequest[] = []
vi.mock('electron', () => ({
  net: {
    request: vi.fn(() => {
      const request = new FakeRequest()
      requests.push(request)
      return request
    }),
  },
}))

const { downloadPackage } = await import('../../../../src/main/services/updater/staged/download')

let dir: string
beforeEach(() => {
  requests.length = 0
  dir = mkdtempSync(join(tmpdir(), 'halo-download-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

/** Wait until the download under test has issued its nth request. */
async function nthRequest(n: number): Promise<FakeRequest> {
  for (let i = 0; i < 200 && requests.length < n; i++) {
    await vi.advanceTimersByTimeAsync(50)
  }
  const request = requests[n - 1]
  if (!request) throw new Error(`request ${n} was never issued`)
  return request
}

function respond(request: FakeRequest): FakeResponse {
  const response = new FakeResponse()
  request.emit('response', response)
  return response
}

describe('staged package download', () => {
  it('gives up on a connection that stops sending', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const destination = join(dir, 'pkg.tar.zst')
    const done = downloadPackage('http://feed/pkg', destination, 10, () => undefined, new AbortController().signal)
    const outcome = expect(done).rejects.toThrow(/stalled/)

    // Every attempt stalls the same way.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const request = await nthRequest(attempt)
      respond(request).emit('data', Buffer.from('abc'))
      await vi.advanceTimersByTimeAsync(61_000)
      expect(request.abort).toHaveBeenCalled()
    }
    await outcome
    expect(existsSync(destination)).toBe(false)
  })

  it('stops as soon as the body outgrows the signed size', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const destination = join(dir, 'pkg.tar.zst')
    const controller = new AbortController()
    const done = downloadPackage('http://feed/pkg', destination, 4, () => undefined, controller.signal)
    const outcome = expect(done).rejects.toThrow()

    const request = await nthRequest(1)
    respond(request).emit('data', Buffer.from('abcdef'))
    expect(request.abort).toHaveBeenCalled()
    controller.abort()
    await outcome
    expect(existsSync(destination)).toBe(false)
  })
})

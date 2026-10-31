import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Server, createServer as createNetServer } from 'node:net'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test, { after, afterEach } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInThisContext } from 'node:vm'
import { build } from 'esbuild'

const output = fileURLToPath(new URL('../output/', import.meta.url))
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(output, 'remote-loopback-unit-'))
after(() => rm(directory, { recursive: true, force: true }))
const source = new URL('../../e2e/fixtures/acceptance-remote-desktop.ts', import.meta.url)
const compiled = join(directory, 'fixture.mjs')
await build({ entryPoints: [fileURLToPath(source)], outfile: compiled, bundle: true, packages: 'external', platform: 'node', format: 'esm', define: { 'import.meta.url': JSON.stringify(source.href) }, logLevel: 'silent' })
const { installRemoteLoopbackGuard, readRemoteLoopbackGuard, restoreRemoteLoopbackGuard } = await import(pathToFileURL(compiled).href)
const original = Server.prototype.listen
const servers = []

async function close(server) {
  server.closeAllConnections?.()
  if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

afterEach(async () => {
  for (const server of servers.splice(0)) await close(server)
  if (Server.prototype.listen !== original) restoreRemoteLoopbackGuard()
  assert.equal(Server.prototype.listen, original)
})

test('the serialized guard preserves the actual HTTP handler, requested port and callback', async () => {
  const reservation = createNetServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const install = runInThisContext(`(${installRemoteLoopbackGuard.toString()})`)
  install()
  let handled = 0, callbacks = 0, callbackReceiver
  const server = createServer((_request, response) => { handled++; response.end('real-http-handler') })
  servers.push(server)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', function () { callbacks++; callbackReceiver = this; resolve() })
  })
  assert.deepEqual(server.address(), { address: '127.0.0.1', family: 'IPv4', port })
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'real-http-handler')
  assert.equal(handled, 1)
  assert.equal(callbacks, 1)
  assert.equal(callbackReceiver, server)
  assert.deepEqual(readRemoteLoopbackGuard(), { installed: true, violations: [], attempts: [{ requestedHost: '0.0.0.0', requestedPort: port, actual: { address: '127.0.0.1', family: 'IPv4', port }, failed: false, listening: true }] })
  assert.throws(restoreRemoteLoopbackGuard, /listener is active/)
  assert.notEqual(Server.prototype.listen, original)
  await close(server)
  assert.deepEqual(restoreRemoteLoopbackGuard(), { restored: true, violations: [] })
  assert.equal(Server.prototype.listen, original)
  assert.throws(readRemoteLoopbackGuard, /no remote binding guard/)
})

test('options and implicit-host overloads bind actual loopback listeners and retain their callbacks', async () => {
  installRemoteLoopbackGuard()
  for (const options of [{ port: 0, host: '::', backlog: 16 }, 0]) {
    const server = createServer((_request, response) => response.end('local-only'))
    servers.push(server)
    let called = 0
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(options, () => { called++; resolve() })
    })
    const address = server.address()
    assert.equal(address.address, '127.0.0.1')
    assert.equal(await (await fetch(`http://127.0.0.1:${address.port}`)).text(), 'local-only')
    assert.equal(called, 1)
    await close(server)
  }
  const snapshot = readRemoteLoopbackGuard()
  assert.equal(snapshot.attempts.length, 2)
  assert.deepEqual(snapshot.violations, [])
  assert.ok(snapshot.attempts.every(attempt => attempt.actual.address === '127.0.0.1' && !attempt.listening))
})

test('unknown signatures and non-loopback requests fail before opening a socket or file', () => {
  installRemoteLoopbackGuard()
  const server = createServer()
  servers.push(server)
  const socket = join(directory, 'must-not-exist.sock')
  assert.throws(() => server.listen(0, '192.0.2.1'), /non-loopback-listen-host/)
  assert.throws(() => server.listen({ path: socket }), /unrecognized-listen-signature/)
  assert.throws(() => server.listen(-1), /unrecognized-listen-port/)
  assert.throws(() => server.listen(0, { unexpected: true }), /unrecognized-listen-signature/)
  assert.equal(server.listening, false)
  assert.equal(existsSync(socket), false)
  const state = readRemoteLoopbackGuard()
  assert.deepEqual(state.attempts, [])
  assert.deepEqual(state.violations, ['non-loopback-listen-host', 'unrecognized-listen-signature', 'unrecognized-listen-port', 'unrecognized-listen-signature'])
})

test('an occupied loopback port preserves the native error and leaves no observer after restore', async () => {
  const occupied = createServer()
  servers.push(occupied)
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
  const port = occupied.address().port
  installRemoteLoopbackGuard()
  const contender = createServer()
  servers.push(contender)
  const originalListeners = contender.listeners('listening')
  const failed = new Promise(resolve => contender.once('error', resolve))
  contender.listen(port, '0.0.0.0')
  assert.equal((await failed).code, 'EADDRINUSE')
  assert.equal(contender.listening, false)
  assert.equal(contender.listenerCount('listening'), originalListeners.length + 1)
  assert.deepEqual(restoreRemoteLoopbackGuard(), { restored: true, violations: [] })
  assert.deepEqual(contender.listeners('listening'), originalListeners)
  assert.equal(Server.prototype.listen, original)
  await close(occupied)
  await new Promise(resolve => contender.listen(port, '127.0.0.1', resolve))
  assert.equal(contender.address().address, '127.0.0.1')
})

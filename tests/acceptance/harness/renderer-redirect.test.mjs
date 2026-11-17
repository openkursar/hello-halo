import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test, { after, afterEach } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'renderer-redirect-'))
after(() => fs.rm(directory, { recursive: true, force: true }))
const compiled = path.join(directory, 'redirect.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../../e2e/fixtures/acceptance-renderer-redirect.ts', import.meta.url))],
  outfile: compiled, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent',
  // The redirect functions use only Node builtins; the asset server's dependency is not under test.
  plugins: [{ name: 'stub-express', setup(builder) {
    builder.onResolve({ filter: /^express$/ }, () => ({ path: 'express', namespace: 'stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default () => { throw new Error("not under test") }' }))
  } }],
})
const { installRendererRedirect, restoreRendererRedirect } = await import(pathToFileURL(compiled).href)

// Playwright serializes evaluated functions, so run them from source like the owned process does.
const evaluate = (fn, argument) => (0, eval)(`(${fn.toString()})`)(null, argument)
const real = net.Socket.prototype.connect
const plain = value => typeof value === 'function' ? 'fn' : Array.isArray(value) ? value.map(plain) : value

function stubConnect() {
  const calls = []
  const recorder = function (...args) { calls.push(args.map(plain)); return this }
  net.Socket.prototype.connect = recorder
  return { calls, recorder, socket: Object.create(net.Socket.prototype) }
}

afterEach(() => {
  net.Socket.prototype.connect = real
  delete globalThis.acceptanceRendererRedirect
})

const redirected = { port: 40001, host: '127.0.0.1', hostname: '127.0.0.1' }

test('remaps every loopback form of the development renderer port', () => {
  const { calls, socket } = stubConnect()
  evaluate(installRendererRedirect, 40001)
  socket.connect({ port: 5173, host: '127.0.0.1' })
  socket.connect({ port: '5173', host: 'localhost.' })
  socket.connect({ port: 5173, hostname: 'localhost' })
  socket.connect([{ port: 5173, host: '::ffff:127.0.0.1' }, () => {}])
  socket.connect(5173, '::1', () => {})
  socket.connect(5173, 'localhost')
  assert.deepEqual(calls, [
    [redirected], [redirected], [redirected], [[redirected, 'fn']],
    [40001, '127.0.0.1', 'fn'], [40001, '127.0.0.1'],
  ])
  assert.equal(evaluate(restoreRendererRedirect), 6)
})

test('passes other targets through unchanged', () => {
  const { calls, socket } = stubConnect()
  evaluate(installRendererRedirect, 40001)
  socket.connect({ port: 3000, host: '127.0.0.1' })
  socket.connect(3000, 'localhost')
  socket.connect('/tmp/renderer.sock')
  socket.connect({ path: '/tmp/renderer.sock', port: 5173 })
  assert.deepEqual(calls, [
    [{ port: 3000, host: '127.0.0.1' }], [3000, 'localhost'],
    ['/tmp/renderer.sock'], [{ path: '/tmp/renderer.sock', port: 5173 }],
  ])
  assert.equal(evaluate(restoreRendererRedirect), 0)
})

test('refuses port 5173 targets it cannot confirm as loopback', () => {
  const { calls, socket } = stubConnect()
  evaluate(installRendererRedirect, 40001)
  for (const attempt of [
    () => socket.connect({ port: 5173 }),
    () => socket.connect(5173),
    () => socket.connect(5173, () => {}),
    () => socket.connect({ port: 5173, host: '10.0.0.2' }),
    () => socket.connect([{ port: 5173, host: 'example.com' }]),
  ]) assert.throws(attempt, /refused port 5173/)
  assert.deepEqual(calls, [])
  assert.equal(evaluate(restoreRendererRedirect), 0)
})

test('restores the original connect exactly once and detects replacement', () => {
  const { recorder } = stubConnect()
  evaluate(installRendererRedirect, 40001)
  assert.throws(() => evaluate(installRendererRedirect, 40001), /already redirects/)
  evaluate(restoreRendererRedirect)
  assert.equal(net.Socket.prototype.connect, recorder)
  assert.equal(globalThis.acceptanceRendererRedirect, undefined)
  assert.throws(() => evaluate(restoreRendererRedirect), /no renderer redirect/)

  evaluate(installRendererRedirect, 40001)
  net.Socket.prototype.connect = recorder
  assert.throws(() => evaluate(restoreRendererRedirect), /changed/)
})

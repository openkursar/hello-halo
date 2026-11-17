import { createServer, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { once } from 'node:events'
import { createHash } from 'node:crypto'

export interface RuntimeRegistryReceipt {
  version: string
  platform: string
  arch: string
  executable: string
  sha256: string
  artifact?: string
  metadata?: string
  wrapperMetadata?: string
}

export async function startRuntimeRegistry(runtimeId: 'anthropic' | 'codex', options: { pausePrefixBytes?: number } = {}) {
  const pausePrefixBytes = options.pausePrefixBytes ?? 0
  if (!Number.isSafeInteger(pausePrefixBytes) || pausePrefixBytes < 0 || pausePrefixBytes > 256 * 1024) throw new Error('Registry pause prefix must be between 0 and 256 KiB')
  const receiptFile = runtimeId === 'codex' ? process.env.HALO_ACCEPTANCE_CODEX_PROVENANCE : process.env.HALO_ACCEPTANCE_CLAUDE_PROVENANCE
  if (!receiptFile) throw new Error(`Blocked prerequisite: explicit ${runtimeId} artifact provenance is required for the fixture registry`)
  const receipt: RuntimeRegistryReceipt = JSON.parse(await readFile(receiptFile, 'utf8'))
  if (receipt.platform !== process.platform || receipt.arch !== process.arch) throw new Error('Blocked prerequisite: fixture artifact must target the executing host')
  const artifact = runtimeId === 'codex' ? receipt.artifact : receipt.executable
  if (!artifact || (runtimeId === 'codex' && !receipt.metadata)) throw new Error('Blocked prerequisite: the Codex registry fixture requires original tarball and metadata paths')
  const identity = createHash('sha256')
  for await (const chunk of createReadStream(receipt.executable)) identity.update(chunk)
  if (identity.digest('hex') !== receipt.sha256) throw new Error('Blocked prerequisite: native runtime bytes do not match fixture provenance')
  const size = (await stat(artifact)).size
  const requests: string[] = []
  const responses = new Set<ServerResponse>()
  let online = true
  let paused = false
  const pending: Array<() => void> = []
  let baseUrl = ''
  const server = createServer(async (request, response) => {
    responses.add(response)
    response.once('close', () => responses.delete(response))
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    requests.push(pathname)
    if (!online) { response.writeHead(503).end('offline fixture'); return }
    const binary = runtimeId === 'codex' ? pathname.endsWith('.tgz') : /\/claude(?:\.exe)?$/.test(pathname)
    if (binary) {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size })
      const prefix = paused ? Math.min(pausePrefixBytes, Math.max(0, size - 1)) : 0
      const transfer = () => {
        if (response.destroyed) return
        const stream = createReadStream(artifact, { start: prefix })
        response.once('close', () => stream.destroy())
        stream.on('error', () => response.destroy())
        stream.pipe(response)
      }
      if (paused && prefix > 0) {
        const stream = createReadStream(artifact, { start: 0, end: prefix - 1 })
        response.once('close', () => stream.destroy())
        stream.on('error', () => response.destroy())
        stream.once('end', () => {
          if (paused) pending.push(transfer)
          else transfer()
        })
        stream.pipe(response, { end: false })
      } else if (paused) pending.push(transfer)
      else transfer()
      return
    }
    response.setHeader('content-type', 'application/json')
    if (runtimeId === 'codex') {
      try {
        const wrapper = decodeURIComponent(pathname).endsWith(`/${receipt.version}`)
        if (wrapper && !receipt.wrapperMetadata) throw new Error('Wrapper metadata fixture is missing')
        const metadata = JSON.parse(await readFile(wrapper ? receipt.wrapperMetadata! : receipt.metadata!, 'utf8'))
        if (!wrapper) metadata.dist.tarball = `${baseUrl}/payload.tgz`
        response.end(JSON.stringify(metadata))
      } catch { response.writeHead(500).end('{}') }
    } else {
      response.end(JSON.stringify({ version: receipt.version, platforms: { [`${receipt.platform}-${receipt.arch}`]: { checksum: receipt.sha256, size } } }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture registry did not bind a local port')
  baseUrl = `http://127.0.0.1:${address.port}`
  return {
    baseUrl, receipt, requests,
    setOnline(value: boolean) { online = value },
    pause() { paused = true },
    resume() { paused = false; pending.splice(0).forEach(transfer => transfer()) },
    async close() {
      for (const response of responses) response.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

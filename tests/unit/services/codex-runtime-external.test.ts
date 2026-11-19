import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { materializeCodex } from '../../../src/main/services/external-runtime/providers/codex/archive'
import { RECOMMENDED_INTEGRITY, RECOMMENDED_VERSION } from '../../../src/main/services/external-runtime/providers/codex/policy'
import { resolveCodexCandidate } from '../../../src/main/services/external-runtime/providers/codex/local'
import { probeCodex } from '../../../src/main/services/external-runtime/providers/codex/protocol'
import type { ProbeProcess, RuntimeArtifact, RuntimeProbeRunner } from '../../../src/main/services/external-runtime/provider'

const fixtureRoot = process.env.HALO_TEST_CODEX_FIXTURE_ROOT

describe.skipIf(!fixtureRoot || process.platform !== 'darwin' || process.arch !== 'arm64')('actual official Codex distribution evidence', () => {
  it('verifies official archive, extracts strict layout, and completes isolated non-model protocol', async () => {
    const root = resolve(fixtureRoot!)
    const archivePath = join(root, `codex-${RECOMMENDED_VERSION}-darwin-arm64.tgz`)
    const output = await mkdtemp(join(root, `codex-${RECOMMENDED_VERSION}-darwin-arm64-`))
    const artifact = { platform: 'darwin-arm64', payloadVersion: `${RECOMMENDED_VERSION}-darwin-arm64`, integrity: RECOMMENDED_INTEGRITY['darwin-arm64'] } as RuntimeArtifact
    const manifest = await materializeCodex(artifact, archivePath, output, new AbortController().signal)
    const executable = join(output, manifest.executable)
    const candidate = await resolveCodexCandidate(executable)
    const isolated = await mkdtemp(join(root, 'offline-probe-'))
    const methods: string[] = []
    const run = Object.assign((request: ProbeProcess) => new Promise<string>((resolve, reject) => {
      const env = { HOME: isolated, USERPROFILE: isolated, XDG_CONFIG_HOME: isolated, XDG_DATA_HOME: isolated, XDG_CACHE_HOME: isolated, APPDATA: isolated, LOCALAPPDATA: isolated, TMPDIR: isolated, PATH: candidate.launch.pathDirs!.join(':'), HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '', ...request.env }
      const child = spawn(executable, request.args, { env, cwd: isolated, stdio: ['pipe', 'pipe', 'pipe'] })
      let buffer = ''; let output = ''; let bytes = 0; let complete = false
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('offline probe timeout')) }, 20_000)
      const send = (message: string) => { for (const line of message.trim().split('\n')) methods.push(JSON.parse(line).method); child.stdin.write(message) }
      child.on('error', reject)
      child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) child.kill('SIGKILL') })
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length; if (bytes > 1024 * 1024) { child.kill('SIGKILL'); return }
        output += chunk.toString(); buffer += chunk.toString()
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
          try { if (request.onLine?.(line, send)) { complete = true; child.kill('SIGTERM') } } catch (error) { child.kill('SIGKILL'); reject(error) }
        }
      })
      child.on('close', code => { clearTimeout(timer); if (complete || !request.onLine && code === 0) resolve(output); else reject(new Error(`probe exited ${code}`)) })
      if (request.input) send(request.input); else child.stdin.end()
    }), { directory: isolated, reportVersion: () => {} }) as RuntimeProbeRunner
    try {
      expect(await probeCodex(candidate, run)).toBe(RECOMMENDED_VERSION)
      const hash = createHash('sha256'); for await (const chunk of createReadStream(executable)) hash.update(chunk)
      const receipt = { version: RECOMMENDED_VERSION, platform: process.platform, arch: process.arch, executable, sha256: hash.digest('hex') }
      await writeFile(join(root, 'codex-provenance.json'), JSON.stringify(receipt, null, 2))
      await writeFile(join(root, 'codex-official-evidence.json'), JSON.stringify({ ...receipt, archive: archivePath, registryMetadata: `https://registry.npmjs.org/@openai%2Fcodex/${RECOMMENDED_VERSION}-darwin-arm64`, integrity: artifact.integrity, components: manifest.components, probeMethods: methods, compatibility: 'compatible', verified: false }, null, 2))
      expect(methods).toEqual(['initialize', 'initialized', 'config/read', 'thread/list'])
      expect(JSON.parse(await readFile(join(root, 'codex-provenance.json'), 'utf8')).sha256).toHaveLength(64)
    } finally { await rm(isolated, { recursive: true, force: true }) }
  }, 90_000)
})

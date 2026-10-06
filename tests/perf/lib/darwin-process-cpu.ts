import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, mkdir, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const sourcePath = fileURLToPath(new URL('./darwin-process-cpu.c', import.meta.url))
const compilerArguments = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=12.0']

export interface NativeCpuSample {
  pid: number
  startTimeUs?: string
  sampleTimeNs?: string
  userCpuNs?: string
  systemCpuNs?: string
  error?: string
  errno?: number
}

export interface NativeCpuReport {
  backend: string
  clock: string
  cpuUnit: string
  cpuResolutionNs: number
  machTimebase: { numer: number; denom: number }
  samples: NativeCpuSample[]
}

export interface NativeCpuIdentity extends Omit<NativeCpuReport, 'samples'> {
  sourceSha256: string
  executableSha256: string
  compiler: string
  compilerVersion: string
  compileArguments: string[]
  probe: { idlePercentOneCore: number; busyPercentOneCore: number }
}

let prepared: Promise<{ executable: string; identity: NativeCpuIdentity }> | undefined

function digest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function parseReport(source: string): NativeCpuReport {
  const report = JSON.parse(source) as NativeCpuReport
  if (report.backend !== 'darwin-proc-pid-rusage-v4' || report.clock !== 'CLOCK_MONOTONIC_RAW' || report.cpuUnit !== 'nanoseconds' || !Array.isArray(report.samples) || !(report.cpuResolutionNs > 0)) {
    throw new Error('Native CPU collector returned an invalid report')
  }
  return report
}

async function prepare(): Promise<{ executable: string; identity: NativeCpuIdentity }> {
  if (process.platform !== 'darwin') throw new Error('The native CPU collector requires Darwin')
  if (prepared) return prepared
  prepared = (async () => {
    const sourceSha256 = digest(await readFile(sourcePath))
    const compiler = '/usr/bin/clang'
    const { stdout: compilerVersion } = await execute(compiler, ['--version'], { timeout: 15000 })
    const key = createHash('sha256').update(JSON.stringify({ sourceSha256, compilerVersion, compilerArguments, architecture: process.arch })).digest('hex')
    const directory = path.join(os.tmpdir(), 'halo-perf-native-cpu', key)
    const executable = path.join(directory, 'process-cpu')
    const manifest = path.join(directory, 'identity.json')
    await mkdir(directory, { recursive: true })
    let available = false
    try {
      const saved = JSON.parse(await readFile(manifest, 'utf8')) as { key: string; executableSha256: string }
      available = saved.key === key && saved.executableSha256 === digest(await readFile(executable))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!available) {
      const temporary = `${executable}.${process.pid}.compile`
      try {
        await execute(compiler, [...compilerArguments, sourcePath, '-o', temporary], { timeout: 30000 })
        await rename(temporary, executable)
        const temporaryManifest = `${manifest}.${process.pid}.write`
        try {
          const { writeFile } = await import('node:fs/promises')
          await writeFile(temporaryManifest, JSON.stringify({ key, executableSha256: digest(await readFile(executable)) }))
          await rename(temporaryManifest, manifest)
        } finally { await rm(temporaryManifest, { force: true }) }
      } finally { await rm(temporary, { force: true }) }
    }
    const { stdout } = await execute(executable, ['--probe'], { timeout: 10000 })
    const report = parseReport(stdout)
    if (report.samples.length !== 3 || report.samples.some(sample => sample.error || !sample.userCpuNs || !sample.systemCpuNs || !sample.sampleTimeNs)) {
      throw new Error('Native CPU collector probe could not read its own process')
    }
    const percentage = (before: NativeCpuSample, after: NativeCpuSample) => {
      const cpu = BigInt(after.userCpuNs!) + BigInt(after.systemCpuNs!) - BigInt(before.userCpuNs!) - BigInt(before.systemCpuNs!)
      const elapsed = BigInt(after.sampleTimeNs!) - BigInt(before.sampleTimeNs!)
      if (elapsed <= 0n || cpu < 0n) throw new Error('Native CPU collector probe returned invalid intervals')
      return Number(cpu) / Number(elapsed) * 100
    }
    const idlePercentOneCore = percentage(report.samples[0], report.samples[1])
    const busyPercentOneCore = percentage(report.samples[1], report.samples[2])
    if (busyPercentOneCore < 20 || busyPercentOneCore <= idlePercentOneCore) throw new Error('Native CPU collector failed its idle/busy positive control')
    const { samples: _samples, ...metadata } = report
    return { executable, identity: { ...metadata, sourceSha256, executableSha256: digest(await readFile(executable)), compiler, compilerVersion: compilerVersion.trim(), compileArguments: [...compilerArguments], probe: { idlePercentOneCore, busyPercentOneCore } } }
  })().catch(error => { prepared = undefined; throw error })
  return prepared
}

export async function readDarwinCpu(pids: number[]): Promise<{ report: NativeCpuReport; identity: NativeCpuIdentity }> {
  if (pids.some(pid => !Number.isInteger(pid) || pid < 1)) throw new Error('Native CPU collector requires valid PIDs')
  const { executable, identity } = await prepare()
  const { stdout } = await execute(executable, pids.map(String), { timeout: 5000, maxBuffer: 1024 * 1024 })
  return { report: parseReport(stdout), identity }
}

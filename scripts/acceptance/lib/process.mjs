import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { beginEvidenceProducer, startEvidenceProducer, finishEvidenceProducer, rejectEvidenceSpawn, assertEvidenceOutputWritable, writeEvidenceText } from './ci-evidence.mjs'

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

export function redact(value, root, environment = process.env) {
  let result = String(value)
  const secrets = Object.entries(environment).filter(([key, secret]) => /KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIAL/i.test(key) && typeof secret === 'string' && secret.length >= 6)
    .map(([, secret]) => secret).sort((a, b) => b.length - a.length)
  for (const secret of secrets) result = result.replaceAll(secret, '[REDACTED]')
  result = result.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/(\b(?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|client[-_ ]?secret)\b["']?\s*[:=]\s*["']?)([^"'\s,;}&]+)/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
  for (const directory of [root, environment.HOME, environment.USERPROFILE].filter(value => typeof value === 'string' && value.length > 1).sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(directory, directory === root ? '<repository>' : '<user-home>')
  }
  return result
}

function groupExists(pid) {
  try { process.kill(-pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

async function terminateTree(pid, onFailure) {
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let settled = false
      const finish = success => { if (!settled) { settled = true; clearTimeout(timer); resolve(success) } }
      const timer = setTimeout(() => { killer.kill(); onFailure('Windows process-tree termination exceeded its time budget'); finish(false) }, 10000)
      killer.once('error', error => { onFailure(`Windows process-tree termination could not start: ${error.message}`); finish(false) })
      killer.once('close', code => { if (code !== 0) onFailure(`Windows process-tree termination returned ${code}`); finish(code === 0) })
      killer.stdout.resume()
      killer.stderr.resume()
    })
  }
  try {
    if (!groupExists(pid)) return true
    let uncertain = false
    const observeUntil = async deadline => {
      while (performance.now() < deadline) {
        try { if (!groupExists(pid)) return true }
        catch (error) {
          if (error.code !== 'EPERM') throw error
          if (!uncertain) onFailure('Owned process-group exit observation returned EPERM; waiting for confirmed absence')
          uncertain = true
        }
        await delay(25)
      }
      return false
    }
    try { process.kill(-pid, 'SIGTERM') } catch (error) { if (error.code === 'ESRCH') return true; throw error }
    if (await observeUntil(performance.now() + 5000)) return true
    // The group remains owned even after its leader exits; descendants may ignore SIGTERM.
    try { process.kill(-pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    if (await observeUntil(performance.now() + 1000)) return true
    onFailure('The owned process group has not been confirmed absent after termination; cleanup is unconfirmed')
    return false
  } catch (error) {
    onFailure(`Owned process-group termination failed: ${error.message}`)
    return false
  }
}

// Callers must own the spawned process; on POSIX it must lead its own process group.
export { groupExists as ownedProcessGroupExists, terminateTree as terminateOwnedProcessTree }

export async function execute(root, args, { environment = {}, timeoutMs = 1800000, logFile, executable = process.execPath, shell = false, stdio = 'pipe', producerRole = 'subprocess' } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('Execution timeout must be between 1 and 2147483647 milliseconds')
  const childEnvironment = { ...process.env, ...environment }
  assertEvidenceOutputWritable(root, logFile, childEnvironment)
  if (!['pipe', 'inherit'].includes(stdio)) throw new Error('Execution stdio must be pipe or inherit')
  const producer = beginEvidenceProducer(root, producerRole, { environment: childEnvironment, evidencePaths: logFile ? [logFile] : [] })
  let log = ''
  return new Promise((resolve, reject) => {
    let child
    try { child = spawn(executable, args, { cwd: root, env: childEnvironment, shell, stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' }) }
    catch (error) { rejectEvidenceSpawn(producer, error.code); reject(error); return }
    let registrationError
    try { if (child.pid) startEvidenceProducer(producer, child.pid, { group: process.platform !== 'win32' }) }
    catch (error) { registrationError = error }
    let timedOut = false, termination, settled = false
    const receive = data => { log = (log + data.toString()).slice(-8 * 1024 * 1024) }
    const failure = message => {
      const safe = redact(message, root, childEnvironment)
      receive(`\nacceptance: ${safe}\n`)
      console.error(`acceptance: ${safe}`)
    }
    const stop = () => {
      if (!termination && child.pid) termination = terminateTree(child.pid, failure)
      return termination
    }
    const timer = setTimeout(() => {
      timedOut = true
      failure(`test execution exceeded ${timeoutMs} ms; stopping its owned process tree`)
      void stop()
    }, timeoutMs)
    const onSignal = () => {
      timedOut = true
      failure('test execution was interrupted; stopping its owned process tree')
      void stop()
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    child.stdout?.on('data', receive)
    child.stderr?.on('data', receive)
    const cleanupListeners = () => {
      clearTimeout(timer)
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    }
    child.once('error', error => {
      if (settled) return
      if (child.pid) {
        registrationError ??= error
        failure('the started process reported an error; stopping its owned process tree')
        void stop()
        return
      }
      settled = true
      cleanupListeners()
      try { rejectEvidenceSpawn(producer, error.code) } catch (evidenceError) { reject(new AggregateError([error, evidenceError], 'Process startup and evidence registration failed')); return }
      reject(new Error(`Could not start test runner: ${redact(error.message, root, childEnvironment)}`))
    })
    child.once('close', async (code, signal) => {
      if (settled) return
      settled = true
      cleanupListeners()
      let orphaned = false
      if (!termination && process.platform !== 'win32' && child.pid) {
        try {
          if (groupExists(child.pid)) {
            orphaned = true
            failure('test runner exited with live descendants; stopping its owned process group')
            void stop()
          }
        } catch (error) { failure(`Could not inspect the owned process group: ${error.message}`); orphaned = true }
      }
      const terminated = termination ? await termination : true
      const output = redact(log, root, childEnvironment)
      try {
        if (logFile) {
          assertEvidenceOutputWritable(root, logFile, childEnvironment)
          await fs.mkdir(path.dirname(logFile), { recursive: true })
          if (producer) writeEvidenceText(logFile, output, { mode: 0o640 })
          else await fs.writeFile(logFile, output)
        }
        finishEvidenceProducer(producer, { exitCode: code, signal, cleanupConfirmed: terminated && !registrationError })
        if (registrationError) throw registrationError
        resolve({ code: orphaned || !terminated ? 1 : code, processExitCode: code, signal, timedOut, log: output, cleanupFailed: !terminated })
      } catch (error) { reject(error) }
    })
    if (registrationError) { failure('evidence producer registration failed; stopping its owned process tree'); void stop() }
  })
}

import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

function localSetting(name) {
  const result = spawnSync('git', ['config', '--get', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return result.status === 0 ? result.stdout.trim() : undefined
}

try {
  const { values } = parseArgs({ options: {
    repository: { type: 'string' }, workflow: { type: 'string', default: 'acceptance.yml' },
    ref: { type: 'string', default: 'main' }, 'source-ref': { type: 'string' },
    'source-repository': { type: 'string' }, profile: { type: 'string', default: 'fast' },
    module: { type: 'string', multiple: true }, case: { type: 'string', multiple: true },
    full: { type: 'boolean', default: false }, execute: { type: 'boolean', default: false },
  } })
  values.repository ??= process.env.HALO_ACCEPTANCE_CI_REPOSITORY || localSetting('halo.acceptanceRepository')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values.repository ?? '')) throw new Error('--repository must name the controller owner/repository.')
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(values.workflow)) throw new Error('--workflow must be a workflow filename.')
  if (!['fast', 'regression'].includes(values.profile)) throw new Error('--profile must be fast or regression.')
  if (!values.ref || /[\r\n\0]/.test(values.ref)) throw new Error('--ref must be a nonempty single-line controller ref.')
  if (values['source-ref'] !== undefined && (!values['source-ref'] || /[\r\n\0]/.test(values['source-ref']))) throw new Error('--source-ref must be a nonempty single-line source ref.')
  if (values['source-repository'] && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(values['source-repository'])) throw new Error('--source-repository must be owner/repository.')
  for (const value of [...values.module ?? [], ...values.case ?? []]) if (!/^[a-z][a-z0-9.-]*$/.test(value)) throw new Error('Module and case ids must use catalog identifiers.')
  const requestId = randomUUID()
  const inputs = { profile: values.profile, full: String(values.full), request_id: requestId }
  if (values['source-ref']) inputs.source_ref = values['source-ref']
  if (values.module?.length) inputs.modules = [...new Set(values.module)].sort().join(',')
  if (values.case?.length) inputs.cases = [...new Set(values.case)].sort().join(',')
  if (values['source-repository']) inputs.source_repository = values['source-repository']
  const endpoint = `repos/${values.repository}/actions/workflows/${values.workflow}/dispatches`
  const request = { ref: values.ref, inputs }
  if (!values.execute) {
    console.log(JSON.stringify({ method: 'POST', endpoint, body: request }, null, 2))
    console.log('Preview only. Add --execute after authorizing this workflow dispatch.')
  } else {
    const environment = { ...process.env }
    const account = localSetting('halo.acceptanceAccount')
    if (account && !environment.GH_TOKEN && !environment.GITHUB_TOKEN) {
      if (!/^[A-Za-z0-9-]+$/.test(account)) throw new Error('Configured GitHub account name is invalid.')
      const credential = spawnSync('gh', ['auth', 'token', '--hostname', 'github.com', '--user', account], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      if (credential.status !== 0 || !credential.stdout.trim()) throw new Error('The configured GitHub account is not authenticated.')
      environment.GH_TOKEN = credential.stdout.trim()
    }
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    const receipt = path.join(root, 'tests/acceptance/output/dispatches', `${requestId}.json`)
    fs.mkdirSync(path.dirname(receipt), { recursive: true })
    const record = { version: 1, requestId, repository: values.repository, workflow: values.workflow, requestedAt: new Date().toISOString(), request, status: 'pending' }
    fs.writeFileSync(receipt, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ requestId, receipt }))
    const result = spawnSync('gh', ['api', '--method', 'POST', endpoint, '--input', '-'], { input: JSON.stringify(request), encoding: 'utf8', env: environment, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] })
    record.status = !result.error && result.status === 0 ? 'accepted' : /HTTP [45][0-9]{2}/.test(result.stderr ?? '') ? 'rejected' : 'unknown'
    fs.writeFileSync(receipt + '.tmp', JSON.stringify(record, null, 2) + '\n')
    fs.renameSync(receipt + '.tmp', receipt)
    if (record.status !== 'accepted') throw new Error(`Dispatch ${record.status}; inspect the saved receipt and matching run history before retrying.`)
    console.log('Workflow dispatch accepted. Acceptance results are available when its run completes; dispatch itself is not a passing test.')
  }
} catch (error) {
  console.error(`[Acceptance CI] ${error.message}`)
  process.exitCode = 1
}

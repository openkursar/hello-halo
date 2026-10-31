import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'
import { approvalSchema, contractSchema, moduleSchema, storySchema } from '../../../tests/acceptance/schemas/model.mjs'

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

export function hash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

export async function filesUnder(directory, extension) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const result = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await filesUnder(filename, extension))
    else if (entry.isFile() && filename.endsWith(extension)) result.push(filename)
  }
  return result
}

export async function writeJson(filename, value, { exclusive = false } = {}) {
  await fs.mkdir(path.dirname(filename), { recursive: true })
  await fs.writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: exclusive ? 'wx' : 'w' })
}

export async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, 'utf8'))
}

function unique(records, kind) {
  const result = new Map()
  for (const record of records) {
    if (result.has(record.id)) throw new Error(`Duplicate ${kind} id: ${record.id}`)
    result.set(record.id, record)
  }
  return result
}

export function variantsFor(scenario) {
  let values = [{}]
  for (const [name, choices] of Object.entries(scenario.variants ?? {}).sort()) {
    if (new Set(choices).size !== choices.length) throw new Error(`${scenario.id}: duplicate values for variant ${name}`)
    values = values.flatMap(value => choices.map(choice => ({ ...value, [name]: choice })))
    if (values.length > 4096) throw new Error(`${scenario.id}: more than 4096 variants; split the scenario into explicit supported contexts`)
  }
  return values
}

export function instanceKey(caseId, variant = {}) {
  return `${caseId}:${JSON.stringify(canonical(variant))}`
}

export async function loadCatalog(root) {
  const base = path.join(root, 'tests/acceptance')
  const modules = [], stories = [], contracts = []
  for (const filename of [...await filesUnder(path.join(base, 'catalog'), '.yaml'), ...await filesUnder(path.join(base, 'contracts'), '.yaml')]) {
    const document = parseDocument(await fs.readFile(filename, 'utf8'), { uniqueKeys: true })
    if (document.errors.length) throw new Error(`${path.relative(root, filename)}: ${document.errors.map(error => error.message).join('; ')}`)
    const schema = filename.startsWith(path.join(base, 'contracts') + path.sep) ? contractSchema : path.basename(filename) === 'module.yaml' ? moduleSchema : storySchema
    const parsed = schema.safeParse(document.toJS())
    if (!parsed.success) throw new Error(`${path.relative(root, filename)}: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
    const record = { ...parsed.data, source: path.relative(root, filename).split(path.sep).join('/') }
    ;(schema === moduleSchema ? modules : schema === contractSchema ? contracts : stories).push(record)
  }
  if (!modules.length || !stories.length) throw new Error('Acceptance catalog must contain modules and stories')
  const moduleMap = unique(modules, 'module'), contractMap = unique(contracts, 'contract')
  unique(stories, 'story')
  for (const contract of contracts) {
    unique(contract.scenarios, `scenario in contract ${contract.id}`)
    for (const scenario of contract.scenarios) {
      for (const promise of scenario.verifies) if (!Object.hasOwn(contract.promises, promise)) throw new Error(`${contract.id}/${scenario.id}: unknown shared promise ${promise}`)
      variantsFor(scenario)
    }
  }
  for (const module of modules) {
    for (const dependency of module.dependsOn) if (!moduleMap.has(dependency)) throw new Error(`${module.id}: unknown module dependency ${dependency}`)
    if (module.paths.some(pattern => pattern.startsWith('/') || pattern.split('/').includes('..'))) throw new Error(`${module.id}: change paths must be repository relative`)
  }
  const cases = []
  for (const story of stories) {
    if (!moduleMap.has(story.module)) throw new Error(`${story.id}: unknown module ${story.module}`)
    const promises = { ...story.promises }
    const resolved = [...story.scenarios]
    for (const use of story.uses) {
      const contract = contractMap.get(use.contract)
      if (!contract) throw new Error(`${story.id}: unknown contract ${use.contract}`)
      for (const scenarioId of use.scenarios) {
        const scenario = contract.scenarios.find(item => item.id === scenarioId)
        if (!scenario) throw new Error(`${story.id}: unknown scenario ${contract.id}/${scenarioId}`)
        for (const promise of scenario.verifies) {
          if (!Object.hasOwn(contract.promises, promise)) throw new Error(`${contract.id}/${scenario.id}: unknown shared promise ${promise}`)
          promises[`${contract.id}.${promise}`] = contract.promises[promise]
        }
        resolved.push({ ...scenario, id: `${story.id}.${scenario.id}`, verifies: scenario.verifies.map(promise => `${contract.id}.${promise}`) })
      }
    }
    for (const override of story.overrides) {
      const index = resolved.findIndex(scenario => scenario.id === override.id)
      if (index < 0) throw new Error(`${story.id}: override has no original scenario ${override.id}`)
      resolved[index] = override
    }
    if (!Object.keys(promises).length) throw new Error(`${story.id}: at least one local or shared product promise is required`)
    unique(resolved, `scenario in ${story.id}`)
    for (const scenario of resolved) {
      for (const promise of scenario.verifies) if (!Object.hasOwn(promises, promise)) throw new Error(`${scenario.id}: unknown promise ${promise}`)
      variantsFor(scenario)
      cases.push({ ...scenario, storyId: story.id, module: story.module, basis: story.basis })
    }
    story.resolvedPromises = promises
    const semanticScenarios = resolved.map(({ id, title, verifies, platforms, variants, preconditions, steps, expected, notes, reason }) => ({ id, title, verifies, platforms, variants, preconditions, steps, expected, notes, reason }))
    story.semanticHash = hash({ story: story.story, title: story.title, scope: moduleMap.get(story.module).scope, promises, scenarios: semanticScenarios, questions: story.questions })
    story.caseIds = resolved.map(scenario => scenario.id)
  }
  unique(cases, 'case')
  for (const story of stories) {
    const covered = new Set(cases.filter(scenario => scenario.storyId === story.id).flatMap(scenario => scenario.verifies))
    const missing = Object.keys(story.resolvedPromises).filter(promise => !covered.has(promise))
    if (missing.length) throw new Error(`${story.id}: promises without scenarios: ${missing.join(', ')}`)
  }
  const approvals = []
  for (const filename of await filesUnder(path.join(base, 'approvals'), '.json')) {
    const approval = approvalSchema.parse(await readJson(filename))
    const story = stories.find(item => item.id === approval.storyId)
    if (!story) throw new Error(`Approval references unknown story ${approval.storyId}`)
    approvals.push({ ...approval, current: approval.semanticHash === story.semanticHash })
  }
  return { version: 1, modules, contracts, stories, cases, approvals, hash: hash({ modules, contracts, stories, cases }) }
}

import { hash, instanceKey, variantsFor } from './catalog.mjs'
import { bindingSchema } from '../../../tests/acceptance/schemas/model.mjs'

export function matchPath(pattern, filename) {
  const parts = pattern.split(/(\*\*\/|\*\*|\*|\?)/).map(part => {
    if (part === '**/') return '(?:.*/)?'
    if (part === '**') return '.*'
    if (part === '*') return '[^/]*'
    if (part === '?') return '[^/]'
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  })
  return new RegExp(`^${parts.join('')}$`).test(filename)
}

const broadPaths = ['package.json', 'package-lock.json', 'electron.vite.config.ts', 'src/shared/**', 'src/preload/**', 'src/main/bootstrap/**', 'src/main/foundation/**', 'src/main/services/agent/**', 'scripts/acceptance/**', 'tests/acceptance/schemas/**', 'tests/acceptance/contracts/**', 'tests/playwright.config.ts', 'tests/e2e/fixtures/**']

export function selectModules(catalog, changed) {
  if (changed === null) return { modules: catalog.modules.map(module => module.id), reason: 'No usable baseline; full supported scope' }
  if (!changed.length) return { modules: [], reason: 'No source changes; core scenarios remain mandatory' }
  if (changed.some(filename => broadPaths.some(pattern => matchPath(pattern, filename)))) return { modules: catalog.modules.map(module => module.id), reason: 'Shared application or verification infrastructure changed' }
  const affected = new Set()
  const unmapped = []
  for (const filename of changed) {
    const owners = catalog.modules.filter(module => module.paths.some(pattern => matchPath(pattern, filename)))
    if (!owners.length) unmapped.push(filename)
    for (const module of owners) affected.add(module.id)
  }
  if (unmapped.length) return { modules: catalog.modules.map(module => module.id), reason: `Unmapped changes require full supported scope: ${unmapped.join(', ')}` }
  let added = true
  while (added) {
    added = false
    for (const module of catalog.modules) {
      if (!affected.has(module.id) && module.dependsOn.some(dependency => affected.has(dependency))) { affected.add(module.id); added = true }
    }
  }
  return { modules: [...affected].sort(), reason: 'Changed modules and transitive consumers, plus mandatory core scenarios' }
}

export function validateManifest(catalog, manifest) {
  if (manifest.version !== 1 || !Array.isArray(manifest.tests)) throw new Error('Unsupported test manifest')
  const scenarios = new Map(catalog.cases.map(scenario => [scenario.id, scenario]))
  const ids = new Set()
  for (const test of manifest.tests) {
    if (test.executor && !['playwright', 'cluster'].includes(test.executor)) throw new Error(`Unknown test executor: ${test.executor}`)
    if (ids.has(test.id)) throw new Error(`Duplicate discovered test id: ${test.id}`)
    ids.add(test.id)
    if (typeof test.file !== 'string' || test.file.startsWith('/') || test.file.split('/').includes('..')) throw new Error('Discovered test paths must be repository relative')
    for (const raw of test.bindings ?? []) {
      const binding = bindingSchema.parse(raw)
      const scenario = scenarios.get(binding.caseId)
      if (!scenario) throw new Error(`${test.title}: unknown acceptance case ${binding.caseId}`)
      if (binding.evidence !== scenario.evidence || binding.mode !== scenario.mode) throw new Error(`${binding.caseId}: binding boundary (${binding.evidence}/${binding.mode}) disagrees with catalog (${scenario.evidence}/${scenario.mode})`)
      if (!variantsFor(scenario).some(variant => instanceKey(binding.caseId, variant) === instanceKey(binding.caseId, binding.variant))) throw new Error(`${binding.caseId}: unsupported bound variant ${JSON.stringify(binding.variant)}`)
    }
    if (new Set((test.bindings ?? []).map(binding => binding.mode)).size > 1) throw new Error(`${test.title}: one executable test cannot mix live and deterministic model boundaries`)
  }
  return manifest
}

export function makePlan(catalog, manifest, options = {}) {
  validateManifest(catalog, manifest)
  const platform = options.platform ?? process.platform
  const profile = options.profile ?? 'fast'
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error(`Unsupported platform ${platform}`)
  if (!['fast', 'regression', 'live', 'external'].includes(profile)) throw new Error(`Unknown profile ${profile}`)
  const requestedModules = options.modules ?? [], requestedCases = options.cases ?? []
  for (const module of requestedModules) if (!catalog.modules.some(item => item.id === module)) throw new Error(`Unknown module ${module}`)
  for (const scenario of requestedCases) if (!catalog.cases.some(item => item.id === scenario)) throw new Error(`Unknown case ${scenario}`)
  const selection = requestedModules.length ? { modules: requestedModules, reason: 'Explicit module selection' } : selectModules(catalog, options.changed ?? null)
  const selectedModules = new Set(selection.modules)
  // A scenario that failed last time is looked at again whatever the change touched; one the catalog no longer has is dropped.
  const rerun = new Set((options.rerun ?? []).filter(id => catalog.cases.some(item => item.id === id)))
  const decisions = new Map()
  for (const decision of [...catalog.approvals ?? []].sort((a, b) => a.decidedAt.localeCompare(b.decidedAt))) {
    if (decision.current) decisions.set(decision.storyId, decision.decision)
  }
  const cases = [], excluded = []
  for (const scenario of catalog.cases) {
    const explicit = requestedCases.includes(scenario.id)
    const selected = requestedCases.length ? explicit : selectedModules.has(scenario.module) || (options.changed !== undefined && scenario.profiles.includes('fast')) || rerun.has(scenario.id)
    let exclusion
    if (scenario.basis === 'proposed' && decisions.get(scenario.storyId) !== 'approved' && !options.includeProposed) exclusion = 'Unconfirmed product proposal'
    else if (!scenario.platforms.includes(platform)) exclusion = 'Different platform'
    else if (!selected) exclusion = 'Outside selected modules'
    else if (!explicit && !scenario.profiles.includes(profile) && !(profile === 'regression' && scenario.profiles.includes('fast'))) exclusion = 'Different execution profile'
    if (exclusion) { excluded.push({ caseId: scenario.id, reason: exclusion }); continue }
    for (const variant of variantsFor(scenario)) {
      const key = instanceKey(scenario.id, variant)
      const tests = manifest.tests.filter(test => test.bindings?.some(binding => instanceKey(binding.caseId, binding.variant) === key))
      let blockedReason
      if (scenario.mode === 'live' && !options.allowLive) blockedReason = 'Live model execution requires --allow-live and an explicit budget'
      if (scenario.evidence === 'external' && !options.allowExternal) blockedReason = 'External service execution requires --allow-external'
      if (scenario.automation === 'manual') blockedReason = 'Human verification is required'
      else if (!tests.length) blockedReason ??= 'No executable test is bound to this required scenario'
      cases.push({ caseId: scenario.id, storyId: scenario.storyId, module: scenario.module, title: scenario.title, variant, evidence: scenario.evidence, mode: scenario.mode, automation: scenario.automation, requirements: scenario.requirements, testIds: tests.map(test => test.id), ...(blockedReason ? { blockedReason } : {}) })
    }
  }
  return { version: 1, createdAt: new Date().toISOString(), catalogHash: catalog.hash, manifestHash: hash(manifest), revision: options.revision ?? manifest.revision, platform, profile,
    selection: { modules: requestedModules, cases: requestedCases, rerun: [...rerun].sort(), changed: options.changed ?? null, includeCore: options.changed !== undefined, includeProposed: Boolean(options.includeProposed) },
    selectionReason: requestedCases.length ? 'Explicit scenario selection' : selection.reason, changed: options.changed ?? null,
    allowLive: Boolean(options.allowLive), allowExternal: Boolean(options.allowExternal), live: options.live ?? null, cases, excluded,
    tests: manifest.tests.filter(test => cases.some(scenario => scenario.testIds.includes(test.id))) }
}

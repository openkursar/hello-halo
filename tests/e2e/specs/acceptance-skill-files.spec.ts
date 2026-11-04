import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test, expect, managementAcceptance, seedManagedSpace } from '../fixtures/acceptance-management'
import { ownedSkillFile, readSkillPackage, requireSkillData, skillImport, skillMarkdown, skillRef, skillRequest } from '../fixtures/acceptance-skills'

test.setTimeout(90000)

test('production skill discovery reads selected project roots without adopting unknown private files', managementAcceptance('capabilities.skill-api.discovery'), async ({ managementApp, window }) => {
  const project = join(managementApp.profile, 'skill-discovery-project')
  const unrelated = join(managementApp.profile, 'unrelated-skill-project')
  mkdirSync(project)
  mkdirSync(unrelated)
  const selected = await seedManagedSpace(window, 'Selected skill project', project)
  await seedManagedSpace(window, 'Unrelated skill project', unrelated)
  const cases = [
    { root: join(project, '.agents/skills'), name: 'direct-project-skill', expected: true },
    { root: join(project, '.claude/skills'), name: 'compatible-project-skill', expected: true },
    { root: join(managementApp.profile, '.agents/skills'), name: 'direct-global-skill', expected: true },
    { root: join(unrelated, '.agents/skills'), name: 'unrelated-project-skill', expected: false },
    { root: join(managementApp.profile, '.halo/skills'), name: 'unknown-private-skill', expected: false },
  ]
  const originals = new Map<string, string>()
  for (const item of cases) {
    const directory = join(item.root, item.name)
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'SKILL.md')
    const content = skillMarkdown(item.name, `Distinct body for ${item.name}.`)
    writeFileSync(file, content)
    originals.set(file, content)
  }
  const inventory = requireSkillData(await skillRequest(window, 'skillsList', { spaceId: selected.id }))
  for (const item of cases) {
    expect(inventory.groups.some(group => group.name === item.name)).toBe(item.expected)
    if (item.expected) {
      const group = inventory.groups.find(group => group.name === item.name)!
      expect(group.copies).toHaveLength(1)
      expect(group.source).toBe('mine')
      expect(group.effectiveId).toBe(group.copies[0].id)
      expect(group.copies[0].source).toBe('personal')
    }
  }
  const search = requireSkillData(await skillRequest(window, 'skillsList', { spaceId: selected.id, q: 'compatible-project' }))
  expect(search.groups.map(group => group.name)).toEqual(['compatible-project-skill'])
  const reopened = await managementApp.restart()
  const after = requireSkillData(await skillRequest(reopened, 'skillsList', { spaceId: selected.id }))
  expect(after.groups.some(group => group.name === 'unknown-private-skill')).toBe(false)
  for (const [file, content] of originals) expect(readFileSync(file, 'utf8')).toBe(content)
})

for (const scope of ['workspace', 'global'] as const) {
  test(`production ${scope} skill import is complete and idempotent with binary assets`, managementAcceptance('capabilities.skill-api.import', { scope }), async ({ managementApp, window }) => {
    const space = await seedManagedSpace(window, 'Import target')
    const input = skillImport(scope === 'global' ? null : space.id, 'binary-import-evidence', 'Use the current imported package.')
    const copy = requireSkillData(await skillRequest(window, 'skillsImport', input))
    const file = ownedSkillFile(managementApp.profile, copy)
    expect(file).toContain(join(scope === 'global' ? managementApp.profile : space.workingDir ?? space.path, '.agents', 'skills'))
    const before = readSkillPackage(managementApp.profile, copy)
    expect(before).toEqual({
      content: input.spec.skill_files!['SKILL.md'],
      reference: input.spec.skill_files!['references/nested/evidence.md'],
      binary: input.spec.skill_assets!['templates/evidence.bin'].content,
    })
    const repeated = requireSkillData(await skillRequest(window, 'skillsImport', input))
    expect(repeated.id).toBe(copy.id)
    const inventory = requireSkillData(await skillRequest(window, 'skillsList', { spaceId: space.id }))
    expect(inventory.groups.find(group => group.name === input.spec.name)?.copies).toHaveLength(1)
    const detail = requireSkillData(await skillRequest(window, 'skillsRead', skillRef(copy, space.id)))
    expect(detail.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'templates/evidence.bin', binary: true, size: 7 })]))
    const reopened = await managementApp.restart()
    expect(requireSkillData(await skillRequest(reopened, 'skillsRead', skillRef(copy, space.id))).content).toBe(before.content)
    expect(readSkillPackage(managementApp.profile, copy)).toEqual(before)
  })
}

test('production save rejects a stale revision and preserves unknown metadata and supporting bytes', managementAcceptance('capabilities.skill-api.edit-conflict'), async ({ managementApp, window }) => {
  const space = await seedManagedSpace(window, 'Editing files')
  const copy = requireSkillData(await skillRequest(window, 'skillsImport', skillImport(space.id, 'edit-conflict-evidence', 'Original instructions.')))
  const ref = skillRef(copy)
  const before = readSkillPackage(managementApp.profile, copy)
  const detail = requireSkillData(await skillRequest(window, 'skillsRead', ref))
  const file = ownedSkillFile(managementApp.profile, copy)
  const external = detail.content.replace('Original instructions.', 'Externally revised instructions.')
  writeFileSync(file, external)
  const draft = detail.content.replace('Original instructions.', 'Unsaved editor draft.')
  const stale = await skillRequest(window, 'skillsSave', { ref, revision: detail.revision, content: draft })
  expect(stale.success).toBe(false)
  expect(stale.error).toBeTruthy()
  expect(readFileSync(file, 'utf8')).toBe(external)
  const current = requireSkillData(await skillRequest(window, 'skillsRead', ref))
  expect(current.content).toBe(external)
  expect(current.revision).not.toBe(detail.revision)
  const reconciled = current.content.replace('Externally revised instructions.', 'Explicitly reconciled instructions.')
  const saved = requireSkillData(await skillRequest(window, 'skillsSave', { ref, revision: current.revision, content: reconciled }))
  expect(saved.content).toBe(reconciled)
  expect(saved.content).toContain('x-acceptance-metadata: preserve-me')
  const after = readSkillPackage(managementApp.profile, copy)
  expect(after.reference).toBe(before.reference)
  expect(after.binary).toBe(before.binary)
  const reopened = await managementApp.restart()
  expect(requireSkillData(await skillRequest(reopened, 'skillsRead', ref)).content).toBe(reconciled)
})

test('production replacement removes obsolete resources without reenabling a disabled skill', managementAcceptance('capabilities.skill-api.replace'), async ({ managementApp, window }) => {
  const space = await seedManagedSpace(window, 'Reimport files')
  const originalInput = skillImport(space.id, 'replace-package-evidence', 'Original package.')
  originalInput.spec.skill_files!['obsolete-script.js'] = 'throw new Error("Import must never run scripts")\n'
  const copy = requireSkillData(await skillRequest(window, 'skillsImport', originalInput))
  const ref = skillRef(copy)
  const file = ownedSkillFile(managementApp.profile, copy)
  const before = readSkillPackage(managementApp.profile, copy)
  const newInput = skillImport(space.id, copy.name, 'Replacement package.')
  const collision = await skillRequest(window, 'skillsImport', newInput)
  expect(collision.success).toBe(false)
  expect(readSkillPackage(managementApp.profile, copy)).toEqual(before)
  requireSkillData(await skillRequest(window, 'skillsSetEnabled', { ref, enabled: false }))
  const detail = requireSkillData(await skillRequest(window, 'skillsRead', ref))
  const replaced = requireSkillData(await skillRequest(window, 'skillsImport', {
    ...newInput, replace: { ref, revision: detail.revision },
  }))
  expect(replaced.enabled).toBe(false)
  expect(readSkillPackage(managementApp.profile, replaced).content).toBe(newInput.spec.skill_files!['SKILL.md'])
  expect(existsSync(join(dirname(file), 'obsolete-script.js'))).toBe(false)
  const inventory = requireSkillData(await skillRequest(window, 'skillsList', { spaceId: space.id }))
  expect(inventory.groups.find(group => group.name === copy.name)?.effectiveId).toBeUndefined()
  const reopened = await managementApp.restart()
  expect(requireSkillData(await skillRequest(reopened, 'skillsRead', skillRef(replaced))).copy.enabled).toBe(false)
})

test('production scope move and independent copy preserve package bytes and disabled choice', managementAcceptance('capabilities.skill-api.move-copy'), async ({ managementApp, window }) => {
  const destination = await seedManagedSpace(window, 'Moved skill files')
  const source = requireSkillData(await skillRequest(window, 'skillsImport', skillImport(null, 'move-package-evidence', 'Move this entire package.')))
  const sourceRef = skillRef(source, destination.id)
  const oldFile = ownedSkillFile(managementApp.profile, source)
  const before = readSkillPackage(managementApp.profile, source)
  requireSkillData(await skillRequest(window, 'skillsSetEnabled', { ref: sourceRef, enabled: false }))
  const preview = requireSkillData(await skillRequest(window, 'skillsMovePreview', { ref: sourceRef, spaceId: destination.id }))
  expect(preview).toMatchObject({ fromSpaceId: null, toSpaceId: destination.id })
  expect(preview.conflict).toBeUndefined()
  expect(readSkillPackage(managementApp.profile, source)).toEqual(before)
  const detail = requireSkillData(await skillRequest(window, 'skillsRead', sourceRef))
  const moved = requireSkillData(await skillRequest(window, 'skillsMove', { ref: sourceRef, spaceId: destination.id, revision: detail.revision }))
  expect(moved).toMatchObject({ spaceId: destination.id, scope: 'space', enabled: false })
  expect(existsSync(oldFile)).toBe(false)
  expect(readSkillPackage(managementApp.profile, moved)).toEqual(before)
  const independent = requireSkillData(await skillRequest(window, 'skillsCopy', { ref: skillRef(moved), spaceId: null, name: 'independent-package-evidence' }))
  const copied = readSkillPackage(managementApp.profile, independent)
  expect(copied.content).toContain('name: independent-package-evidence')
  expect(copied.reference).toBe(before.reference)
  expect(copied.binary).toBe(before.binary)
  const movedDetail = requireSkillData(await skillRequest(window, 'skillsRead', skillRef(moved)))
  requireSkillData(await skillRequest(window, 'skillsSave', { ref: skillRef(moved), revision: movedDetail.revision, content: movedDetail.content.replace('Move this entire package.', 'Changed only the moved original.') }))
  expect(readSkillPackage(managementApp.profile, independent)).toEqual(copied)
  const reopened = await managementApp.restart()
  expect(requireSkillData(await skillRequest(reopened, 'skillsRead', skillRef(moved))).copy.enabled).toBe(false)
  expect(readSkillPackage(managementApp.profile, independent)).toEqual(copied)
})

test('production scope collision retains both copies and all their resources', managementAcceptance('capabilities.skill-api.move-conflict'), async ({ managementApp, window }) => {
  const space = await seedManagedSpace(window, 'Conflicting scope files')
  const global = requireSkillData(await skillRequest(window, 'skillsImport', skillImport(null, 'conflicting-package-evidence', 'Global version.')))
  const local = requireSkillData(await skillRequest(window, 'skillsImport', skillImport(space.id, global.name, 'Workspace version.')))
  const beforeGlobal = readSkillPackage(managementApp.profile, global)
  const beforeLocal = readSkillPackage(managementApp.profile, local)
  const ref = skillRef(global, space.id)
  const preview = requireSkillData(await skillRequest(window, 'skillsMovePreview', { ref, spaceId: space.id }))
  expect(preview.conflict).toBeTruthy()
  const detail = requireSkillData(await skillRequest(window, 'skillsRead', ref))
  const result = await skillRequest(window, 'skillsMove', { ref, spaceId: space.id, revision: detail.revision })
  expect(result.success).toBe(false)
  expect(readSkillPackage(managementApp.profile, global)).toEqual(beforeGlobal)
  expect(readSkillPackage(managementApp.profile, local)).toEqual(beforeLocal)
  const reopened = await managementApp.restart()
  const inventory = requireSkillData(await skillRequest(reopened, 'skillsList', { spaceId: space.id }))
  expect(inventory.groups.find(group => group.name === global.name)).toMatchObject({ effectiveId: local.id })
  expect(readSkillPackage(managementApp.profile, global)).toEqual(beforeGlobal)
  expect(readSkillPackage(managementApp.profile, local)).toEqual(beforeLocal)
})

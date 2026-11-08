import { app, shell } from 'electron'
import { join } from 'node:path'
import { getHaloDir, resolveClaudeConfigDir } from '../../foundation/config.service'
import { getSpace } from '../../services/space.service'
import { getAppManager } from '../manager'
import { createSkillLibrary } from './service'

export { createSkillLibrary } from './service'
export type { SkillLibraryDependencies } from './service'
export { resolveSkillGroups } from './catalog'

const library = createSkillLibrary({
  context(spaceId, workDir) {
    const manager = getAppManager()
    if (!manager) throw new Error('Skill management is not ready. Try again shortly.')
    const space = spaceId === null ? null : getSpace(spaceId)
    if (spaceId !== null && !space) throw new Error('The selected workspace no longer exists.')
    const spaceWorkDir = space ? space.isTemp ? join(space.path, 'artifacts') : space.workingDir || space.path : null
    return {
      manager, spaceId, haloDir: getHaloDir(),
      workDir: workDir ?? spaceWorkDir, spaceWorkDir,
      spaceDataPath: space?.path ?? null,
      legacyGlobalRoots: [join(resolveClaudeConfigDir(), 'skills'), join(app.getPath('userData'), 'claude-config', 'skills')],
      ownedLegacyGlobalRoot: join(app.getPath('userData'), 'claude-config', 'skills'),
    }
  },
  trash: path => shell.trashItem(path),
  openFolder: path => shell.showItemInFolder(join(path, 'SKILL.md')),
})

export function getSkillLibrary() { return library }

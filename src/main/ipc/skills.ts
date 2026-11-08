import { skillsRpc } from '../../shared/rpc/contracts/skills.contract'
import * as skillsController from '../controllers/skills.controller'
import { registerRpcHandlers } from './rpc'

export function registerSkillsHandlers(): void {
  registerRpcHandlers(
    skillsRpc,
    {
      skillsList: (input) => skillsController.listSkills(input),
      skillsRead: (input) => skillsController.readSkill(input),
      skillsSave: (input) => skillsController.saveSkill(input),
      skillsImport: (input) => skillsController.importSkill(input),
      skillsSetEnabled: (input) => skillsController.setSkillEnabled(input),
      skillsMovePreview: (input) => skillsController.previewSkillMove(input),
      skillsMove: (input) => skillsController.moveSkill(input),
      skillsCopy: (input) => skillsController.copySkill(input),
      skillsDelete: (input) => skillsController.deleteSkill(input),
      skillsOpenFolder: (input) => skillsController.openSkillFolder(input),
      skillsExport: (input) => skillsController.exportSkill(input),
      skillsRestoreLegacy: (input) => skillsController.restoreLegacySkill(input),
      skillsDeleteLegacy: (input) => skillsController.deleteLegacySkill(input),
    },
    'Skills',
  )
}

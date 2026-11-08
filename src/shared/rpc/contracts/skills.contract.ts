import { rpcMethod } from '../define'
import type {
  SkillRef, SkillInventory, SkillListQuery, SkillDetail, SkillCopy, SkillSaveInput,
  SkillImportInput, SkillMoveInput, SkillMovePreview, SkillCopyInput,
} from '../../types/skills'

export const skillsRpc = {
  skillsList: rpcMethod<[query: SkillListQuery], SkillInventory>('skills:list'),
  skillsRead: rpcMethod<[ref: SkillRef], SkillDetail>('skills:read'),
  skillsSave: rpcMethod<[input: SkillSaveInput], SkillDetail>('skills:save'),
  skillsImport: rpcMethod<[input: SkillImportInput], SkillCopy>('skills:import'),
  skillsSetEnabled: rpcMethod<[input: { ref: SkillRef; enabled: boolean }], SkillCopy>('skills:set-enabled'),
  skillsMovePreview: rpcMethod<[input: { ref: SkillRef; spaceId: string | null }], SkillMovePreview>('skills:move-preview'),
  skillsMove: rpcMethod<[input: SkillMoveInput], SkillCopy>('skills:move'),
  skillsCopy: rpcMethod<[input: SkillCopyInput], SkillCopy>('skills:copy'),
  skillsDelete: rpcMethod<[input: { ref: SkillRef; revision: string }], void>('skills:delete'),
  skillsOpenFolder: rpcMethod<[ref: SkillRef], void>('skills:open-folder'),
  skillsExport: rpcMethod<[ref: SkillRef], { filename: string; base64: string }>('skills:export'),
  skillsRestoreLegacy: rpcMethod<[input: { appId: string; spaceId: string | null; name?: string }], SkillCopy>('skills:restore-legacy'),
  skillsDeleteLegacy: rpcMethod<[input: { appId: string }], void>('skills:delete-legacy'),
}

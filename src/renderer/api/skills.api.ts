import type { RpcClient } from '../../shared/rpc/define'
import type { skillsRpc } from '../../shared/rpc/contracts/skills.contract'
import { httpRequest, isElectron } from './_shared'
import { ensureExtendedServicesReady } from './bootstrap-ready'

async function desktop<T>(operation: () => Promise<T>): Promise<T> {
  await ensureExtendedServicesReady()
  return operation()
}

export const skillsApi: RpcClient<typeof skillsRpc> = {
  skillsList: input => isElectron() ? desktop(() => window.halo.skillsList(input)) : httpRequest('POST', '/api/skills/list', { ...input }),
  skillsRead: input => isElectron() ? desktop(() => window.halo.skillsRead(input)) : httpRequest('POST', '/api/skills/read', { ...input }),
  skillsSave: input => isElectron() ? desktop(() => window.halo.skillsSave(input)) : httpRequest('POST', '/api/skills/save', { ...input }),
  skillsImport: input => isElectron() ? desktop(() => window.halo.skillsImport(input)) : httpRequest('POST', '/api/skills/import', { ...input }),
  skillsSetEnabled: input => isElectron() ? desktop(() => window.halo.skillsSetEnabled(input)) : httpRequest('POST', '/api/skills/set-enabled', { ...input }),
  skillsMovePreview: input => isElectron() ? desktop(() => window.halo.skillsMovePreview(input)) : httpRequest('POST', '/api/skills/move-preview', { ...input }),
  skillsMove: input => isElectron() ? desktop(() => window.halo.skillsMove(input)) : httpRequest('POST', '/api/skills/move', { ...input }),
  skillsCopy: input => isElectron() ? desktop(() => window.halo.skillsCopy(input)) : httpRequest('POST', '/api/skills/copy', { ...input }),
  skillsDelete: input => isElectron() ? desktop(() => window.halo.skillsDelete(input)) : httpRequest('POST', '/api/skills/delete', { ...input }),
  skillsOpenFolder: input => isElectron() ? desktop(() => window.halo.skillsOpenFolder(input)) : httpRequest('POST', '/api/skills/open-folder', { ...input }),
  skillsExport: input => isElectron() ? desktop(() => window.halo.skillsExport(input)) : httpRequest('POST', '/api/skills/export', { ...input }),
  skillsRestoreLegacy: input => isElectron() ? desktop(() => window.halo.skillsRestoreLegacy(input)) : httpRequest('POST', '/api/skills/restore-legacy', { ...input }),
  skillsDeleteLegacy: input => isElectron() ? desktop(() => window.halo.skillsDeleteLegacy(input)) : httpRequest('POST', '/api/skills/delete-legacy', { ...input }),
}

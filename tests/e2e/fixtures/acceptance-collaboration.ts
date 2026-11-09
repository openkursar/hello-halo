import type { ModelRequest } from './acceptance-model'

export interface CollaboratorReceipt { handle: string; name: string; status: 'accepted' }

/** A creation receipt names the exact actor; requested labels are not addresses. */
export function collaboratorReceipt(result: ModelRequest['toolResults'][number]): CollaboratorReceipt {
  if (result.error) throw new Error(`Collaborator creation was refused: ${result.text}`)
  const text = result.text.replace(/^Wall time: \d+(?:\.\d+)? seconds\r?\nOutput:\r?\n/, '')
  let value: unknown
  try { value = JSON.parse(text) }
  catch { throw new Error(`Collaborator creation did not return JSON: ${result.text}`) }
  if (Array.isArray(value)) {
    if (value.length !== 1 || value[0]?.type !== 'text' || typeof value[0].text !== 'string') {
      throw new Error(`Invalid collaborator creation receipt: ${result.text}`)
    }
    try { value = JSON.parse(value[0].text) }
    catch { throw new Error(`Collaborator creation text did not contain JSON: ${result.text}`) }
  }
  const receipt = value as Partial<CollaboratorReceipt> | null
  if (!receipt || typeof receipt.handle !== 'string' || !receipt.handle || typeof receipt.name !== 'string' || !receipt.name || receipt.status !== 'accepted') {
    throw new Error(`Invalid collaborator creation receipt: ${result.text}`)
  }
  return receipt as CollaboratorReceipt
}

export const retiredDailyTeamTools = ['collab_start', 'collab_save', 'team_complete', 'team_list', 'team_run', 'team_status'] as const

export function hasRetiredDailyTeamTool(request: Pick<ModelRequest, 'tools'>): boolean {
  return request.tools.some(tool => retiredDailyTeamTools.some(name => tool === name || tool.endsWith(`__${name}`)))
}

import type { RouteModuleMeta } from './_meta-types'
const returns = '{"success":boolean,"data"?:{"version":1,"revision":number,"policyRevision":number,"selectionMode":"inherit"|"task","profiles":array},"error"?:string,"code"?:string}'
export const MODULE: RouteModuleMeta = {
  file: 'subagent-models',
  routes: {
    'GET /api/subagent-models': { expose: 'ai', group: 'settings', summary: 'Read model assignments for new subagents', returns, notes: 'Includes three fixed unconfigured slots without saving them. Contains no credentials.' },
    'POST /api/subagent-models/create': { expose: 'ai', group: 'settings', summary: 'Create a custom model assignment when the owner requests it', returns, notes: 'Body: name, description, target ({kind:model,sourceId,modelId} or {kind:group,groupId}). Does not enable automatic selection.' },
    'POST /api/subagent-models/update': { expose: 'ai', group: 'settings', summary: 'Update a model assignment when the owner requests it', returns, notes: 'Body: id, expectedRevision (profile revision), description, target; name required for custom profiles and forbidden for builtins. Conflicts preserve stored settings.' },
    'POST /api/subagent-models/clear-builtin': { expose: 'ai', group: 'settings', summary: 'Clear a fixed model assignment target', returns, notes: 'Body: id, expectedRevision. Keeps the slot and purpose. Existing subagents remain unchanged. Clearing the final target restores inherit mode.' },
    'POST /api/subagent-models/delete': { expose: 'ai', group: 'settings', summary: 'Delete a custom model assignment', returns, notes: 'Body: id, expectedRevision. Builtins cannot be deleted. Existing subagents remain unchanged.' },
    'POST /api/subagent-models/set-selection-mode': { expose: 'ai', group: 'settings', summary: 'Change default subagent model selection only on explicit owner instruction', returns, notes: 'Body: selectionMode (inherit or task), expectedRevision (settings revision). Task requires at least one configured target; do not enable it without owner authorization.' },
  },
}

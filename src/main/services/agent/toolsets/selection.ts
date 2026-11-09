import type { ToolsetContextMode, ToolsetDefinition } from './types'

export function isToolsetIncluded(definition: ToolsetDefinition, open: ReadonlySet<string>, _mode: ToolsetContextMode): boolean {
  return definition.contextManaged === true || open.has(definition.id)
}

export function isToolsetConfigurable(definition: ToolsetDefinition, _mode: ToolsetContextMode | 'pending'): boolean {
  return definition.contextManaged !== true
}

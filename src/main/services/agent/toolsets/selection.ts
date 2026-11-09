import type { ToolsetContextMode, ToolsetDefinition } from './types'

/** An explicit conversation exclusion wins over automatic capability inclusion. */
export function isToolsetIncluded(
  definition: ToolsetDefinition,
  open: ReadonlySet<string>,
  _mode: ToolsetContextMode,
  excluded?: ReadonlySet<string>,
): boolean {
  return !excluded?.has(definition.id) && (definition.contextManaged === true || open.has(definition.id))
}

export function isToolsetConfigurable(definition: ToolsetDefinition, _mode: ToolsetContextMode | 'pending'): boolean {
  return definition.contextManaged !== true
}

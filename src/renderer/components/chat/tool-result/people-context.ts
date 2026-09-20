export interface PeopleContextReference {
  kind: 'team'
  teamId: string
  appId: string
  label: string
  epochId?: string
}

export function peopleContextReferences(toolName: string, output: string): PeopleContextReference[] | null {
  if (!/(?:^|__)read_digital_human_context$/.test(toolName)) return null
  try {
    const parsed: unknown = JSON.parse(output)
    if (!parsed || typeof parsed !== 'object') return null
    const references = (parsed as { references?: unknown }).references
    if (!Array.isArray(references)) return null
    const result = references.filter((item): item is PeopleContextReference => !!item && typeof item === 'object' && item.kind === 'team' && typeof item.teamId === 'string' && item.teamId.length > 0 && typeof item.appId === 'string' && item.appId.length > 0 && typeof item.label === 'string' && (item.epochId === undefined || typeof item.epochId === 'string'))
    return [...new Map(result.map(item => [`${item.teamId}:${item.epochId ?? ''}:${item.appId}`, item])).values()].slice(0, 50)
  } catch {
    // Incomplete streamed JSON retains the normal text renderer.
    return null
  }
}

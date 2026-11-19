/** Deletion impact returned by detailed workspace reads; never persisted in its metadata. */
export type SpaceDeletionEffect = 'workspace-files' | 'halo-data-only'

export interface SpaceDetailsRequestOptions {
  includeDeletionImpact?: boolean
}

/** Calculated for the explicit deletion preview only, never while listing spaces. */
export interface SpaceDeletionImpact {
  digitalHumans: Array<{ id: string; name: string }>
  activeWorkCount: number
}

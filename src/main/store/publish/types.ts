export type PublishTarget = 'github-pr' | 'http-registry' | 'local-dhpkg'

export interface PublishContext {
  /** Registry id whose `publish` config we are using (e.g. 'official') */
  registryId: string
  /** Registry base URL (resolved at call time, may differ from product config) */
  registryUrl: string | null
}

export type PublishStatus = 'success' | 'stubbed' | 'cancelled' | 'error'

export interface PublishResult {
  status: PublishStatus
  target: PublishTarget
  /** Human-readable explanation suitable for surfacing in the renderer. */
  details: string
  /** Optional path to a generated artifact (e.g. temp .dhpkg). */
  stagingPath?: string
  /** Optional URL associated with the result (e.g. the new PR draft). */
  url?: string
  /** Optional verdict from the registry (approved/needs_review/rejected). */
  verdict?: string
}

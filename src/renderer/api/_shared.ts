/**
 * Shared dependencies for the per-domain api modules.
 *
 * The unified `api` object (see `index.ts`) is composed from domain slices in
 * sibling `*.api.ts` files. They all need the same transport helpers, the
 * `ApiResponse` envelope type, and a few shared imports — re-exported here so
 * each slice has a single import source.
 */

export * from './transport'
export { getAppChatConversationId } from '../../shared/apps/im-keys'
export type {
  HealthStatusResponse,
  HealthStateResponse,
  HealthRecoveryResponse,
  HealthReportResponse,
  HealthExportResponse,
  HealthCheckResponse,
} from '../../shared/types'

/** Standard response envelope returned by every api method. */
export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  /**
   * Stable failure discriminator (e.g. 'ALREADY_INSTALLED'). Present on
   * known error modes so UI can render localized messages without parsing
   * the raw error text. Absent for unknown/unexpected failures.
   */
  code?: string
}

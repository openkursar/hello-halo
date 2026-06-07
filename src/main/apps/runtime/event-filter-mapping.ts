/**
 * Maps an event-source trigger to an EventRouter EventFilter, so the app runtime
 * and team scheduler derive identical filters from one place. Returns null for
 * source types not routed through the EventRouter (e.g. 'schedule').
 */

import type { EventFilter, FilterRule } from './event-types'

/**
 * Build the EventRouter filter for an event-source trigger.
 *
 * @param sourceType - The source discriminator ('file' | 'webhook' | 'wecom' | …)
 * @param config - Source-specific config (pattern/path/chatId/…); read by key,
 *   so both the app SubscriptionSource config and the team TeamTrigger config
 *   are accepted as long as field names match.
 * @returns The filter, or null when the source is not EventRouter-routed.
 */
export function sourceConfigToEventFilter(
  sourceType: string,
  config: Record<string, unknown>
): EventFilter | null {
  switch (sourceType) {
    case 'file': {
      const filter: EventFilter = { types: ['file.*'] }
      const rules: FilterRule[] = []

      // Apply pattern-based filtering if a glob pattern is specified
      const filePattern = config.pattern as string | undefined
      if (filePattern) {
        rules.push({
          field: 'payload.relativePath',
          op: 'matches',
          value: filePattern,
        })
      }

      // Apply path-based filtering if a directory is specified
      const filePath = config.path as string | undefined
      if (filePath) {
        const normalizedPath = filePath.replace(/\/+$/, '') // strip trailing slashes
        rules.push({
          field: 'payload.filePath',
          op: 'contains',
          value: normalizedPath,
        })
      }

      if (rules.length > 0) {
        filter.rules = rules
      }

      return filter
    }
    case 'webhook': {
      const filter: EventFilter = { types: ['webhook.received'] }
      // Add path-based filtering if a webhook path is specified
      const webhookPath = config.path as string | undefined
      if (webhookPath) {
        filter.rules = [{
          field: 'payload.path',
          op: 'eq',
          value: webhookPath.replace(/^\/+|\/+$/g, ''), // normalize: strip leading/trailing slashes
        }]
      }
      return filter
    }
    case 'webpage':
      return { types: ['webpage.changed'] }
    case 'rss':
      return { types: ['rss.updated'] }
    case 'wecom': {
      const filter: EventFilter = { types: ['wecom.message'] }
      const wecomChatId = config.chatId as string | undefined
      if (wecomChatId) {
        filter.rules = [{
          field: 'payload.chatId',
          op: 'eq',
          value: wecomChatId,
        }]
      }
      return filter
    }
    default:
      return null
  }
}

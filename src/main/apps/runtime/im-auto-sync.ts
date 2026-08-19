/**
 * apps/runtime -- IM Auto-Sync
 *
 * System-driven IM push at run completion. For every IM session whose
 * `proactive` flag has been toggled on by the user (in the digital human
 * detail page), push the assistant's final text response via the channel's
 * pushToChat method.
 *
 * Relationship to notify_bot (apps/runtime/notify-tool.ts):
 *   - auto-sync is system-driven, deterministic, fires once at run end
 *     with the verbatim assistant final text
 *   - notify_bot is AI-driven, invoked mid-run with AI-chosen content and
 *     AI-chosen recipients
 *   - Both can be active on the same app — prompt.ts injects an awareness
 *     block telling the AI which contacts are already auto-synced so it
 *     does not double-push them at run end
 *
 * Failure isolation: this module never throws. A failing push (transport
 * offline, instance removed) writes a warning to the log and continues
 * with the remaining subscribers. The run main flow is decoupled from
 * push outcomes.
 */

import { getImSessionRegistry } from './im-session-registry'
import { getActiveImChannelManager } from './im-channels'
import { truncateUtf16Safe } from './text-truncate'

/**
 * Maximum text body length sent to IM. WeCom markdown messages cap around
 * 4096 bytes; keeping body under 4000 characters leaves headroom for the
 * truncation marker without risk of platform-side rejection.
 */
const MAX_PUSH_LENGTH = 4000

/** Marker appended when text is truncated. */
const TRUNCATION_MARKER = '\n\n...(truncated, see Halo for full content)'

export interface AutoSyncInput {
  appId: string
  appName: string
  runId: string
  /** Assistant final text from the stream (StreamResult.finalText). */
  finalText: string
  /** Short run identifier prefix used in log lines. */
  runTag: string
}

export interface AutoSyncReport {
  /** Subscribed sessions found for this app. */
  subscribed: number
  /** Pushes that returned success. */
  sent: number
  /** Pushes skipped because the channel instance is unavailable / disconnected. */
  skipped: number
  /** Pushes the channel attempted but reported failure. */
  failed: number
}

/**
 * Push the assistant's final text to every subscribed IM contact for the
 * given app. Returns a summary report; never throws.
 *
 * Skip conditions (return an empty report without errors):
 *   - finalText is empty after trimming
 *   - registry is uninitialized
 *   - no sessions have proactive=true for this app
 */
export async function autoSyncRunResult(input: AutoSyncInput): Promise<AutoSyncReport> {
  const report: AutoSyncReport = { subscribed: 0, sent: 0, skipped: 0, failed: 0 }

  const text = input.finalText?.trim()
  if (!text) return report

  const registry = getImSessionRegistry()
  if (!registry) return report

  const subscribed = registry.getProactiveSessions(input.appId)
  if (subscribed.length === 0) return report
  report.subscribed = subscribed.length

  const manager = getActiveImChannelManager()
  if (!manager) {
    console.warn(
      `[Runtime][${input.runTag}] Auto-sync skipped: IM channel manager unavailable ` +
      `(${subscribed.length} subscriber(s) waiting)`
    )
    report.skipped = subscribed.length
    return report
  }

  const body = text.length > MAX_PUSH_LENGTH
    ? truncateUtf16Safe(text, MAX_PUSH_LENGTH) + TRUNCATION_MARKER
    : text

  // Sequential dispatch preserves message ordering on the same IM connection
  // and matches the legacy behavior. The subscriber count is small (typically
  // single-digit) so the latency impact is negligible.
  for (const session of subscribed) {
    try {
      const instance = manager.getInstance(session.instanceId)
      if (!instance) {
        console.warn(
          `[Runtime][${input.runTag}] Auto-sync skip: instance "${session.instanceId}" ` +
          `not found (chat=${session.chatId})`
        )
        report.skipped++
        continue
      }
      if (!instance.isConnected()) {
        console.warn(
          `[Runtime][${input.runTag}] Auto-sync skip: instance "${session.instanceId}" ` +
          `disconnected (chat=${session.chatId})`
        )
        report.skipped++
        continue
      }

      const ok = instance.pushToChat(session.chatId, body, session.chatType)
      if (ok) {
        report.sent++
      } else {
        console.warn(
          `[Runtime][${input.runTag}] Auto-sync push rejected: chat=${session.chatId} ` +
          `on instance "${session.instanceId}"`
        )
        report.failed++
      }
    } catch (err) {
      console.warn(
        `[Runtime][${input.runTag}] Auto-sync error on chat=${session.chatId}:`,
        err
      )
      report.failed++
    }
  }

  console.log(
    `[Runtime][${input.runTag}] Auto-sync complete: app="${input.appName}", ` +
    `subscribed=${report.subscribed}, sent=${report.sent}, ` +
    `skipped=${report.skipped}, failed=${report.failed}`
  )
  return report
}

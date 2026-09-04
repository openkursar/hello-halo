/**
 * Apps Analytics Subscriber
 *
 * Wires AppManagerService and AppRuntimeService lifecycle events into
 * the analytics pipeline. Events are emitted as fire-and-forget telemetry
 * — handlers never block or throw into the business path.
 *
 * Contract:
 *   - `app.installed` / `app.uninstalled` come from AppManagerService
 *   - `app.run.started` / `app.run.completed` / `app.run.failed` come from
 *     AppRuntimeService
 *
 * All properties forwarded here are structural identifiers (ids, specIds,
 * statuses, timestamps, durations). No user content, no prompts, no file
 * paths. The telemetry provider applies a second whitelist pass on top of
 * this, so additions here are still filtered if they aren't in the
 * per-event whitelist.
 */

import type { AppManagerService, InstalledApp } from '../../../apps/manager'
import type {
  AppRuntimeService,
  RunFinishedEvent,
  RunStartedEvent,
} from '../../../apps/runtime/types'
import { analytics } from '../analytics.service'
import { AnalyticsEvents } from '../types'
import { deriveErrorCode } from '../error-code'

/** Unsubscribe functions returned by the two services, stored for cleanup. */
type Unsub = () => void

/**
 * Install subscribers on the given services.
 *
 * Idempotent-friendly: callers should only invoke this once per service
 * instance (the bootstrap flow guarantees this). Returns an unsubscribe
 * function that tears down all registrations. Shutdown is currently a
 * no-op because the process exits shortly after cleanup — the unsubscribe
 * is exposed for testability.
 */
export function installAppsSubscribers(
  appManager: AppManagerService,
  runtime: AppRuntimeService
): () => void {
  const unsubscribers: Unsub[] = []

  unsubscribers.push(
    appManager.onAppInstalled((app: InstalledApp) => {
      // `track` is async but we intentionally do not await — analytics is
      // fire-and-forget. Errors are swallowed by the analytics service.
      void analytics.track(AnalyticsEvents.APP_INSTALLED, {
        appId: app.id,
        specId: app.specId,
        version: app.spec.version,
        type: app.spec.type,
      })
    })
  )

  unsubscribers.push(
    appManager.onAppUninstalled((app: InstalledApp) => {
      void analytics.track(AnalyticsEvents.APP_UNINSTALLED, {
        appId: app.id,
        specId: app.specId,
        type: app.spec.type,
      })
    })
  )

  unsubscribers.push(
    runtime.onRunStarted((evt: RunStartedEvent) => {
      // Reverse-lookup specId so the backend can label runs even when the
      // event payload doesn't carry it directly. The optional chain guards
      // the tiny race where an uninstall completes between RunStarted/Finished
      // and this subscriber — losing specId is fine, the appId stays the
      // aggregation key. specId is gated by SENSITIVE_KEYS at sanitize time,
      // so open-source builds drop it before transmission.
      const specId = appManager.getApp(evt.appId)?.specId
      void analytics.track(AnalyticsEvents.APP_RUN_STARTED, {
        appId: evt.appId,
        specId,
        runId: evt.runId,
        trigger: evt.triggerType,
      })
    })
  )

  unsubscribers.push(
    runtime.onRunFinished((evt: RunFinishedEvent) => {
      // Split the event into two telemetry names so dashboards can filter
      // failures without an additional status predicate.
      const eventName =
        evt.status === 'error'
          ? AnalyticsEvents.APP_RUN_FAILED
          : AnalyticsEvents.APP_RUN_COMPLETED

      const specId = appManager.getApp(evt.appId)?.specId
      void analytics.track(eventName, {
        appId: evt.appId,
        specId,
        runId: evt.runId,
        trigger: evt.triggerType,
        status: evt.status,
        durationMs: evt.durationMs,
        tokensUsed: evt.tokensUsed,
        // Only include errorCode on failures. Keep it to a short identifier;
        // the detailed message is never forwarded.
        errorCode:
          evt.status === 'error' && evt.errorMessage
            ? deriveErrorCode(evt.errorMessage)
            : undefined,
      })
    })
  )

  return () => {
    for (const unsub of unsubscribers) {
      try {
        unsub()
      } catch (err) {
        console.warn('[Analytics/Apps] Unsubscribe failed:', err)
      }
    }
  }
}

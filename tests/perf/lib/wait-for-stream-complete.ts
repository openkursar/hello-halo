import type { Page } from '@playwright/test'

/**
 * Waits for the assistant message to actually finish streaming, by watching
 * the `.streaming-cursor` element: appear (streaming genuinely started),
 * then disappear (genuinely finished).
 *
 * `waitForAIResponse` (tests/e2e/fixtures/helpers.ts) waits for the
 * "Halo 工作中/Halo is working" indicator to hide, wrapped in `.catch(() =>
 * {})`. That indicator (`isWorking`) covers the pre-content "thinking"
 * phase and is long gone once real token deltas start arriving — waiting on
 * it resolves near-instantly instead of tracking the actual stream (same
 * "indicator already gone -> false instant success" shape as the
 * file-preview loading indicator, see open-artifact.ts's
 * `assertCanvasHasOpenTab`).
 *
 * `.streaming-cursor` was picked over a class on the message container
 * itself because the *live* streaming bubble is a different component
 * (`StreamingBubble.tsx`) from the *persisted* message item
 * (`MessageItem.tsx`) — `isStreaming ? ...streaming-cursor... : null` is the
 * one element both of them render identically while (and only while)
 * actively streaming.
 */
export async function waitForStreamComplete(window: Page, timeoutMs = 60000): Promise<void> {
  await window.waitForSelector('.streaming-cursor', { timeout: 10000 })
  await window.waitForSelector('.streaming-cursor', { state: 'detached', timeout: timeoutMs })
}

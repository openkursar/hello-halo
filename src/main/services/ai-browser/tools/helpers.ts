/**
 * AI Browser Tools - Shared helpers and constants
 *
 * Utility functions used across multiple tool categories.
 */

import { nativeImage } from 'electron'
import type { BrowserContext } from '../context'
import { requestCredential } from '../credential-broker'
import { checkFill, type FillCheck } from '../fill-check'

// ============================================
// Constants
// ============================================

/** Default per-tool timeout (ms). Individual tools may override. */
export const TOOL_TIMEOUT = 60_000
/** Default navigation wait timeout (ms). */
export const NAV_TIMEOUT = 30_000

/** Appended to a new page's result when it could not open where the user can watch it. */
export const BACKGROUND_PAGE_NOTE = '\nNote: the Halo window could not show this page in time, so it opened in the background. It works normally, but the user cannot watch it live.'

/**
 * Hard cap for a single image in base64 characters (~375KB raw).
 * Acts as Layer 2 safety net after context.ts Layer 1 compression.
 */
const IMAGE_HARD_CAP_BASE64 = 500_000

// ============================================
// Helpers
// ============================================

/** Convenience: wrap a promise with a timeout guard. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) }
    )
  })
}

/** Build a standard text content response. */
export function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {})
  }
}

/**
 * Build an image + text content response.
 *
 * Enforces a per-image hard cap (Layer 2). If the image exceeds
 * IMAGE_HARD_CAP_BASE64, it is progressively degraded:
 *   1. Re-encode as JPEG quality 60
 *   2. If still too large, resize to half dimensions + JPEG quality 50
 * Falls back to original data if nativeImage processing fails.
 */
export function imageResult(text: string, data: string, mimeType: string) {
  let finalData = data
  let finalMime = mimeType

  if (finalData.length > IMAGE_HARD_CAP_BASE64) {
    try {
      const buf = Buffer.from(finalData, 'base64')
      const img = nativeImage.createFromBuffer(buf)

      if (!img.isEmpty()) {
        // Step 1: re-encode at lower quality
        let jpegBuf = img.toJPEG(60)

        if (jpegBuf.toString('base64').length > IMAGE_HARD_CAP_BASE64) {
          // Step 2: resize to half + even lower quality
          const { width, height } = img.getSize()
          const half = img.resize({
            width: Math.round(width / 2),
            height: Math.round(height / 2),
            quality: 'better'
          })
          jpegBuf = half.toJPEG(50)
        }

        finalData = jpegBuf.toString('base64')
        finalMime = 'image/jpeg'
      }
    } catch (error) {
      // Layer 2 compression failed — pass through original data
      console.warn('[AI Browser] imageResult hard-cap compression failed:', error)
    }
  }

  return {
    content: [
      { type: 'text' as const, text },
      { type: 'image' as const, data: finalData, mimeType: finalMime }
    ]
  }
}

/**
 * Determine how to fill a form element, handling combobox disambiguation.
 * Typed text is read back; an option chosen from a list is not.
 */
export async function fillFormElement(
  ctx: BrowserContext,
  uid: string,
  value: string
): Promise<FillCheck | { status: 'selected' }> {
  const element = ctx.getElementByUid(uid)

  if (element && element.role === 'combobox') {
    const hasOptions = element.children?.some(child => child.role === 'option')
    if (hasOptions) {
      try {
        await ctx.selectOption(uid, value)
        return { status: 'selected' }
      } catch (e) {
        // Only fall back for "option not found" — rethrow infrastructure errors (CDP failures, etc.)
        if (!(e instanceof Error) || !e.message.includes('Could not find option')) {
          throw e
        }
        // No matching option — combobox may be editable, fall back to text input
      }
    }
    // Editable combobox (no options, or no matching option) — fill as text
    return checkFill(value, await ctx.fillElement(uid, value))
  }

  return checkFill(value, await ctx.fillElement(uid, value))
}

function webOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

export async function fillSecretFields(
  ctx: BrowserContext,
  uids: string[],
  purpose: string,
  submitUid: string | undefined,
  signal?: AbortSignal,
): Promise<'submitted' | 'declined' | 'expired' | 'moved' | 'unconfirmed'> {
  const viewId = ctx.getActiveViewId()
  const contents = ctx.getWebContents()
  const snapshot = ctx.getLastSnapshot()
  if (!viewId || !contents || !snapshot || !ctx.isWatchable(viewId) || !ctx.conversationId) {
    throw new Error('Open a page the user can see and take a fresh browser snapshot first')
  }
  const url = contents.getURL()
  const origin = webOrigin(url)
  if (!origin || snapshot.url !== url) throw new Error('Take a fresh snapshot of the form first')
  const fields = uids.map(uid => {
    const element = ctx.getElementByUid(uid)
    if (!element) throw new Error('A requested field is no longer available')
    return { uid, label: (element.name || element.description || element.role).slice(0, 200) }
  })
  if (submitUid && !ctx.getElementByUid(submitUid)) throw new Error('The submit button is no longer available')

  const page = new AbortController()
  const abort = () => page.abort()
  let submitting = false
  const onNavigation = (_event: Electron.Event, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame && !submitting) abort()
  }
  contents.on('did-start-navigation', onNavigation)
  contents.once('destroyed', abort)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try {
    const outcome = await requestCredential({
      conversationId: ctx.conversationId,
      spaceId: ctx.spaceId,
      viewId,
      origin,
      title: snapshot.title?.slice(0, 200) ?? null,
      fields,
      purpose,
    }, page.signal)
    if (page.signal.aborted) return signal?.aborted ? 'expired' : 'moved'
    if (outcome.status !== 'provided') return outcome.status
    if (ctx.getActiveViewId() !== viewId || contents.getURL() !== url || ctx.getLastSnapshot() !== snapshot) return 'moved'
    const submitted = await ctx.submitUserText(snapshot, outcome.values, submitUid, page.signal, () => { submitting = true })
    return submitted ? 'submitted' : 'unconfirmed'
  } finally {
    contents.off('did-start-navigation', onNavigation)
    contents.off('destroyed', abort)
    signal?.removeEventListener('abort', abort)
  }
}

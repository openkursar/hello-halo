/**
 * AI Browser Tools - Shared helpers and constants
 *
 * Utility functions used across multiple tool categories.
 */

import { nativeImage } from 'electron'
import type { BrowserContext } from '../context'
import { CREDENTIAL_WAIT_MS, requestCredential } from '../credential-broker'
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

/** How long the fill-and-submit leg may take once the user has answered. */
const SECRET_FILL_TIMEOUT = 30_000

/** The http(s) origin of a page, or null for anything that has none. */
function webOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

/**
 * Ask the user to type into the named fields, then fill and submit them.
 *
 * Three properties the caller depends on:
 *  - the wait happens between page operations, not inside one, so a prompt the
 *    user leaves sitting does not hold the page's frame lease open;
 *  - the origin is re-read after the wait and the fill is abandoned if the page
 *    moved, so text typed for one site cannot be delivered to another;
 *  - filling and submitting are one leg, so the model gets no turn while a
 *    field still holds the value.
 */
export async function fillSecretFields(
  ctx: BrowserContext,
  uids: string[],
  purpose: string,
  submitUid: string | undefined
): Promise<{ status: 'submitted' | 'declined' | 'expired' | 'moved'; detail?: string }> {
  const viewId = ctx.getActiveViewId()
  if (!viewId) throw new Error('No active browser page')

  const fields = uids.map(uid => {
    const element = ctx.getElementByUid(uid)
    if (!element) throw new Error(`Element not found: ${uid}. Take a browser_snapshot and use its uids.`)
    return { uid, label: element.name || element.description || element.role }
  })

  // The user is asked to trust a named origin, so a page without one (blank,
  // about:, a local file) cannot be the destination: they would be shown
  // "null" and asked to type a code into it.
  const origin = webOrigin(ctx.getPageUrl())
  if (!origin) throw new Error('This page has no web address to show the user, so nothing can be typed into it')

  const outcome = await requestCredential({
    conversationId: ctx.conversationId,
    spaceId: ctx.spaceId,
    viewId,
    origin,
    title: ctx.getLastSnapshot()?.title ?? null,
    fields,
    purpose,
  })
  if (outcome.status !== 'provided') return { status: outcome.status === 'declined' ? 'declined' : 'expired' }

  if (ctx.getActiveViewId() !== viewId || webOrigin(ctx.getPageUrl()) !== origin) {
    return { status: 'moved', detail: `the page is no longer on ${origin}, so nothing was typed` }
  }

  const problems: string[] = []
  for (const field of fields) {
    const value = outcome.values.get(field.uid)
    if (value === undefined) continue
    const check = checkFill(value, await withTimeout(ctx.fillElementWithUserText(field.uid, value), SECRET_FILL_TIMEOUT, 'browser_fill_secret'), true)
    if (check.status !== 'match') problems.push(`${field.uid}: ${check.detail}`)
  }

  await withTimeout(
    submitUid ? ctx.clickElement(submitUid) : ctx.pressKey('Enter'),
    SECRET_FILL_TIMEOUT,
    'browser_fill_secret(submit)'
  )

  return { status: 'submitted', detail: problems.length ? problems.join('\n') : undefined }
}

/** Longest a single browser_fill_secret call can run: the user's think time plus both page legs. */
export const SECRET_TOOL_TIMEOUT = CREDENTIAL_WAIT_MS + 2 * SECRET_FILL_TIMEOUT

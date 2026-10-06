/**
 * Stealth Module
 *
 * Browser fingerprint evasion for embedded Chromium pages.
 * Ported from puppeteer-extra-plugin-stealth (MIT License).
 *
 * This module provides anti-fingerprinting capabilities to make
 * the embedded browser appear as a regular Chrome browser.
 */

import type { WebContents } from 'electron'
import { stealthUtils } from './utils'
import {
  navigatorWebdriverEvasion,
  navigatorVendorEvasion,
  navigatorLanguagesEvasion,
  navigatorHardwareConcurrencyEvasion,
  navigatorPluginsEvasion,
  navigatorPermissionsEvasion,
  chromeAppEvasion,
  chromeCsiEvasion,
  chromeLoadTimesEvasion,
  chromeRuntimeEvasion,
  webglVendorEvasion,
  mediaCodecsEvasion,
  iframeContentWindowEvasion,
  windowOuterdimensionsEvasion
} from './evasions'

/**
 * Build the complete stealth script by combining utils and all evasions.
 * The script is wrapped in an IIFE to avoid polluting the global scope.
 */
function buildStealthScript(): string {
  return `
(function() {
  'use strict';

  // ============================================================================
  // Stealth Utils
  // ============================================================================
  ${stealthUtils}

  // Initialize utils
  utils.init();

  // ============================================================================
  // Evasions
  // ============================================================================

  // Navigator Webdriver (run first, simple delete)
  ${navigatorWebdriverEvasion}

  // Window Outer Dimensions
  ${windowOuterdimensionsEvasion}

  // Chrome Object Mocks (must run before navigator.plugins for chrome reference)
  ${chromeAppEvasion}
  ${chromeCsiEvasion}
  ${chromeLoadTimesEvasion}
  ${chromeRuntimeEvasion}

  // Navigator Properties
  ${navigatorVendorEvasion}
  ${navigatorLanguagesEvasion}
  ${navigatorHardwareConcurrencyEvasion}
  ${navigatorPermissionsEvasion}

  // Navigator Plugins (complex, depends on MimeType/Plugin prototypes)
  ${navigatorPluginsEvasion}

  // WebGL
  ${webglVendorEvasion}

  // Media Codecs
  ${mediaCodecsEvasion}

  // Iframe ContentWindow (run last as it hooks document.createElement)
  ${iframeContentWindowEvasion}

  // console.log('[Stealth] All evasions applied successfully');
})();
`
}

// Pre-built script for performance (build once, use many times)
let cachedStealthScript: string | null = null

/**
 * Get the stealth script (cached for performance).
 */
export function getStealthScript(): string {
  if (!cachedStealthScript) {
    cachedStealthScript = buildStealthScript()
  }
  return cachedStealthScript
}

/**
 * Inject stealth scripts into a WebContents instance using CDP.
 *
 * This uses Chrome DevTools Protocol's Page.addScriptToEvaluateOnNewDocument
 * to inject scripts BEFORE any page JavaScript runs, which is critical for
 * evading fingerprint detection that runs early in page load.
 *
 * Install before navigating the guest to an external URL.
 *
 * @param webContents - The WebContents instance to inject into
 */
export async function injectStealthScripts(webContents: WebContents): Promise<void> {
  const script = getStealthScript()

  try {
    // Attach debugger to use CDP commands
    // Protocol version 1.3 is widely supported
    webContents.debugger.attach('1.3')

    // Use CDP to inject script before any page scripts run
    // This is equivalent to puppeteer's evaluateOnNewDocument
    await webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: script
    })

    // Handle debugger detach gracefully (e.g., when DevTools is opened)
    webContents.debugger.on('detach', (_event, reason) => {
      if (reason !== 'target closed') {
        console.log('[Stealth] Debugger detached:', reason)
      }
    })

    console.log('[Stealth] CDP injection configured successfully')
  } catch (err) {
    // Debugger might already be attached or CDP failed
    // Fall back to the event-based method
    console.warn('[Stealth] CDP injection failed, using fallback method:', err)
    setupFallbackInjection(webContents, script)
  }
}

/**
 * Fallback injection method using event-based executeJavaScript.
 * Less effective but provides compatibility if CDP fails.
 */
function setupFallbackInjection(webContents: WebContents, script: string): void {
  // Inject on initial navigation and every subsequent main frame navigation
  webContents.on('did-start-navigation', async (_event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame && !url.startsWith('devtools://')) {
      try {
        webContents.once('dom-ready', async () => {
          try {
            await webContents.executeJavaScript(script, true)
          } catch (err) {
            // Silently ignore errors (page might have navigated away)
          }
        })
      } catch (err) {
        // Silently ignore errors
      }
    }
  })

  // Also inject immediately if there's already a page loaded
  try {
    const url = webContents.getURL()
    if (url && !url.startsWith('devtools://') && url !== 'about:blank') {
      webContents.executeJavaScript(script, true).catch(() => {})
    }
  } catch (err) {
    // Silently ignore errors
  }

  console.log('[Stealth] Fallback injection configured')
}

/**
 * Inject stealth scripts once (for single page injection without auto-reinject).
 *
 * @param webContents - The WebContents instance to inject into
 */
export async function injectStealthScriptsOnce(webContents: WebContents): Promise<void> {
  const script = getStealthScript()

  try {
    await webContents.executeJavaScript(script, true)
    console.log('[Stealth] Stealth scripts injected successfully')
  } catch (err) {
    console.error('[Stealth] Failed to inject stealth scripts:', err)
  }
}

// Export types
export interface StealthConfig {
  languages?: string[]
  vendor?: string
  hardwareConcurrency?: number
  webglVendor?: string
  webglRenderer?: string
}

// Export for testing
export { buildStealthScript }

/**
 * Bootstrap Module - Application Startup Initialization
 *
 * This module manages the phased initialization of Halo services.
 * All service registration is organized into two phases to optimize startup time.
 *
 * ========================================
 * INITIALIZATION PHASES
 * ========================================
 *
 * Essential (First Phase)
 *   - Services required for first screen render
 *   - Target: < 500ms total
 *   - Adding new services requires:
 *     1. Performance measurement
 *     2. Architecture review
 *     3. Documentation of rationale
 *
 * Extended (Second Phase)
 *   - All other services
 *   - Loaded after window is visible: extended.ts is reached only through
 *     the dynamic import below, so its code and every module only it
 *     imports stay out of what the main process loads before the window
 *     opens. Never import it, or a module only it needs, statically from
 *     the first phase.
 *   - Uses lazy initialization pattern
 *   - DEFAULT for new features
 *
 * ========================================
 * DECISION GUIDE
 * ========================================
 *
 * Ask: "Does the user need this feature immediately after app opens,
 *       without any interaction?"
 *
 *   YES -> Essential (requires review)
 *   NO  -> Extended (default)
 *
 * Examples:
 *   - Space list display -> Essential
 *   - AI Browser tools   -> Extended
 *   - Search feature     -> Extended
 *   - Performance monitor -> Extended
 *
 * ========================================
 * PERFORMANCE VALIDATION
 * ========================================
 *
 * When adding to Essential, measure with:
 *
 *   const start = performance.now()
 *   // initialization code
 *   console.log(`[Bootstrap] Module init: ${performance.now() - start}ms`)
 *
 */

export { initializeEssentialServices } from './essential'
export { getBootstrapStatus } from './state'
export type { BootstrapStatus } from './state'
export { applyServerModeSwitches, installServerSignalHandlers, bootServerMode } from './server-mode'

export async function initializeExtendedServices(): Promise<void> {
  const extended = await import('./extended')
  extended.initializeExtendedServices()
}

/** Also cleans up first-phase services, so it runs even when the extended phase never started. */
export async function cleanupExtendedServices(): Promise<void> {
  const extended = await import('./extended')
  await extended.cleanupExtendedServices()
}

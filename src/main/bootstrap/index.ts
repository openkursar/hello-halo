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
 *   - Loaded after window is visible
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
export { initializeExtendedServices, cleanupExtendedServices } from './extended'

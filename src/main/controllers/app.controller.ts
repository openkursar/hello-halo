/**
 * App Controller - Unified business logic for App import/export
 *
 * Used by both IPC handlers and HTTP routes to avoid duplicating
 * the spec serialization, validation, install, and activation logic.
 */

import { stringify as stringifyYaml } from 'yaml'
import { getAppManager } from '../apps/manager'
import { AppAlreadyInstalledError, McpCommandBlockedError } from '../apps/manager/errors'
import { getAppRuntime } from '../apps/runtime'
import { parseAndValidateAppSpec, AppSpecValidationError, type AppSpec } from '../apps/spec'
import { MCP_COMMAND_BLOCKED_MESSAGE } from '../services/security-policy'

// ============================================================================
// Error Codes
// ============================================================================

/**
 * Structured error codes returned by controller functions.
 *
 * Callers (IPC/HTTP) use these to map to appropriate transport-level
 * responses (HTTP status codes, IPC error formats) without relying
 * on fragile error message string matching.
 */
export type AppErrorCode =
  | 'NOT_INITIALIZED'      // AppManager not ready yet (→ HTTP 503)
  | 'NOT_FOUND'            // App ID does not exist (→ HTTP 404)
  | 'INVALID_YAML'         // YAML parse error (→ HTTP 400)
  | 'VALIDATION_FAILED'    // Spec schema validation error (→ HTTP 422)
  | 'ALREADY_INSTALLED'    // Same-name app already installed in target scope (→ HTTP 409)
  | 'MCP_COMMAND_BLOCKED'  // MCP stdio command matches security.mcpCommandBlacklist (→ HTTP 403)

/** Controller error response with optional structured code */
export interface AppControllerError {
  success: false
  error: string
  code?: AppErrorCode
}

/** Controller success response */
export interface AppControllerSuccess<T> {
  success: true
  data: T
}

export type AppControllerResponse<T> = AppControllerSuccess<T> | AppControllerError

// ============================================================================
// Export
// ============================================================================

export interface ExportSpecResult {
  yaml: string
  filename: string
}

/**
 * Export an app's spec as a clean YAML string with a suggested filename.
 */
export function exportSpec(appId: string): AppControllerResponse<ExportSpecResult> {
  try {
    const manager = getAppManager()
    if (!manager) {
      return { success: false, error: 'App Manager is not yet initialized. Please try again shortly.', code: 'NOT_INITIALIZED' }
    }

    const app = manager.getApp(appId)
    if (!app) {
      return { success: false, error: `App not found: ${appId}`, code: 'NOT_FOUND' }
    }

    // Strip undefined/null fields for clean YAML output
    const clean = JSON.parse(JSON.stringify(app.spec))
    const yaml = stringifyYaml(clean, { lineWidth: 0 })

    // Derive a safe filename: "{name}-{version}.yaml"
    const slug = app.spec.name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
    const filename = `${slug}-${app.spec.version ?? '1.0'}.yaml`

    return { success: true, data: { yaml, filename } }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

// ============================================================================
// Install (from a parsed/validated spec object)
// ============================================================================

export interface InstallAppResult {
  appId: string
  /** Non-fatal runtime activation error message, if activation failed. */
  activationWarning?: string
}

/**
 * Install an app from an already-parsed spec object: install + auto-activate,
 * returning structured error codes. Shared by `ipc/app.ts` (app:install) and
 * `http/routes/apps.routes.ts` (POST /api/apps/install) so the install +
 * activation orchestration and error-code mapping live in one place.
 *
 * Note: MCP-policy gating (`security.mcpCommandBlacklist`) is enforced inside
 * `manager.install()`; transport-layer pre-checks (e.g. remote-MCP rejection)
 * stay at the boundary where the response shape differs per transport.
 */
export async function installApp(
  spaceId: string | null,
  spec: AppSpec,
  userConfig?: Record<string, unknown>,
  opts?: {
    /**
     * Whether to auto-activate non-automation apps (MCP/Skill) after install.
     * Defaults to true (IPC + importSpec behavior). The HTTP install route
     * passes false to keep its original "activate automation apps only"
     * semantics — preserved here rather than silently unified.
     */
    activateNonAutomation?: boolean
  },
): Promise<AppControllerResponse<InstallAppResult>> {
  try {
    const manager = getAppManager()
    if (!manager) {
      return { success: false, error: 'App Manager is not yet initialized. Please try again shortly.', code: 'NOT_INITIALIZED' }
    }

    const appId = await manager.install(spaceId, spec, userConfig)

    // Auto-activate in runtime if available (non-fatal on failure)
    const runtime = getAppRuntime()
    const activateNonAutomation = opts?.activateNonAutomation ?? true
    const shouldActivate = !!runtime && (activateNonAutomation || (spec as { type?: string }).type === 'automation')
    let activationWarning: string | undefined
    if (runtime && shouldActivate) {
      try {
        await runtime.activate(appId)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.warn(`[AppController] installApp: runtime activate failed (non-fatal): ${errMsg}`)
        activationWarning = errMsg
      }
    }

    return { success: true, data: { appId, activationWarning } }
  } catch (error: unknown) {
    const err = error as Error
    if (error instanceof McpCommandBlockedError) {
      console.warn(`[AppController] installApp: blocked MCP command '${error.command}'`)
      return { success: false, error: MCP_COMMAND_BLOCKED_MESSAGE, code: 'MCP_COMMAND_BLOCKED' }
    }
    if (error instanceof AppAlreadyInstalledError) {
      return { success: false, error: err.message, code: 'ALREADY_INSTALLED' }
    }
    return { success: false, error: err.message }
  }
}

// ============================================================================
// Import
// ============================================================================

export interface ImportSpecInput {
  spaceId: string | null
  yamlContent: string
  userConfig?: Record<string, unknown>
}

export interface ImportSpecResult {
  appId: string
  activationWarning?: string
}

/**
 * Import an app from a YAML spec string: parse, validate, install, and auto-activate.
 *
 * Returns structured error codes so callers can map to appropriate HTTP status
 * codes without relying on error message string matching.
 */
export async function importSpec(
  input: ImportSpecInput
): Promise<AppControllerResponse<ImportSpecResult>> {
  try {
    const manager = getAppManager()
    if (!manager) {
      return { success: false, error: 'App Manager is not yet initialized. Please try again shortly.', code: 'NOT_INITIALIZED' }
    }

    // Parse YAML and validate spec in one step
    let spec
    try {
      spec = parseAndValidateAppSpec(input.yamlContent)
    } catch (parseErr) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr)
      if (parseErr instanceof AppSpecValidationError) {
        return { success: false, error: `Spec validation failed: ${msg}`, code: 'VALIDATION_FAILED' }
      }
      return { success: false, error: `Invalid YAML: ${msg}`, code: 'INVALID_YAML' }
    }

    const appId = await manager.install(input.spaceId, spec, input.userConfig)

    // Auto-activate in runtime if available
    const runtime = getAppRuntime()
    let activationWarning: string | undefined
    if (runtime) {
      try {
        await runtime.activate(appId)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.warn(`[AppController] importSpec: runtime activate failed (non-fatal): ${errMsg}`)
        activationWarning = errMsg
      }
    }

    return { success: true, data: { appId, activationWarning } }
  } catch (error: unknown) {
    const err = error as Error
    if (error instanceof McpCommandBlockedError) {
      console.warn(`[AppController] importSpec: blocked MCP command '${error.command}'`)
      return { success: false, error: MCP_COMMAND_BLOCKED_MESSAGE, code: 'MCP_COMMAND_BLOCKED' }
    }
    if (error instanceof AppAlreadyInstalledError) {
      return { success: false, error: err.message, code: 'ALREADY_INSTALLED' }
    }
    return { success: false, error: err.message }
  }
}

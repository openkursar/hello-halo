/**
 * Config Probe - Configuration file health check
 *
 * Checks:
 * - Config file exists
 * - JSON is valid
 * - Critical fields are present
 * - API key is configured
 */

import { existsSync, readFileSync } from 'fs'
import type { ConfigProbeResult } from '../../types'
import { getConfigPath } from '../../../config.service'

/**
 * Check configuration file health
 */
export async function runConfigProbe(): Promise<ConfigProbeResult> {
  const configPath = getConfigPath()
  const errors: string[] = []

  let fileExists = false
  let jsonValid = false
  let criticalFieldsPresent = false
  let apiKeyConfigured = false

  try {
    // Check file exists
    fileExists = existsSync(configPath)

    if (!fileExists) {
      return {
        name: 'config',
        healthy: false,
        severity: 'info',  // Missing config is OK on first launch
        message: 'Config file not found, will be created on first launch',
        timestamp: Date.now(),
        data: {
          fileExists,
          jsonValid,
          criticalFieldsPresent,
          apiKeyConfigured,
          errors: ['Config file does not exist']
        }
      }
    }

    // Try to parse JSON
    let config: Record<string, unknown>
    try {
      const content = readFileSync(configPath, 'utf-8')
      config = JSON.parse(content)
      jsonValid = true
    } catch (parseError) {
      errors.push(`JSON parse error: ${(parseError as Error).message}`)
      return {
        name: 'config',
        healthy: false,
        severity: 'critical',
        message: 'Config file is corrupted (invalid JSON)',
        timestamp: Date.now(),
        data: {
          fileExists,
          jsonValid,
          criticalFieldsPresent,
          apiKeyConfigured,
          errors
        }
      }
    }

    // Check critical fields
    const aiSources = config.aiSources as Record<string, unknown> | undefined
    const hasPermissions = config.permissions && typeof config.permissions === 'object'

    // Support both v1 (aiSources.current) and v2 (aiSources.currentId) formats
    const isV2 = aiSources?.version === 2
    const hasAiSourcesCurrent = isV2
      ? (aiSources?.currentId !== undefined) // v2: currentId can be null or string
      : (aiSources && typeof aiSources.current === 'string') // v1: current is string

    criticalFieldsPresent = !!(hasAiSourcesCurrent && hasPermissions)

    if (!hasAiSourcesCurrent) {
      errors.push(isV2 ? 'Missing aiSources.currentId field' : 'Missing aiSources.current field')
    }
    if (!hasPermissions) {
      errors.push('Missing permissions field')
    }

    // Check API key configuration
    if (isV2) {
      // v2 format: check sources array
      const sources = aiSources?.sources as Array<Record<string, unknown>> | undefined
      const currentId = aiSources?.currentId as string | null | undefined
      const currentSource = sources?.find(s => s.id === currentId)

      if (currentSource) {
        const authType = currentSource.authType as string | undefined
        if (authType === 'api-key') {
          apiKeyConfigured = !!(currentSource.apiKey && typeof currentSource.apiKey === 'string' && currentSource.apiKey.length > 0)
        } else if (authType === 'oauth') {
          apiKeyConfigured = !!(currentSource.accessToken && typeof currentSource.accessToken === 'string')
        }
      }
    } else {
      // v1 format: legacy check
      const currentSource = aiSources?.current as string | undefined
      if (currentSource === 'custom') {
        const custom = aiSources?.custom as Record<string, unknown> | undefined
        apiKeyConfigured = !!(custom?.apiKey && typeof custom.apiKey === 'string' && custom.apiKey.length > 0)
      } else if (currentSource && currentSource !== 'custom') {
        // OAuth provider - check for access token
        const provider = aiSources?.[currentSource] as Record<string, unknown> | undefined
        apiKeyConfigured = !!(provider?.accessToken && typeof provider.accessToken === 'string')
      }
    }

    // Determine overall health
    const healthy = jsonValid && criticalFieldsPresent
    const severity = !healthy ? 'critical' : !apiKeyConfigured ? 'warning' : 'info'

    let message = 'Config file is healthy'
    if (!criticalFieldsPresent) {
      message = 'Config file missing critical fields'
    } else if (!apiKeyConfigured) {
      message = 'No API key configured'
    }

    return {
      name: 'config',
      healthy,
      severity,
      message,
      timestamp: Date.now(),
      data: {
        fileExists,
        jsonValid,
        criticalFieldsPresent,
        apiKeyConfigured,
        errors
      }
    }
  } catch (error) {
    errors.push(`Unexpected error: ${(error as Error).message}`)
    return {
      name: 'config',
      healthy: false,
      severity: 'critical',
      message: `Config check failed: ${(error as Error).message}`,
      timestamp: Date.now(),
      data: {
        fileExists,
        jsonValid,
        criticalFieldsPresent,
        apiKeyConfigured,
        errors
      }
    }
  }
}

/**
 * Claude Code CLI Delegated Provider
 *
 * A source that holds no credential. The bundled Claude Code CLI authenticates
 * itself from its own store, so Halo never sees, stores or refreshes a token —
 * and no longer has to track the official client's OAuth parameters or request
 * fingerprint, which is the maintenance cost this source exists to remove.
 *
 * Requests still traverse the local compat router: the subprocess sends its own
 * `Authorization` header, which the router forwards untouched, while the router
 * keeps doing the work the direct path would lose (image budget, warmup and
 * preflight short-circuits, system-prompt normalization, `[1m]` stripping).
 * Routing identity travels in a separate header rather than the auth channel —
 * see buildSdkEnv's delegated branch.
 *
 * Login and its credential slot live in `agent/cli-auth.ts`, next to the CC
 * runtime knowledge they depend on; this module stays free of filesystem and
 * process concerns.
 */

import type { AISourceProvider, ProviderResult } from '../../../../shared/interfaces'
import type {
  AISourceType,
  AISourcesConfig,
  BackendRequestConfig,
  OAuthSourceConfig
} from '../../../../shared/types'
import { resolveModelId } from '../../../../shared/types'
import {
  CLAUDE_SUBSCRIPTION_MODELS,
  CLI_DELEGATED_PROVIDER_ID
} from '../../../../shared/constants/claude-models'

/** First-party endpoint. The router POSTs this URL verbatim. */
const CLAUDE_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'

/**
 * The one beta the CLI does not send for itself. Everything else the
 * subscription API needs (oauth, interleaved thinking, context management,
 * prompt-cache scope, the agentic marker) is already on the subprocess's own
 * `anthropic-beta` header, and the router merges the two lists.
 */
const CONTEXT_1M_BETA = 'context-1m-2025-08-07'

class CliDelegatedProvider implements AISourceProvider {
  readonly type: AISourceType = CLI_DELEGATED_PROVIDER_ID
  readonly displayName = 'Claude Code CLI'

  /**
   * A delegated source carries no secret, so configuration is purely the
   * source's existence. Whether the CLI slot is actually signed in is checked
   * at credential-resolution time (see assertCliAuthReady), which can fail the
   * turn with an actionable message instead of silently reporting "configured".
   */
  isConfigured(config: AISourcesConfig): boolean {
    return !!config[this.type]
  }

  getBackendConfig(config: AISourcesConfig): BackendRequestConfig | null {
    const source = config[this.type] as OAuthSourceConfig | undefined
    if (!source) return null

    // The [1m] suffix is preserved here and stripped at the wire boundary by
    // the router: the embedded SDK needs it locally to size its context window,
    // and the API only accepts canonical ids.
    const model = resolveModelId(source.model)
    const is1mContext = /\[1m\]$/i.test(model)

    return {
      url: CLAUDE_MESSAGES_URL,
      key: '',
      model,
      apiType: 'anthropic_passthrough',
      delegatedAuth: true,
      // Header set must stay deterministic: it is hashed into the session
      // credential fingerprint, so a per-request value here would rebuild the
      // session on every warm-up.
      ...(is1mContext ? { headers: { 'anthropic-beta': CONTEXT_1M_BETA } } : {})
    }
  }

  getCurrentModel(config: AISourcesConfig): string | null {
    const source = config[this.type] as OAuthSourceConfig | undefined
    return source?.model || null
  }

  async getAvailableModels(): Promise<string[]> {
    return Object.keys(CLAUDE_SUBSCRIPTION_MODELS)
  }

  async refreshConfig(config: AISourcesConfig): Promise<ProviderResult<Partial<AISourcesConfig>>> {
    const source = config[this.type] as OAuthSourceConfig | undefined
    if (!source) {
      return { success: false, error: 'Not configured' }
    }

    return {
      success: true,
      data: {
        [this.type]: {
          ...source,
          availableModels: Object.keys(CLAUDE_SUBSCRIPTION_MODELS),
          modelNames: CLAUDE_SUBSCRIPTION_MODELS
        }
      }
    }
  }
}

let providerInstance: CliDelegatedProvider | null = null

export function getCliDelegatedProvider(): CliDelegatedProvider {
  if (!providerInstance) {
    providerInstance = new CliDelegatedProvider()
  }
  return providerInstance
}

export { CliDelegatedProvider }

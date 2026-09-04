/**
 * Provider id of the CLI-delegated source, and the `AISource.provider` value
 * persisted on it. Shared because the renderer routes this entry to its own
 * sign-in dialog instead of the OAuth flow.
 */
export const CLI_DELEGATED_PROVIDER_ID = 'claude-cli'

/**
 * Claude subscription model catalog.
 *
 * Shared by every source that reaches Claude through a Pro/Max subscription —
 * Halo's own OAuth provider and the CLI-delegated provider — so the two cannot
 * drift into offering different model lists for the same account.
 *
 * The `[1m]` suffix marks the 1M-context variant. It is a client-side marker
 * consumed by the embedded SDK's context-window detection and stripped at the
 * wire boundary by the router's anthropic_passthrough handler.
 */
export const CLAUDE_SUBSCRIPTION_MODELS: Record<string, string> = {
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-sonnet-5[1m]': 'Claude Sonnet 5 (1M context)',
  'claude-fable-5': 'Claude Fable 5',
  'claude-fable-5[1m]': 'Claude Fable 5 (1M context)',
  'claude-opus-5': 'Claude Opus 5',
  'claude-opus-5[1m]': 'Claude Opus 5 (1M context)',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-opus-4-8[1m]': 'Claude Opus 4.8 (1M context)',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-opus-4-6[1m]': 'Claude Opus 4.6 (1M context)',
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5'
}

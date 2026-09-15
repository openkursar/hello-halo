/**
 * Id of the request-shaping adapter the Codex backend requires. Shared so the
 * provider (which selects it) and the adapter registry (which implements it)
 * agree without either importing the other.
 */
export const CODEX_ADAPTER_ID = 'openai-codex'

/**
 * Version of the Codex CLI this provider presents itself as on the wire.
 *
 * The `version` header and the `client_version` catalog parameter are part of
 * the fingerprint the Codex backend keys on, and Halo means to look like a
 * current client, so this follows the latest released CLI.
 *
 * Deliberately not tied to the `@openai/codex` package in package.json: that
 * one drives the separate Codex engine path (`services/agent/codex/`), which
 * this source never spawns — its traffic goes through the Claude Code SDK and
 * the local router — so the two versions have no reason to move together.
 * Bump this when a CLI release changes the catalog or the wire shape.
 */
export const CODEX_CLI_VERSION = '0.154.0'

/** A catalog entry shipped with Halo, as the source and the picker read it. */
export interface CodexSubscriptionModel {
  slug: string
  name: string
  /** Ascending sort key, the same value the backend assigns. */
  priority: number
}

/**
 * Offline default for the Codex (ChatGPT subscription) model catalog.
 *
 * The account's real list comes from the backend and is fetched by the provider
 * (`chatgpt.provider.ts` `refreshConfig`), which is what the CLI does too —
 * the plan, not the client, decides which models exist. The backend response is
 * an overlay rather than a full catalog, so the provider merges it over this
 * list by slug and keeps the shipped entry wherever the backend stays silent.
 * This is therefore the base of the picker, not merely a pre-fetch seed.
 *
 * Entries are the `visibility: "list"` models of the catalog shipped with the
 * CLI this source emulates ({@link CODEX_CLI_VERSION}, tag `rust-v0.154.0`), in
 * ascending `priority`. That catalog also marks `gpt-5.2` visible; it is
 * intentionally not offered here.
 */
export const CODEX_SUBSCRIPTION_MODELS: readonly CodexSubscriptionModel[] = [
  { slug: 'gpt-6-astra', name: 'GPT-6-Astra', priority: 1 },
  { slug: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', priority: 6 },
  { slug: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', priority: 7 },
  { slug: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', priority: 8 },
  { slug: 'gpt-5.5', name: 'GPT-5.5', priority: 12 }
]

/** Offline default model — an entry of {@link CODEX_SUBSCRIPTION_MODELS}. */
export const CODEX_DEFAULT_MODEL = 'gpt-5.5'

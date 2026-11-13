/** Joins pre-rendered context and rule subsections without channel-specific decisions. */

export interface AppChatPromptFragments {
  /** Identity layer fragments, in render order. */
  identity: string[]
  /** Entry layer fragment. Caller selects IM, native, or future channels. */
  entry: string
  /** Constraint layer fragments, in render order. */
  constraints: string[]
}

const SECTION_SEPARATOR = '\n\n---\n\n'

/**
 * Join the three layers into a single system prompt string.
 * Empty fragments are skipped so callers can pass conditionals freely.
 */
export function assembleAppChatPrompt(fragments: AppChatPromptFragments): string {
  return [
    ...fragments.identity,
    fragments.entry,
    ...(fragments.constraints.some(section => section.length > 0)
      ? [`## Rules\n\n${fragments.constraints.filter(Boolean).join('\n\n')}`]
      : []),
  ]
    .filter((section) => section && section.length > 0)
    .join(SECTION_SEPARATOR)
}

/**
 * Which model id the provider editor is acting on.
 *
 * Two ids, deliberately not one. A custom id is typed a character at a time,
 * and `configured` drives ModelConfigPanel's `modelId` — so binding it to the
 * raw draft would fire two capability round-trips per keystroke and let an
 * edit land under a half-typed id like `gpt-4o-mi`. The draft therefore has to
 * be committed (Apply / Enter) before anything is configured against it.
 *
 * `submitted` stays on the raw draft: a user who types an id and saves means
 * that id, even though they never configured it. The gap is intentional —
 * capability edits made against the previously committed id must not follow a
 * different id into the saved source.
 */
export interface ModelSelectionInput {
  useCustomModel: boolean
  customModelDraft: string
  committedCustomModelId: string
  selectedModel: string
}

export interface ModelSelection {
  /** Id to configure: empty while a custom draft is uncommitted. */
  configured: string
  /** Id to persist / test the connection with. */
  submitted: string
}

export function resolveModelSelection(input: ModelSelectionInput): ModelSelection {
  const { useCustomModel, customModelDraft, committedCustomModelId, selectedModel } = input
  if (!useCustomModel) {
    return { configured: selectedModel, submitted: selectedModel }
  }

  const draft = customModelDraft.trim()
  return {
    configured: draft !== '' && draft === committedCustomModelId ? committedCustomModelId : '',
    submitted: draft
  }
}

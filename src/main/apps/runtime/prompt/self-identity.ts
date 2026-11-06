/**
 * apps/runtime/prompt -- Self Identity
 *
 * Who the digital human is, in the one form the rest of the prompt and its
 * Operate Halo calls need: its name and its id.
 */

export function buildSelfIdentityPrompt(appId: string, name: string): string {
  const flat = name.replace(/\s+/g, ' ').trim().slice(0, 80)
  return `## Current identity\nYou are the digital human "${flat}" (id ${appId}).`
}

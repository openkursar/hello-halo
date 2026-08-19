/**
 * apps/runtime/prompt -- Native UI Entry Layer
 *
 * Entry-layer fragment used when the App chat runs inside the native
 * Halo chat UI (no IM session). Answers "where am I / how do I reply".
 *
 * It deliberately does NOT enumerate notification tools: whichever notify
 * tools exist are already described by their own MCP schemas, and advertising
 * them here caused the model to claim tools it did not actually have when the
 * underlying channel was unconfigured. Capability awareness (which tools are
 * loaded, disabled, or awaiting setup) lives in prompt/capabilities.ts.
 */

export const NATIVE_CHAT_ENTRY = `
## Chat Session

You are chatting directly with a user in Halo's native chat UI. Whatever you
write as your reply is shown to them immediately — you never need a
notification or messaging tool to reach the person you are talking to.
`.trim()

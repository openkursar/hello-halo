/** Capability metadata stays independent of browser resources and tool handlers. */
export const AI_BROWSER_DESCRIPTION = 'Control Halo\'s real browser: navigate interactive or login-required sites, fill forms, inspect pages and network, and download files.'

export const AI_BROWSER_SYSTEM_PROMPT = `
## AI Browser

Use Halo's real browser for interactive websites, login-required pages and visual checks. First open the target with browser_navigate or select its existing tab, then take browser_snapshot. After page changes, take a fresh snapshot before using its UIDs; use screenshots when visual information is needed.
`.trim()

export const AI_BROWSER_INSTRUCTIONS = `
Browser tools control a real page. Open the target with browser_navigate before reading it, or select its existing tab with browser_tab; take browser_snapshot before interacting and again after navigation, actions or page changes. Use only the latest snapshot's UIDs. If loading is incomplete, wait for the expected content and snapshot again.
Prefer structured snapshots for page content; use screenshots for visual layout, images or charts. browser_navigate opens URLs, not history actions. browser_tab manages tabs; create another only when the current page must stay open. Use browser_inspect for network or console evidence, browser_evaluate for page-context JavaScript, and browser_run for reusable scripts. Follow each tool's full definition for arguments and constraints.
`.trim()

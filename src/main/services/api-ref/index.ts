/**
 * `halo_api_ref` — the tool that lets an agent operate Halo itself. It hands
 * back the manual page for a capability group; execution is plain curl through
 * the Bash tool, so nothing new is added to the execution surface.
 *
 * Loaded as an on-demand toolset (`toolsets/registry.ts`), which is what keeps
 * the manual, the `HALO_API_*` credentials and the usage guide from ever
 * disagreeing about whether a session has this capability: all three derive
 * from the same toolset being enabled.
 *
 * This module reads generated files and nothing else. It imports no
 * controller, route or service: every coupling to the HTTP surface happens at
 * build time in `scripts/gen-api-ref.mjs`, which keeps the service layer from
 * depending on the transport layer at runtime.
 */

import { dirname } from 'path'
import { z } from 'zod'
import { createSdkMcpServer, tool } from '../agent/resolved-sdk'
import { API_REF_GROUP_IDS, API_REF_GROUPS } from './groups'

/**
 * Toolset id, MCP server name, and — for digital humans — the permission id.
 * Exported so the switch that loads the tool, the switch that injects the
 * `HALO_API_*` credentials and the switch that appends the usage guide are
 * literally the same identifier rather than three copies of a string.
 */
export const HALO_API_TOOLSET_ID = 'halo-api-ref'

const GROUPS = API_REF_GROUP_IDS

/**
 * Substituted with the absolute path of the api-ref directory, so a page can
 * compose `{{API_REF_INDEX_PATH}}/index.txt`. The generator cannot know it:
 * the tree sits in a checkout during development and inside the packaged app
 * afterwards.
 */
const INDEX_PLACEHOLDER = '{{API_REF_INDEX_PATH}}'

// Every sentence here closes one specific failure: the opening line is a "when
// to use this" rather than a "what this returns", because a weak model routes
// off the first sentence it reads and never reaches the env-var line; the last
// line is what stands between a wrong guess and the model telling the user
// "Halo can't do this". What each group covers belongs to the `group`
// parameter rather than here — it is read while filling that field in.
const TOOL_DESCRIPTION = `Call this before doing anything to Halo itself. Returns the executable HTTP
contract for one capability group of this build: exact paths, ready-to-run
curl, response shapes, and what is closed to you.

Auth and base URL are already in your environment ($HALO_API_URL,
$HALO_API_TOKEN, $HALO_SPACE_ID) — copy the curl as-is and substitute ids.

Not finding something here does NOT mean Halo can't do it. Grep the full
index (path is printed on every page) before telling the user it is impossible.`

/**
 * The group enum's own documentation, built from the same descriptions the
 * manual pages are headed with. Written out rather than summarised: choosing
 * the wrong group ends in a page that does not hold the capability, and the
 * agent reporting it missing — which costs far more than the words do.
 */
const GROUP_PARAM_DESCRIPTION = API_REF_GROUP_IDS.map(
  (id) => `${API_REF_GROUPS[id].title}. Covers: ${API_REF_GROUPS[id].covers}`,
).join('\n')

/**
 * Appended to the system prompt only while this toolset is enabled
 * (`toolsets/capability-index.ts`). It is the counterpart of the tool
 * description: that one is read when the model is choosing a tool, this one
 * when it is deciding whether the task is reachable at all.
 */
export const HALO_API_USAGE_GUIDE = `
## Operate Halo

Halo itself is operable over its local HTTP API — spaces, conversations,
digital humans, knowledge bases, IM channels, settings and the app store.
This is a raw interface, with close to the reach the user has in the app.

Prefer a purpose-built tool when you hold one. Purpose-built tools validate
input, sequence multi-step operations and roll back on failure; the raw API
does none of that. Use the API when no tool covers the task.

### How to use it
1. Call \`mcp__halo-api-ref__halo_api_ref\` with the capability group you need.
   It returns this build's real contract: exact paths, ready-to-run curl,
   response shapes, and what is closed to you.
2. Run the curl it returns with the Bash tool. \`$HALO_API_URL\`,
   \`$HALO_API_TOKEN\` and \`$HALO_SPACE_ID\` are already set. NEVER print or
   expand them.

### Rules
- IMPORTANT: NEVER write a path from memory. Paths differ between builds.
- HTTP 200 does not mean success. Check \`"success"\` in the body.
- 403 means the endpoint exists and is closed to you — never that Halo cannot
  do it. Check your own tools for the same operation first.
- Before concluding it cannot be done: follow the group page's redirects, then
  grep the full index (its path is printed on every page).
- Once you have confirmed this API cannot do it: tell the user so plainly,
  call \`read_halo_doc\` for the exact screen and steps, and walk them through
  doing it by hand.
- Most credentials cannot be written through this API. Find the write route
  before asking the user for a secret.
`

/**
 * Fills the index path the generator could not know: it differs between a dev
 * checkout and a packaged app. A page still holding the placeholder would send
 * the agent grepping a literal `{{...}}`, so that is treated as a failure
 * rather than passed along.
 */
async function renderPage(group: string): Promise<string> {
  // Loaded on call, not at module scope: this server is built for every agent
  // session, and resource-path reaches Electron and the logging controller.
  // Dragging those into the toolset broker's module graph is what makes an
  // unrelated module fail to load.
  const { getApiRefPath, readApiRefFile } = await import('./resource-path')

  const page = readApiRefFile(`${group}.txt`)
  if (page === null) {
    throw new Error(
      `No manual page for "${group}" in this build. Ask for one of: ${GROUPS.join(', ')}.`,
    )
  }

  const indexFile = getApiRefPath('index.txt')
  // `dirname`, not a manual lastIndexOf('/'): getApiRefPath returns a
  // platform-native path, so on Windows the separator is a backslash and a
  // slash search would silently truncate the last character instead.
  const indexDir = indexFile ? dirname(indexFile) : null
  const rendered = indexDir ? page.split(INDEX_PLACEHOLDER).join(indexDir) : page

  if (rendered.includes('{{')) {
    throw new Error(
      `The manual page for "${group}" still contains an unresolved template placeholder. ` +
        'Report this to the user rather than acting on the page.',
    )
  }
  return rendered
}

function buildTools(): unknown[] {
  const halo_api_ref = tool(
    'halo_api_ref',
    TOOL_DESCRIPTION,
    {
      group: z.enum(GROUPS).describe(GROUP_PARAM_DESCRIPTION),
    },
    async (args: { group: string }) => {
      try {
        return { content: [{ type: 'text', text: await renderPage(args.group) }] }
      } catch (error) {
        return {
          content: [{ type: 'text', text: (error as Error).message }],
          isError: true,
        }
      }
    },
  )

  return [halo_api_ref]
}

export function createApiRefMcpServer() {
  return createSdkMcpServer({
    name: HALO_API_TOOLSET_ID,
    version: '1.0.0',
    tools: buildTools(),
  })
}

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
import { API_REF_GROUP_IDS } from './groups'

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
// off the first sentence it reads and never reaches the group enum or the
// env-var line; the last line is what stands between a wrong guess and the
// model telling the user "Halo can't do this".
const TOOL_DESCRIPTION = `Call this before doing anything to Halo itself (spaces, conversations,
digital humans, knowledge collections, channels, settings).
Returns the executable HTTP contract for one capability group of this Halo
build: exact paths, ready-to-run curl, and response shapes.
Auth and base URL are already in your environment ($HALO_API_URL,
$HALO_API_TOKEN, $HALO_SPACE_ID) — copy the curl as-is and substitute ids.

group: conversation | workspace | digital-human | knowledge-base
     | channels | settings | store | terminal

Not finding something here does NOT mean Halo can't do it. Grep the full
index (path is printed on every page) before telling the user it is impossible.`

/**
 * Appended to the system prompt only while this toolset is enabled
 * (`toolsets/capability-index.ts`). It is the counterpart of the tool
 * description: that one is read when the model is choosing a tool, this one
 * when it is deciding whether the task is reachable at all.
 */
export const HALO_API_USAGE_GUIDE = `
## Operate Halo

Halo itself is operable over its local HTTP API — spaces, conversations,
digital humans, knowledge bases, channels, settings and the app store.

1. \`mcp__halo-api-ref__halo_api_ref\` — ask for the capability group you need.
   It returns this build's real contract: exact paths, ready-to-run curl, and
   response shapes.
2. Run the curl it gives you with the Bash tool. \`$HALO_API_URL\`,
   \`$HALO_API_TOKEN\` and \`$HALO_SPACE_ID\` are already set — copy commands as
   written, substitute only ids, and never print or expand those variables.

### Key Rules
- Never write a path from memory. Paths differ between builds; a remembered one
  is how you end up reporting a capability as missing when it exists.
- HTTP 200 does not mean success. Read the body and check \`"success"\`.
- 403 means the endpoint exists but is closed to you in this build — tell the
  user to do it in the Halo app, not that Halo cannot do it.
- Not finding something is a real answer only after you have grepped the full
  index (its path is printed on every page).
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
      group: z
        .enum(GROUPS)
        .describe(
          'conversation: stop or inspect what Halo is doing, read conversations. ' +
            'workspace: spaces and the files they hold. ' +
            'digital-human: install, run and configure digital humans. ' +
            'knowledge-base: document collections agents can search. ' +
            'channels: IM channels and outbound notifications. ' +
            'settings: application and model configuration. ' +
            'store: browse and install from the app store. ' +
            'terminal: interactive shell sessions.',
        ),
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

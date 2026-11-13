/**
 * `halo_api_ref` — the tool that lets an agent operate Halo itself. It hands
 * back the manual page for a capability group; execution is plain curl through
 * the Bash tool, so nothing new is added to the execution surface.
 *
 * Core space conversations receive the reference, usage guide and scoped
 * runtime credentials together, without a manual enablement step.
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
 * Shared identity for the reference server and caller-scoped execution policy.
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

const TOOL_DESCRIPTION = `Read this build's executable HTTP contract before using Halo's local API. Choose the capability group for the task; the result provides exact paths, curl commands, response shapes, access limits and execution rules. Follow its redirects and full index before concluding an operation is unavailable.`

/**
 * The group enum's own documentation, built from the same descriptions the
 * manual pages are headed with. Written out rather than summarised: choosing
 * the wrong group ends in a page that does not hold the capability, and the
 * agent reporting it missing — which costs far more than the words do.
 */
const GROUP_PARAM_DESCRIPTION = API_REF_GROUP_IDS.map(
  (id) => `${API_REF_GROUPS[id].title}. Covers: ${API_REF_GROUPS[id].covers}`,
).join('\n')

export const HALO_API_DESCRIPTION = 'Operate Halo itself: spaces, conversations, digital humans, teams, knowledge bases, channels, settings and the app store.'

export const HALO_API_USAGE_GUIDE = `
## Operate Halo

You can operate Halo itself — spaces, conversations, digital humans, teams, knowledge bases, IM channels, settings and the app store. Prefer a matching purpose-built tool; otherwise consult halo_api_ref before calling the local API. Runtime credentials are already supplied; no enablement step is needed. Product docs explain usage, not your current access. Follow the current contract, never guess paths or bypass a permission denial. If access is unavailable, explain the limit and use read_halo_doc for the user's UI steps.
`.trim()

const API_EXECUTION_RULES = `
## Execution rules

- Follow this build's documented methods, paths, inputs and response shapes; do not invent endpoints. Prefer a matching purpose-built tool: raw API calls do not orchestrate multiple steps or roll them back.
- Run the supplied curl with your command-execution tool. $HALO_API_URL, $HALO_API_TOKEN and $HALO_SPACE_ID are already in its environment. Keep variable references in commands; never print their values, store credentials in files or expose them in replies.
- HTTP 200 alone is not success: check the body's success value and operation result. A started job is not completion; use its documented status operation when needed.
- HTTP 403 means this route is closed to you, not that Halo lacks the feature. Use another tool only when the reference or current permissions authorize the operation; never bypass a denial.
- If the operation is missing, follow group redirects and search the full index named below before declaring it unavailable. When no authorized route or tool covers it, explain the limit and use read_halo_doc for the user's exact UI steps.
- Verify a supported credential-write route before asking for a secret. Otherwise guide the user to enter it in Halo, not in chat.
`.trim()

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
  return `${API_EXECUTION_RULES}\n\n${rendered}`
}

function buildTools() {
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
    description: HALO_API_DESCRIPTION,
    tools: buildTools(),
  })
}

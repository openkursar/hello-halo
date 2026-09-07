/**
 * `read_halo_doc` — the tool that lets an agent read Halo's own documentation.
 *
 * Its own MCP server rather than a tool inside `apps/conversation-mcp`, which
 * is where it used to live. That server is mounted only where digital-human
 * management is (conversations and digital-human chat, and only while the
 * feature is enabled), so a scheduled automation run — the one context that
 * cannot ask a person what a screen looks like — was the one context without
 * the documentation. Self-knowledge is not a digital-human feature; it is
 * unconditional, and it is mounted at all three chat entry points.
 *
 * The authoring gate on `create_automation_app` still has to see reads that
 * now happen here, so a session takes both halves from `createOfficialDocsSession`
 * and hands the gate to the server that needs it. Session-scoped by closure,
 * never process-wide: one conversation consulting the guide must not unlock
 * spec authoring in another.
 */

import { z } from 'zod'
import { createSdkMcpServer, tool } from '../agent/resolved-sdk'
import { readOfficialDoc } from '../official-docs.service'

/**
 * Guide the AI must consult before authoring a spec. The path is hard-coded
 * here and nowhere else; renaming the published document would strand every
 * shipped client, so it is fixed for the lifetime of the tool.
 */
export const CREATE_GUIDE_PATH = 'create-digital-human/SKILL.md'

/** Everything under this prefix counts as "the authoring guide was consulted". */
const CREATE_GUIDE_PREFIX = 'create-digital-human/'

const TOOL_DESCRIPTION =
  'Read official Halo documentation and return its raw markdown. This is the ' +
  'authoritative source for how Halo (yourself) works, updated independently of this build.\n\n' +
  'Read it when the user asks how to do something in Halo, and before you configure or ' +
  'build anything in Halo on their behalf.\n\n' +
  'It describes the product and how a user operates it — it is not your capability list. ' +
  'What you can do for the user directly depends on the MCP tools you hold and the ' +
  'low-level HTTP API behind `halo_api_ref`.\n\n' +
  'Paths are relative to the documentation root. Read "index.md" for the list of documents, ' +
  `or "${CREATE_GUIDE_PATH}" before creating or updating a digital human. Each entry ` +
  'document lists its companion documents.'

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  }
}

export interface OfficialDocsSession {
  /** In-process MCP server carrying `read_halo_doc`. Mount under its own name. */
  server: unknown
  /**
   * Whether the digital-human authoring guide was requested in this session.
   * True on any read attempt, successful or not: the point is that the AI
   * tried, and `readOfficialDoc`'s offline fallback must never be able to lock
   * spec authoring out on an air-gapped machine.
   */
  guideConsulted: () => boolean
}

/**
 * Build the documentation server for one agent session.
 *
 * An in-process MCP server binds to exactly one session transport, so the
 * instance must not outlive the session it was seeded into — call this at
 * session creation, never from a cache.
 */
export function createOfficialDocsSession(): OfficialDocsSession {
  let consulted = false

  const read_halo_doc = tool(
    'read_halo_doc',
    TOOL_DESCRIPTION,
    {
      path: z
        .string()
        .describe(`Document path relative to the guide root, e.g. "${CREATE_GUIDE_PATH}".`),
    },
    async (args: { path: string }) => {
      const path = args.path.trim()
      if (path.startsWith(CREATE_GUIDE_PREFIX)) consulted = true

      try {
        const result = await readOfficialDoc(path)
        if (!result.ok) {
          const hint =
            result.available.length > 0
              ? `\n\nDocuments available offline:\n${result.available.map((d) => `- ${d}`).join('\n')}`
              : ''
          return textResult(`${result.reason}${hint}`, true)
        }

        const provenance =
          result.source === 'bundled'
            ? `<!-- source: offline snapshot bundled with this Halo version${result.snapshotDate ? ` (${result.snapshotDate})` : ''} — the documentation host was unreachable, content may be outdated -->`
            : `<!-- source: ${result.source === 'remote' ? 'documentation host (current)' : 'documentation host (cached this session)'} -->`

        return textResult(`${provenance}\n\n${result.text}`)
      } catch (e) {
        return textResult(`Error reading guide document: ${(e as Error).message}`, true)
      }
    },
  )

  return {
    server: createSdkMcpServer({
      // Mirrored in shared/apps/builtin-mcp.ts and at each injection site.
      name: 'halo-docs',
      version: '1.0.0',
      tools: [read_halo_doc],
    }),
    guideConsulted: () => consulted,
  }
}

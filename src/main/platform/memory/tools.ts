/**
 * platform/memory -- MCP Tool Definitions
 *
 * Creates MCP tools (memory_read, memory_write, memory_list) using
 * the Claude Agent SDK's tool() + createSdkMcpServer() pattern,
 * exactly matching the pattern used by sdk-mcp-server.ts for browser tools.
 *
 * Each tool's schema is dynamically generated based on the caller's scope
 * to enforce the permission matrix at the schema level.
 */

import { z } from 'zod'
import { tool, createSdkMcpServer } from './sdk'
import type { MemoryCallerScope, MemoryService } from './types'
import { getReadableScopes, getWritableScopes } from './permissions'

// ============================================================================
// Types
// ============================================================================

/** The return type of createSdkMcpServer -- opaque to consumers */
type SdkMcpServer = ReturnType<typeof createSdkMcpServer>

// ============================================================================
// Tool Text Helper
// ============================================================================

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {})
  }
}

// ============================================================================
// Tool Factory
// ============================================================================

/**
 * Create an MCP server with memory tools scoped to the given caller.
 *
 * The tools available and their parameter schemas vary based on the caller's
 * identity (user session vs. app session), enforcing the permission matrix
 * at the schema level.
 *
 * @param caller  - Identity of the caller
 * @param service - Reference to the MemoryService (for executing operations)
 * @returns An SDK MCP server instance
 */
export function createMemoryMcpServer(
  caller: MemoryCallerScope,
  service: MemoryService
): SdkMcpServer {
  const readableScopes = getReadableScopes(caller)
  const writableScopes = getWritableScopes(caller)

  // Build Zod enum for readable scopes
  const readScopeEnum = z.enum(readableScopes as [string, ...string[]])
  // Build Zod enum for writable scopes
  const writeScopeValues = writableScopes.map(s => s.scope)
  const writeScopeEnum = z.enum(writeScopeValues as [string, ...string[]])

  // ── memory_read ──────────────────────────────────────────────────────────
  const memory_read = tool(
    'memory_read',
    `Read from persistent memory. Supports multiple read modes for efficiency:\n` +
    `- mode="headers": Returns only markdown heading lines with line numbers. Use this FIRST to understand memory structure at low token cost.\n` +
    `- mode="section": Returns a specific section matched by heading text. Use after "headers" to load only what you need.\n` +
    `- mode="tail": Returns the last N lines. Useful for checking recent additions.\n` +
    `- mode="full": Returns the entire file (default). Use for small files or when you need everything.\n` +
    `Recommended flow: headers → section (for large files), or full (for small/new files).\n` +
    `If a 'path' is specified, reads a specific file from the memory archive directory (mode is ignored for archive reads).`,
    {
      scope: readScopeEnum.describe(
        `Memory scope to read from. ` +
        (caller.type === 'user'
          ? `"user" = your personal cross-space memory. "space" = project-specific knowledge for this workspace.`
          : `"user" = user preferences (read-only). "space" = shared workspace knowledge. "app" = your private app memory.`)
      ),
      mode: z.enum(['full', 'headers', 'section', 'tail']).default('full').describe(
        'Read mode. "headers" = heading lines only (low cost). "section" = specific section by heading. ' +
        '"tail" = last N lines. "full" = entire file (default).'
      ),
      section: z.string().optional().describe(
        'Heading text to match when mode="section". Case-insensitive substring match. ' +
        'E.g., "tracked" matches "## Tracked Items".'
      ),
      limit: z.number().optional().describe(
        'Number of lines to return when mode="tail". Defaults to 50.'
      ),
      path: z.string().optional().describe(
        'Optional: relative path to a specific file in the memory archive directory (e.g., "2024-01-15-1430.md"). ' +
        'If specified, reads that archive file directly (mode is ignored). Use memory_list to discover available files.'
      )
    },
    async (args) => {
      try {
        const content = await service.read(caller, {
          scope: args.scope as any,
          path: args.path,
          mode: args.mode as any,
          section: args.section,
          limit: args.limit
        })

        if (content === null) {
          // Differentiate between "file not found" and "section not found"
          if (args.mode === 'section' && args.section) {
            return textResult(
              `Section "${args.section}" not found in ${args.scope} memory. ` +
              `Use mode="headers" to see available sections.`
            )
          }
          return textResult(
            `No memory file found for scope "${args.scope}"${args.path ? ` at path "${args.path}"` : ''}. ` +
            `This is normal for a first-time interaction. Use memory_write to start building memory.`
          )
        }

        if (content.trim().length === 0) {
          return textResult(
            `Memory file for scope "${args.scope}" exists but is empty. Use memory_write to start building memory.`
          )
        }

        return textResult(content)
      } catch (err) {
        return textResult(`Failed to read memory: ${(err as Error).message}`, true)
      }
    }
  )

  // ── memory_write ─────────────────────────────────────────────────────────

  // Build mode enum based on what the caller can do per scope
  // For apps writing to space: only append is allowed
  const memory_write = tool(
    'memory_write',
    `Write to persistent memory. Save durable state that future runs need.\n` +
    `Good: learned patterns, current tracking lists, configuration, error patterns, decisions.\n` +
    `Bad: per-run execution logs, timestamped diary entries, task completion confirmations.\n` +
    `Ask yourself: would the next run's behavior change if this were missing? If no, don't write it.\n` +
    `Mode "append" adds to the end. Mode "replace" overwrites the entire file.\n` +
    `Use "replace" when memory has grown stale or repetitive: read current memory, distill to essential state, write back clean version. ` +
    `Prefer "replace" over "append" when the file already has similar content.\n` +
    `Structure content with markdown headings (## State, ## Patterns, ## Config) for efficient section-based reads.` +
    (caller.type === 'app'
      ? ` Note: You can only append to space memory (not replace). Your app memory supports both modes.`
      : ''),
    {
      scope: writeScopeEnum.describe(
        `Memory scope to write to. ` +
        (caller.type === 'user'
          ? `"user" = personal memory. "space" = project knowledge.`
          : `"space" = shared workspace knowledge (append-only). "app" = your private memory.`)
      ),
      content: z.string().describe(
        'The content to write. Use markdown format with clear headings (## State, ## Patterns, ## Config). ' +
        'Write state, not logs. Be specific and structured for future retrieval.'
      ),
      mode: z.enum(['append', 'replace']).describe(
        'Write mode. "append" adds to end of file. ' +
        '"replace" overwrites entire file -- use when consolidating or cleaning up stale/duplicate content. ' +
        'For app memory, prefer "replace" to maintain a clean state document.'
      )
    },
    async (args) => {
      try {
        // For app callers writing to space scope, enforce append-only regardless
        // of what the AI requested. This is the server-side enforcement layer.
        let actualMode = args.mode as 'append' | 'replace'
        if (caller.type === 'app' && args.scope === 'space' && actualMode === 'replace') {
          return textResult(
            `Apps can only append to space memory, not replace it. Use mode "append" instead.`,
            true
          )
        }

        await service.write(caller, {
          scope: args.scope as any,
          content: args.content,
          mode: actualMode
        })

        const sizeInfo = args.content.length > 1000
          ? ` (${(args.content.length / 1024).toFixed(1)}KB written)`
          : ''

        return textResult(
          `Successfully ${args.mode === 'append' ? 'appended to' : 'replaced'} ` +
          `${args.scope} memory.${sizeInfo}`
        )
      } catch (err) {
        return textResult(`Failed to write memory: ${(err as Error).message}`, true)
      }
    }
  )

  // ── memory_list ──────────────────────────────────────────────────────────
  const memory_list = tool(
    'memory_list',
    `List files in the memory archive directory for a given scope. ` +
    `Use this to discover past session summaries and compaction archives ` +
    `before using memory_read with a specific path.`,
    {
      scope: readScopeEnum.describe(
        `Memory scope to list archive files from.`
      )
    },
    async (args) => {
      try {
        const files = await service.list(caller, { scope: args.scope as any })

        if (files.length === 0) {
          return textResult(
            `No archive files found for scope "${args.scope}". ` +
            `Archives are created during compaction and session summaries.`
          )
        }

        const listing = files.map(f => `  - ${f}`).join('\n')
        return textResult(
          `Memory archive files for scope "${args.scope}" (${files.length} files):\n${listing}\n\n` +
          `Use memory_read with path parameter to read a specific file.`
        )
      } catch (err) {
        return textResult(`Failed to list memory files: ${(err as Error).message}`, true)
      }
    }
  )

  // ── Build MCP Server ─────────────────────────────────────────────────────
  return createSdkMcpServer({
    name: 'halo-memory',
    version: '1.0.0',
    tools: [memory_read, memory_write, memory_list]
  })
}

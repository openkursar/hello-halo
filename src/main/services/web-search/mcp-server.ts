/**
 * Web Search MCP - MCP Server Definition
 *
 * Provides the `web_search` tool as an MCP server.
 * This is a drop-in replacement for Claude's built-in WebSearch tool,
 * but works in all regions and with all models.
 *
 * Performance: ~1-3 seconds per search, zero AI token consumption.
 */

import { tool, createSdkMcpServer } from '../agent/resolved-sdk'
import { z } from 'zod'
import { getSearchContext } from './search-context'
import type { SearchResponse } from './types'

// ============================================
// Tool Definition
// ============================================

/**
 * Build the web_search tool
 */
function buildWebSearchTool() {
  return tool(
    'web_search',
    `Search the web and return structured results. Use this when you need current information from the internet.

This tool performs a real web search and returns structured results with titles, URLs, and snippets.

Engines:
- "auto" (default): Bing for English, Baidu for Chinese. This is the reliable default — prefer it.
- "google": opt-in only. Use it when the task benefits from Google specifically (e.g. a comprehensive cross-source investigation) or when the user asks for Google. Google may be unreachable without a proxy; if it fails, this tool returns clear guidance — follow it (retry with another engine or ask the user), and tell the user what happened rather than silently substituting results.

When to use:
- Finding current information, news, or recent events
- Looking up documentation, tutorials, or technical references
- Researching topics beyond your training data
- Verifying facts or finding sources

Tips for better results:
- Use specific, descriptive queries
- Include relevant keywords
- For Chinese content, write the query in Chinese
- For English content, write the query in English

Returns: A list of search results, each with title, URL, and snippet.`,
    {
      query: z.string().describe('The search query. Be specific and descriptive for better results.'),
      max_results: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .describe('Maximum number of results to return (default: 8, max: 20)'),
      engine: z
        .enum(['auto', 'bing', 'baidu', 'google'])
        .optional()
        .describe(
          'Search engine to use. "auto" (default) selects based on query language: ' +
          'Bing for English, Baidu for Chinese. "google" is opt-in only (not used by ' +
          '"auto"); choose it deliberately for Google-specific needs, and be aware it ' +
          'may be unreachable without a proxy.'
        ),
    },
    async (args) => {
      const ctx = getSearchContext()

      try {
        const response: SearchResponse = await ctx.search(args.query, {
          maxResults: args.max_results || 8,
          engine: args.engine || 'auto',
        })

        // Format results for AI consumption
        const formattedOutput = formatSearchResponse(response)

        return {
          content: [
            {
              type: 'text' as const,
              text: formattedOutput,
            },
          ],
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        console.error('[WebSearch MCP] Search failed:', message)

        return {
          content: [
            {
              type: 'text' as const,
              text: `Search failed: ${message}\n\nPlease try again with a different query or check your network connection.`,
            },
          ],
          isError: true,
        }
      }
    }
  )
}

// ============================================
// Response Formatting
// ============================================

/**
 * Format search response for AI consumption
 *
 * The format is designed to be:
 * - Easy for the AI to parse and reference
 * - Concise but informative
 * - Include source URLs for citation
 */
function formatSearchResponse(response: SearchResponse): string {
  const { query, engine, results, searchTime, warning, blocked } = response

  // Build header
  const lines: string[] = []

  if (results.length === 0) {
    // Structured failure: hand the AI actionable guidance instead of a generic
    // "no results" message, so it can pick the right next step.
    if (blocked) {
      lines.push(`Search did not return results for "${query}" (engine: ${blocked.engine}, reason: ${blocked.reason}).`)
      lines.push('')
      lines.push(blocked.guidance)
      return lines.join('\n')
    }

    lines.push(`No results found for: "${query}"`)
    if (warning) {
      lines.push(`Note: ${warning}`)
    }
    lines.push('')
    lines.push('Suggestions:')
    lines.push('- Try different keywords')
    lines.push('- Use more general terms')
    lines.push('- Check spelling')
    return lines.join('\n')
  }

  // Summary line
  lines.push(`Found ${results.length} results from ${engine} (${searchTime}ms)`)
  if (warning) {
    lines.push(`Note: ${warning}`)
  }
  lines.push('')

  // Format each result
  for (const result of results) {
    lines.push(`${result.position}. **${result.title}**`)
    lines.push(`   ${result.url}`)
    if (result.snippet) {
      // Truncate long snippets
      const snippet = result.snippet.length > 300
        ? result.snippet.slice(0, 297) + '...'
        : result.snippet
      lines.push(`   ${snippet}`)
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}

// ============================================
// MCP Server Factory
// ============================================

/**
 * Create Web Search MCP Server
 *
 * This server provides a single tool: `web_search`
 * It's designed to be a drop-in replacement for Claude's WebSearch.
 *
 * Usage in session config:
 * ```
 * mcpServers['web-search'] = createWebSearchMcpServer()
 * ```
 */
export function createWebSearchMcpServer() {
  return createSdkMcpServer({
    name: 'web-search',
    version: '1.0.0',
    tools: [buildWebSearchTool()],
  })
}

/**
 * Get the tool name for the web search tool
 * Used for system prompt documentation
 */
export function getWebSearchToolName(): string {
  return 'mcp__web-search__web_search'
}

/**
 * Agent Module - Predefined Sub-Agent Definitions
 *
 * Defines specialized sub-agents available via the Task tool.
 * Agent definitions are purely declarative data — they add zero overhead
 * at session startup. A sub-agent process is only spawned when the AI
 * actually invokes `Task(subagent_type="...")`.
 *
 * Architecture:
 * - Definitions are passed to the SDK via `Options.agents`
 * - The SDK injects agent descriptions into the Task tool's system prompt section
 * - When called, a sub-agent runs in an isolated context (separate conversation)
 * - Only the sub-agent's final result text returns to the main conversation
 *
 * This module is the single source of truth for all predefined agents.
 */

import type { AgentDefinition } from '../../../shared/types/agent-definition'

// ============================================
// Web Searcher Agent
// ============================================

/**
 * AI Browser tool names used by the web-searcher agent.
 *
 * Listed explicitly (not dynamically resolved) for two reasons:
 * 1. Agent definitions are static data — no runtime dependency on ai-browser module
 * 2. The searcher only needs a minimal subset of browser tools (not all 27)
 */
const WEB_SEARCHER_BROWSER_TOOLS = [
  'mcp__ai-browser__browser_navigate',
  'mcp__ai-browser__browser_snapshot',
  'mcp__ai-browser__browser_click',
  'mcp__ai-browser__browser_fill',
  'mcp__ai-browser__browser_press_key',
  'mcp__ai-browser__browser_wait_for',
  'mcp__ai-browser__browser_tab',
]

/**
 * System prompt for the web-searcher sub-agent.
 *
 * Designed for reliability across Google, Bing, and Baidu.
 * The agent operates headlessly — it receives a search query,
 * uses AI Browser to execute the search, and returns structured results.
 */
const WEB_SEARCHER_PROMPT = `You are a web search specialist. Your job is to search the web and return useful, structured results.

## Process

1. Open search engine with browser_navigate:
   - For Chinese queries: { url: "https://www.bing.com/search?q={URL-encoded query}" }
   - For English/other queries: { url: "https://www.bing.com/search?q={URL-encoded query}" }
   - Fallback 1: https://www.baidu.com/s?wd={URL-encoded query}
   - Fallback 2: https://www.google.com/search?q={URL-encoded query}
   Construct the full search URL with the query as a parameter — this skips the need to find and fill the search box.

2. Use browser_snapshot to read the search results page.

3. Extract the top results: title, URL, and snippet for each.

4. If the query requires deeper information (e.g., documentation, how-to, specific facts):
   - Click into the 1-2 most relevant result pages
   - Use browser_snapshot to extract key content
   - Summarize the relevant information

5. Close pages when done with browser_tab (action: "close").

## Output Format

Return results as concise markdown:

**For factual/lookup queries:**
Direct answer first, then supporting sources:
\`\`\`
[Direct answer to the query]

Sources:
- [Title](URL) — key detail
- [Title](URL) — key detail
\`\`\`

**For research/exploratory queries:**
\`\`\`
## Results for: [query]

1. **[Title](URL)**
   Snippet or key finding

2. **[Title](URL)**
   Snippet or key finding

...
\`\`\`

## Rules

- Keep output concise. No commentary about your process.
- If the primary search engine fails or is blocked, immediately try the next fallback.
- If a search returns no useful results, state that clearly.
- Return 5-8 results for broad queries, 1-3 with deep content for specific queries.
- Always include source URLs so the user can verify.
- Write summaries in the same language as the search query.`

const WEB_SEARCHER_AGENT: AgentDefinition = {
  description: 'Search the web for current information using AI browser. Use this when you need up-to-date information, recent documentation, research, news, or answers to factual questions that may be beyond your training data.',
  tools: WEB_SEARCHER_BROWSER_TOOLS,
  prompt: WEB_SEARCHER_PROMPT,
  model: 'sonnet',
}

// ============================================
// Public API
// ============================================

/**
 * All predefined agent definitions for the SDK.
 *
 * This is the single export consumed by sdk-config.ts.
 * Add new agents here — they will automatically become
 * available via the Task tool in all sessions.
 */
export const PREDEFINED_AGENTS: Record<string, AgentDefinition> = {
  'web-searcher': WEB_SEARCHER_AGENT,
}

/**
 * @module tools/web-fetch
 * WebFetchTool — Fetch URL content and convert HTML to markdown.
 * @license MIT
 */

import type { Tool, ToolContext, ToolResult } from '../../types/tool.js';
import { toolSuccess, toolError } from '../../types/tool.js';
import { WEB_FETCH_TOOL_NAME, WEB_FETCH_TOOL_DESCRIPTION, WEB_FETCH_INPUT_SCHEMA } from './schema.js';
import { htmlToMarkdown } from './html-to-markdown.js';

/** Maximum content length before truncation. */
const MAX_CONTENT_LEN = 100_000;
/** Default fetch timeout in ms. */
const FETCH_TIMEOUT_MS = 30_000;
/** Cache TTL: 15 minutes. */
const CACHE_TTL_MS = 15 * 60 * 1000;

/** Simple in-memory cache with TTL. */
const cache = new Map<string, { content: string; timestamp: number }>();

/** Evict expired cache entries. */
function evictCache(): void {
  const now = Date.now();
  for (const [url, entry] of cache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      cache.delete(url);
    }
  }
}

/** Upgrade HTTP to HTTPS. */
function upgradeUrl(url: string): string {
  if (url.startsWith('http://')) {
    return 'https://' + url.slice(7);
  }
  return url;
}

/** Get the hostname from a URL string. */
function getHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export const WebFetchTool: Tool = {
  name: WEB_FETCH_TOOL_NAME,
  description: WEB_FETCH_TOOL_DESCRIPTION,
  inputSchema: WEB_FETCH_INPUT_SCHEMA,
  permissionLevel: 'readonly',
  isConcurrencySafe: () => true,

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const rawUrl = input.url as string | undefined;
    if (!rawUrl || typeof rawUrl !== 'string') {
      return toolError('Missing required parameter: url');
    }

    // input.prompt is passed to the LLM for processing fetched content (handled by the caller)

    // Upgrade to HTTPS
    const url = upgradeUrl(rawUrl);

    // Validate URL
    try {
      new URL(url);
    } catch {
      return toolError(`Invalid URL: ${rawUrl}`);
    }

    // Check cache
    evictCache();
    const cached = cache.get(url);
    if (cached) {
      return toolSuccess(cached.content);
    }

    // Fetch with redirect handling
    let currentUrl = url;
    let response: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      // Combine with ctx abort signal
      if (ctx.abortSignal?.aborted) {
        clearTimeout(timer);
        return toolError('Request aborted');
      }

      response = await fetch(currentUrl, {
        headers: {
          'User-Agent': 'agent-sdk',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timer);

      // Check for cross-host redirect
      const finalHost = getHost(response.url);
      const originalHost = getHost(url);
      if (finalHost && originalHost && finalHost !== originalHost) {
        return toolSuccess(
          `The response destination uses a different host: ${response.url}\n` +
          `Review that address, then request it explicitly with WebFetch if it is the intended source.`
        );
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('abort')) {
        return toolError(`Request timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
      return toolError(`Failed to fetch ${url}: ${errMsg}`);
    }

    if (!response.ok) {
      return toolError(`HTTP ${response.status} when fetching ${url}`);
    }

    const contentType = response.headers.get('content-type') || '';
    let body: string;
    try {
      body = await response.text();
    } catch (err: unknown) {
      return toolError(`Failed to read response body: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Convert based on content type
    let text: string;
    if (contentType.includes('html')) {
      text = htmlToMarkdown(body);
    } else if (contentType.includes('json')) {
      try {
        text = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        text = body;
      }
    } else {
      text = body;
    }

    // Truncate if too large
    if (text.length > MAX_CONTENT_LEN) {
      text = text.slice(0, MAX_CONTENT_LEN) +
        `\n\n... (truncated, ${text.length} total characters)`;
    }

    // Cache the result
    cache.set(url, { content: text, timestamp: Date.now() });

    return toolSuccess(text);
  },
};

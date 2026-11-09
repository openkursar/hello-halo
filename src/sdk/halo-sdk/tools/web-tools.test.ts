/**
 * @module tools/web-tools.test
 * Unit tests for WebFetchTool (+ htmlToMarkdown).
 * Mocks global.fetch so no real network calls are made.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ToolContext } from '../types/tool.js';
import { CostTracker } from '../core/cost.js';
import { htmlToMarkdown } from './web-fetch/html-to-markdown.js';
import { WebFetchTool } from './web-fetch/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(env?: Record<string, string>): ToolContext {
  return {
    sessionId: randomUUID(),
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
    costTracker: new CostTracker('test-model'),
    currentTurn: 0,
    env: env ?? {},
  };
}

/** Build a minimal Response object for stubbing global.fetch. */
function makeResponse(
  body: string,
  opts: { status?: number; contentType?: string; url?: string } = {},
): Response {
  const status = opts.status ?? 200;
  const contentType = opts.contentType ?? 'text/html';
  const url = opts.url ?? 'https://example.com/page';

  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: (name: string) => (name === 'content-type' ? contentType : null),
    },
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// htmlToMarkdown
// ---------------------------------------------------------------------------

describe('htmlToMarkdown', () => {
  it('converts headings', () => {
    const md = htmlToMarkdown('<h1>Title</h1><h2>Sub</h2>');
    expect(md).toContain('# Title');
    expect(md).toContain('## Sub');
  });

  it('converts links', () => {
    const md = htmlToMarkdown('<a href="https://example.com">Click</a>');
    expect(md).toContain('[Click](https://example.com)');
  });

  it('converts bold and italic', () => {
    const md = htmlToMarkdown('<strong>Bold</strong> and <em>Italic</em>');
    expect(md).toContain('**Bold**');
    expect(md).toContain('*Italic*');
  });

  it('converts inline code', () => {
    const md = htmlToMarkdown('<code>const x = 1</code>');
    expect(md).toContain('`const x = 1`');
  });

  it('converts code blocks', () => {
    const md = htmlToMarkdown('<pre><code>function foo() {}</code></pre>');
    expect(md).toContain('```');
    expect(md).toContain('function foo() {}');
  });

  it('converts list items', () => {
    const md = htmlToMarkdown('<ul><li>Apple</li><li>Banana</li></ul>');
    expect(md).toContain('- Apple');
    expect(md).toContain('- Banana');
  });

  it('strips script tags and content', () => {
    const md = htmlToMarkdown('<p>Hello</p><script>alert("xss")</script>');
    expect(md).not.toContain('alert');
    expect(md).toContain('Hello');
  });

  it('strips style tags and content', () => {
    const md = htmlToMarkdown('<style>.foo { color: red; }</style><p>Content</p>');
    expect(md).not.toContain('color');
    expect(md).toContain('Content');
  });

  it('strips HTML comments', () => {
    const md = htmlToMarkdown('<!-- secret -->Visible');
    expect(md).not.toContain('secret');
    expect(md).toContain('Visible');
  });

  it('decodes common HTML entities', () => {
    const md = htmlToMarkdown('&amp; &lt; &gt; &quot; &nbsp;');
    expect(md).toContain('&');
    expect(md).toContain('<');
    expect(md).toContain('>');
    expect(md).toContain('"');
  });

  it('collapses excessive newlines', () => {
    const md = htmlToMarkdown('<p>A</p>\n\n\n\n<p>B</p>');
    // Should not have 3+ consecutive newlines
    expect(md).not.toMatch(/\n{3,}/);
  });

  it('strips remaining HTML tags', () => {
    const md = htmlToMarkdown('<div><span class="foo">Text</span></div>');
    expect(md).not.toContain('<');
    expect(md).not.toContain('>');
    expect(md).toContain('Text');
  });
});

// ---------------------------------------------------------------------------
// WebFetchTool
// ---------------------------------------------------------------------------

describe('WebFetchTool', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct metadata', () => {
    expect(WebFetchTool.name).toBe('WebFetch');
    expect(WebFetchTool.permissionLevel).toBe('readonly');
    expect(WebFetchTool.inputSchema).toBeDefined();
  });

  it('returns error when url is missing', async () => {
    const result = await WebFetchTool.execute({ prompt: 'Summary' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('url');
  });

  it('upgrades HTTP to HTTPS', async () => {
    const uid = randomUUID();
    fetchMock.mockResolvedValueOnce(
      makeResponse('<p>Hello</p>', { url: `https://example.com/${uid}` }),
    );

    const result = await WebFetchTool.execute(
      { url: `http://example.com/${uid}`, prompt: 'Summarize' },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
    // fetch should have been called with HTTPS
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toMatch(/^https:\/\//);
  });

  it('returns error for invalid URL', async () => {
    const result = await WebFetchTool.execute(
      { url: 'not-a-url', prompt: 'X' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Invalid URL');
  });

  it('fetches and converts HTML content to markdown', async () => {
    const uid = randomUUID();
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        '<h1>Welcome</h1><p>Hello world</p>',
        { url: `https://example.com/${uid}` },
      ),
    );

    const result = await WebFetchTool.execute(
      { url: `https://example.com/${uid}`, prompt: 'Summarize' },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('# Welcome');
    expect(result.content).toContain('Hello world');
  });

  it('pretty-prints JSON responses', async () => {
    const uid = randomUUID();
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        '{"key":"value","num":42}',
        { contentType: 'application/json', url: `https://api.example.com/${uid}` },
      ),
    );

    const result = await WebFetchTool.execute(
      { url: `https://api.example.com/${uid}`, prompt: 'Show data' },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('"key": "value"');
    expect(result.content).toContain('"num": 42');
  });

  it('returns plain text for non-HTML non-JSON responses', async () => {
    const uid = randomUUID();
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        'Plain text content',
        { contentType: 'text/plain', url: `https://example.com/${uid}` },
      ),
    );

    const result = await WebFetchTool.execute(
      { url: `https://example.com/${uid}`, prompt: 'X' },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Plain text content');
  });

  it('returns error on HTTP error status', async () => {
    const uid = randomUUID();
    fetchMock.mockResolvedValueOnce(
      makeResponse('Not Found', { status: 404, url: `https://example.com/${uid}` }),
    );

    const result = await WebFetchTool.execute(
      { url: `https://example.com/${uid}`, prompt: 'X' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('404');
  });

  it('returns error on network failure', async () => {
    const uid = randomUUID();
    fetchMock.mockRejectedValueOnce(new Error('Network error'));

    const result = await WebFetchTool.execute(
      { url: `https://example.com/${uid}`, prompt: 'X' },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Network error');
  });

  it('truncates content exceeding max length', async () => {
    const uid = randomUUID();
    const longBody = 'A'.repeat(200_000);
    fetchMock.mockResolvedValueOnce(
      makeResponse(longBody, { contentType: 'text/plain', url: `https://example.com/${uid}` }),
    );

    const result = await WebFetchTool.execute(
      { url: `https://example.com/${uid}`, prompt: 'X' },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
    expect((result.content as string).length).toBeLessThan(longBody.length);
    expect(result.content).toContain('truncated');
  });

  it('notifies about cross-host redirects', async () => {
    const uid = randomUUID();
    // Simulate a redirect to a different host
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        '<p>Redirected page</p>',
        { url: `https://other-domain.com/${uid}` },
      ),
    );

    const result = await WebFetchTool.execute(
      { url: `https://original-domain.com/${uid}`, prompt: 'X' },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('destination uses a different host');
    expect(result.content).toContain('request it explicitly');
    expect(result.content).toContain(`https://other-domain.com/${uid}`);
  });

  it('uses cache — fetch called only once for same URL', async () => {
    const uid = randomUUID();
    const url = `https://cacheable.example.com/${uid}`;
    fetchMock.mockResolvedValue(
      makeResponse('<p>Cached content</p>', { url }),
    );

    // First call
    const r1 = await WebFetchTool.execute({ url, prompt: 'X' }, makeCtx());
    // Second call — same URL should hit cache
    const r2 = await WebFetchTool.execute({ url, prompt: 'X' }, makeCtx());

    expect(r1.isError).toBe(false);
    expect(r2.isError).toBe(false);
    expect(r1.output).toBe(r2.output);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns error on pre-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = makeCtx();
    ctx.abortSignal = ac.signal;

    const result = await WebFetchTool.execute(
      { url: 'https://example.com/aborted', prompt: 'X' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('aborted');
  });
});

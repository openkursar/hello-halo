/**
 * @module tools/web-fetch/html-to-markdown
 * Basic HTML to Markdown conversion.
 * Strips scripts/styles, converts common HTML elements to markdown.
 * @license MIT
 */

/**
 * Convert HTML content to a readable markdown-like plain text.
 * Handles: headings, links, images, lists, bold/italic, code, tables, block elements.
 */
export function htmlToMarkdown(html: string): string {
  let result = html;

  // Remove script and style tags and their content
  result = result.replace(/<script[\s\S]*?<\/script>/gi, '');
  result = result.replace(/<style[\s\S]*?<\/style>/gi, '');
  result = result.replace(/<noscript[\s\S]*?<\/noscript>/gi, '');

  // Remove HTML comments
  result = result.replace(/<!--[\s\S]*?-->/g, '');

  // Convert headings
  result = result.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  result = result.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  result = result.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  result = result.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  result = result.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
  result = result.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');

  // Convert links
  result = result.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Convert images
  result = result.replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, '![$1]($2)');
  result = result.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)');
  result = result.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, '![]($1)');

  // Convert bold and italic
  result = result.replace(/<(strong|b)>([\s\S]*?)<\/(strong|b)>/gi, '**$2**');
  result = result.replace(/<(em|i)>([\s\S]*?)<\/(em|i)>/gi, '*$2*');

  // Convert code blocks
  result = result.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  result = result.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  result = result.replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`');

  // Convert lists
  result = result.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  result = result.replace(/<\/?[ou]l[^>]*>/gi, '\n');

  // Convert tables (basic)
  result = result.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row: string) => {
    const cells = row
      .replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, (__, cell: string) => {
        return `| ${cell.trim()} `;
      });
    return cells + '|\n';
  });
  result = result.replace(/<\/?table[^>]*>/gi, '\n');
  result = result.replace(/<\/?t(head|body|foot)[^>]*>/gi, '');

  // Convert block elements to newlines
  result = result.replace(/<br\s*\/?>/gi, '\n');
  result = result.replace(/<\/?p[^>]*>/gi, '\n');
  result = result.replace(/<\/?div[^>]*>/gi, '\n');
  result = result.replace(/<\/?blockquote[^>]*>/gi, '\n');
  result = result.replace(/<hr\s*\/?>/gi, '\n---\n');

  // Remove remaining HTML tags
  result = result.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  result = decodeEntities(result);

  // Clean up whitespace
  result = result.replace(/[ \t]+/g, ' '); // collapse horizontal whitespace
  result = result.replace(/\n{3,}/g, '\n\n'); // max 2 consecutive newlines
  result = result.split('\n').map(l => l.trim()).join('\n'); // trim each line

  return result.trim();
}

/** Decode common HTML entities. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

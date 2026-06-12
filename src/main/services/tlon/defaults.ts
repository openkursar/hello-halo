/**
 * Tlon ingest defaults — seed file contents and the compounding-curator prompts.
 *
 * Ingest runs as a headless agent whose working directory IS the wiki: it
 * searches existing pages (Glob/Grep), reads the relevant ones, and merges each
 * new source in (Write/Edit) so the wiki compounds across sources rather than
 * accumulating per-document summaries. index.md is rebuilt programmatically
 * afterwards (the agent never touches it).
 */

export const DEFAULT_SCHEMA_MD = `# Wiki Schema

This knowledge base is a structured wiki built from source documents.

## Page conventions
- One topic per page. Keep page names short and stable (kebab-case).
- Use \`[[page-name]]\` to cross-link related pages.
- Preserve exact quotes, numbers, dates, and proper nouns from sources.
- Prefer updating an existing page over creating a near-duplicate.

## Suggested structure
- Place pages directly under \`wiki/\` unless a clear sub-topic grouping exists.
- Each page should start with an H1 title, followed by a short summary.
`

export const DEFAULT_INDEX_MD = `# Index

_No wiki pages yet. Add source files and run learning to populate this knowledge base._
`

export const DEFAULT_LOG_MD = `# Ingest Log
`

/**
 * System prompt for the compounding curator agent. Its working directory IS the
 * wiki/ folder; it uses Read/Glob/Grep/Write/Edit to fold a new source into the
 * existing pages.
 */
export function buildCuratorSystemPrompt(schema: string): string {
  return `You are the curator of a compounding knowledge wiki. Your current working directory IS the wiki — its pages are markdown files you can Glob, Grep, Read, Write, and Edit. The wiki must always represent everything known about each topic, MERGED across all sources — never a pile of per-document summaries.

You will be given ONE new source document. Fold its knowledge into the wiki.

## Procedure (do this for every meaningful topic / entity / person / project in the document)
1. SEARCH the existing wiki first: Glob for likely filenames and Grep for the name/topic. Always check before creating anything.
2. If a page already covers it: Read that page, then Edit/Write it to MERGE the new information — keep ALL prior facts, add the new ones, reconcile contradictions by keeping both with their dates. Never delete or shrink existing knowledge.
3. If no page exists: Write a new page. Follow the existing folder structure and naming you observed while searching.

## Rules
- One topic per page. Page names are short, stable, kebab-case. NEVER rename an existing page.
- Cross-link related pages with \`[[page-name]]\`.
- Preserve exact quotes, numbers, dates, stock codes, and proper nouns from the source.
- Every page starts with an \`# H1\` title. Maintain a \`> Sources:\` line near the top listing the source documents it draws from; append the new source if not already there.
- NEVER create or edit \`index.md\` — the index is generated automatically.
- You DO have write access to this directory — never create probe/test/scratch files to check; just write the real pages.
- Make your edits with the tools, then STOP. Do not output prose, plans, or summaries; the result of your work is the files you changed.

## Wiki conventions (schema)
${schema.trim()}`
}

/** User message handing the curator the new source document to fold in. */
export function buildCuratorUserMessage(sourcePath: string, fileContent: string): string {
  return `Fold the following new source document into the wiki.

Source: ${sourcePath}

Search for existing related pages first, merge the new information into them, and create pages only for genuinely new topics. Then stop.

--- BEGIN SOURCE: ${sourcePath} ---
${fileContent}
--- END SOURCE ---`
}

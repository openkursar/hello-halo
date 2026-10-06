/**
 * The name engines give an MCP server's tool: `mcp__<server>__<tool>`, each
 * part with every character outside [A-Za-z0-9_-] replaced by "_" — the rule
 * Claude Code and the halo engine both apply, so a name built here matches the
 * one in their tool lists and in a `disallowedTools` entry.
 */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${normalize(server)}__${normalize(tool)}`
}

function normalize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

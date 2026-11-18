// Generated from the Harness resources.
export const builtinCommandMetadata = [
  {
    "type": "local",
    "name": "clear",
    "description": "Start with an empty conversation while keeping the current session settings",
    "aliases": [
      "reset",
      "new"
    ],
    "source": "builtin"
  },
  {
    "type": "local",
    "name": "compact",
    "description": "Condense earlier messages through the session compaction handler, with optional handover requirements",
    "argumentHint": "[instructions]",
    "source": "builtin"
  },
  {
    "type": "local",
    "name": "context",
    "description": "Summarize the session model, message count, and estimated context size",
    "source": "builtin"
  },
  {
    "type": "local",
    "name": "cost",
    "description": "Report spending, elapsed time, and token counts accumulated from completed turns",
    "source": "builtin"
  },
  {
    "type": "local",
    "name": "help",
    "description": "List callable session commands with their argument hints and descriptions",
    "source": "builtin"
  },
  {
    "type": "prompt",
    "name": "init",
    "description": "Inspect this repository and prepare or improve its AGENTS.md working guide",
    "source": "builtin"
  },
  {
    "type": "local",
    "name": "mcp",
    "description": "Show MCP server connection status",
    "source": "builtin"
  },
  {
    "type": "local",
    "name": "model",
    "description": "Set the AI model",
    "argumentHint": "[model]",
    "source": "builtin"
  },
  {
    "type": "local",
    "name": "status",
    "description": "Inspect this session, its model and working directory, history size, and MCP connections",
    "source": "builtin"
  },
  {
    "type": "local",
    "name": "usage",
    "description": "Report token totals and completed turns for this session",
    "source": "builtin"
  }
] as const;

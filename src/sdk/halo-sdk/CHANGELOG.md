# Changelog

## Unreleased — initial release

Collaboration tools that read, message or stop ignore undeclared arguments
without changing normal receipts. A successful model directory lookup notes when
a filter or page request was not applied. Creating a collaborator, task, task
update or finding still refuses undeclared arguments before running and lists
the accepted ones; creating a collaborator ignores only `summary`,
`description` and `title`.

Compatible with the Claude Agent SDK:

- `query` and `createSession` entry points.
- Message shapes, tool and hook conventions, permission callbacks.
- Persistent sessions and automatic compaction.

Not supported:

- The built-in sub-agent tool and `Options.agents` definitions; delegation uses
  collaboration `spawn_agent` and `team_send`.
- CLI-specific settings, `query().streamInput()` and manual `/compact`.
- Agent definition and catalog APIs.

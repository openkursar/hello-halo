# Halo Official Guides — Index

Last updated: 2026-09-03

Halo's own documentation about how it works, written for agents rather than for the docs site.
Everything here is raw markdown and is read with the `read_halo_doc` tool.

## You are Halo. Read before answering questions about yourself.

When a user asks how Halo works — how to configure something, why something isn't working, what
the difference between two Halo concepts is — **read the relevant guide below before answering**.
Do not answer from memory. Halo's behavior is version- and build-specific, and the most common
failure mode is an agent confidently describing a setting that does not exist, or asking the user
for a value the platform never asks for.

Two rules hold across every guide here:

- **Never assert what a specific install has.** Provider lists, IM channels, notification
  channels, and enabled features vary by build and by user configuration. Ask the user what their
  screen shows, or look with AI Browser. The guides describe *mechanisms*; the user's screen is
  the authority on *contents*.
- **You have no Settings API.** Nearly all configuration in Halo is user-driven UI work. You
  guide the user through it and confirm the result with them; you cannot set it for them. Guides
  give UI paths in `English (中文)` form so you can say it in either language.

## Route by what the user asked

| The user is asking about / reporting | Read |
|---|---|
| Setting up an AI model or API key; "invalid key"; chat produces no reply; context-length errors | `ai-model-setup/index.md` |
| A specific model or auth failure message, and how to fix it | `ai-model-setup/troubleshooting.md` |
| Creating, updating, or fixing a digital human (automation app) | `create-digital-human/SKILL.md` |
| WeCom / WeChat bot setup; "my bot doesn't reply"; any request phrased as "配企业微信" | `message-channels/index.md` |
| Difference between the chat and a digital human; "why doesn't it remember?"; where files live | `spaces-and-agents/index.md` |
| Reading or sending mail, calendar, or "email isn't working" | `email-setup/index.md` |
| Installing or writing a skill or MCP server; "why isn't my tool showing up?" | `skills-and-mcp/index.md` |
| Browser automation; staying logged in to a site; writing a `browser_run` script | `ai-browser/index.md` |
| Controlling Halo from a phone or another machine; the HTTP API; internet access | `remote-access/index.md` |
| Installing Halo; first launch; updates; "where is my config / log file?" | `getting-started/index.md` |

If a question spans two topics, read both — these documents are deliberately small.

## Full document list

Paths are relative to this document. Pass them to `read_halo_doc` exactly as written. Each entry
document opens with a table of its companion documents; read the entry first and follow it.

| Entry document | Covers |
|---|---|
| `getting-started/index.md` | Installing Halo, first launch, updates, and where configuration, data, and logs actually live on each platform. |
| `ai-model-setup/index.md` | How Settings → AI Model works: sources, the four auth methods, adding a key, OAuth, the CLI-delegated source, switching the active source, and model capability overrides. Companion: `ai-model-setup/troubleshooting.md`. |
| `spaces-and-agents/index.md` | Spaces, working directories, and the real difference between a space conversation and a digital human — memory, skills, MCP access, and when creating a digital human is actually warranted. |
| `create-digital-human/SKILL.md` | Authoring and updating digital humans: the interview checklist, how triggers actually work, the App Spec field reference, and worked examples. **Read before calling `create_automation_app` or `update_automation_app`.** Companions: `create-digital-human/interview-checklist.md`, `create-digital-human/im-triggers.md`, `create-digital-human/spec-reference.md`, `create-digital-human/examples.md`. |
| `message-channels/index.md` | Connecting a digital human to WeCom / WeChat: the two bidirectional channel types, how an instance binds to one digital human, permission control, and the separate one-way notification channels that share the name "企业微信". Companions: `message-channels/wecom-bot.md`, `message-channels/weixin-ilink.md`. |
| `email-setup/index.md` | The single global email credential and its two consumers — the mailbox/calendar tools and the one-way notification channel — plus what the Test button does and does not check. |
| `skills-and-mcp/index.md` | Skills and MCP servers: how each is installed, how global vs. space scope resolves, and why skills are ambient within a scope while MCP access is declared per automation. |
| `ai-browser/index.md` | Halo's built-in browser: session and login reuse, when to use it instead of fetching, and its interaction model. Companion: `ai-browser/scripting.md` for writing production `browser_run` scripts. |
| `remote-access/index.md` | The HTTP/WebSocket API, its single shared credential, the optional tunnel, and the security properties the user must understand before enabling it. |

This index is published alongside the guides and updated whenever one is added, so it — not any
list baked into the client — is the authoritative answer to "what documentation exists".

Guides also cite Halo source files, which look like `src/main/apps/spec/PROTOCOL.md` or
`execute.ts:429`. Those are paths **inside the Halo source repository**, recorded so a
maintainer can re-verify a claim against the code as Halo evolves.

**They are not for the user, and not for you to open.** The `src/` tree is not shipped in a
Halo build (`package.json` packages only `out/`, `resources/`, and `product.json`), so those
files do not exist on the machine you are running on, and they are not readable with
`read_halo_doc` either — only the paths listed in this section are.

So: treat a citation as a confidence signal — this statement was verified against code rather
than guessed — and then **answer the user in plain language without it**. Never tell someone
"see `src/main/apps/runtime/execute.ts:429`"; they cannot open it, and for the non-technical
users this documentation exists to serve, it reads as a non-answer. Quote a path only when the
user is clearly working on Halo's own source and asks where something lives.

## Provenance and staleness

Every `read_halo_doc` result begins with an HTML comment naming the tier that answered it: the
documentation host (current), a cache from earlier in this session, or the offline snapshot
bundled with this Halo version. A bundled answer means the docs host was unreachable and the
content may predate the running build — say so if your answer depends on recent behavior.

If a path listed above returns nothing, this build's offline snapshot is older than the document.
The tool's error lists what the snapshot does contain; fall back to a related document rather
than guessing.

These documents cite Halo source files by path so a claim can be checked. If observed behavior
contradicts a guide, trust the observed behavior, tell the user the documentation looks stale,
and do not quietly paper over the difference.

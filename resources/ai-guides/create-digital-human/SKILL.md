---
name: create-digital-human
description: Authoring guide for Halo digital humans (automation apps). Read before calling create_automation_app or update_automation_app.
---

# Creating a Halo Digital Human — What the Tools Don't Tell You

Last updated: 2026-09-03

`create_automation_app`'s tool description explains the JSON **shape** of an App Spec, but not
how the platform actually behaves at runtime. Everything below was verified against Halo's
source (file paths cited). If a statement here contradicts observed behavior, trust the
observed behavior and report the discrepancy — this document is maintained by hand.

## 0. How to read the rest of this guide

The companion documents live next to this one. Read them with the same tool and the same
directory prefix you used for this file:

| Document | Read it when |
|---|---|
| `create-digital-human/interview-checklist.md` | **Always**, before calling `create_automation_app` — what to ask the user, and what NOT to ask |
| `create-digital-human/im-triggers.md` | The digital human should be reachable via WeCom / any IM channel, or should proactively push IM messages — covers the App Spec side (what fields exist, `notify_bot`) |
| `create-digital-human/spec-reference.md` | You need exact field syntax, permission defaults, or output/escalation/memory semantics |
| `create-digital-human/examples.md` | You want a production-quality `system_prompt` structure to model after |

Read at least `interview-checklist.md` before every creation. Read the others on demand.

This topic (creating and configuring a digital human's *own spec*) has a hard boundary with
several sibling topics — read across it, don't duplicate it:

| Document | Read it when |
|---|---|
| `message-channels/index.md` (+ `wecom-bot.md`, `weixin-ilink.md`) | The user is doing anything on the **Settings → Message Channels** side: creating/authorizing a bot instance, binding it to an app, reply scope, permission control (owners/guests), name resolution. `im-triggers.md` covers what the App Spec can and cannot express about IM; `message-channels/` covers the channel/instance layer that exists entirely outside the spec |
| `spaces-and-agents/index.md` | The user asks how a digital human relates to the space it lives in — working directory, persistent memory (digital humans have it, the plain space conversation does not), MCP tool access differences between chatting with it directly vs. its scheduled/triggered runs, or whether it can move to another space (it effectively cannot — no UI path) |
| `ai-browser/index.md` + `ai-browser/scripting.md` | The digital human's task involves web automation — how AI Browser tools work, login-state reuse, and how to write a `browser_run` script instead of ad-hoc clicking |
| `skills-and-mcp/index.md` | You need to know how `requires.skills` / `requires.mcps` dependencies are actually installed, scoped (global vs. space), or authored — this guide only covers how those two fields behave inside an App Spec, not the mechanics of skills/MCP servers themselves |
| `ai-model-setup/index.md` | A run fails with a model/provider/credential error, or the user asks about `recommended_model` (informational only — it does not select or configure a provider) — model/provider configuration is entirely outside the App Spec, at the space or global level |

## 1. Decide the trigger type first — it changes everything downstream

| The user wants it to run... | Use | Detail |
|---|---|---|
| On a timer / repeating interval | `subscriptions: [{ source: { type: "schedule", config: { every / cron } } }]` | `spec-reference.md` |
| When a local file changes | `subscriptions: [{ source: { type: "file", config: {...} } }]` | `spec-reference.md` |
| When an external system POSTs to Halo | `subscriptions: [{ source: { type: "webhook", config: {...} } }]` | `spec-reference.md` |
| When someone messages it on WeCom / an IM channel | **No `subscriptions` at all.** This is NOT a subscription source. | `im-triggers.md` |
| Only when explicitly asked (main chat, or `trigger_automation_app`) | `subscriptions` may be omitted entirely | — |

A digital human can have a schedule *and* be reachable over IM at the same time — those are
two independent mechanisms, not alternatives.

## 2. The #1 mistake: don't invent trigger-matching questions for IM/WeCom

Do **not** ask the user things like "should the bot respond to every message, or only when
mentioned / only messages with a certain prefix?" for a WeCom digital human. In WeCom **group
chats**, the WeCom platform itself only forwards a message to the bot when the bot is
`@`-mentioned — Halo never receives the other messages, so there is nothing to filter and
nothing to configure (`src/main/apps/runtime/dispatch-inbound.ts`, `LEADING_GROUP_MENTION`).
Direct 1:1 chats deliver every message, also not configurable per app.

Full detail — including what *is* configurable and where — in `create-digital-human/im-triggers.md`.

## 3. Schema fields that exist but do nothing yet

`subscriptions[].source.type` accepts `webpage`, `rss`, and `wecom` at the schema level
(`src/main/apps/spec/schema.ts`), but:

- `webpage` and `rss` have no event producer implemented (stated in
  `src/main/apps/spec/PROTOCOL.md` §3.2 — "V2 planned feature, not yet implemented").
- `wecom` as a *subscription source* (`{ type: "wecom", config: { chatId } }`) builds an event
  filter for a `wecom.message` event (`src/main/apps/runtime/service.ts`), but **nothing in
  the runtime ever emits that event**. Real WeCom delivery uses channel-instance binding
  (`dispatch-inbound.ts`), not the event bus.

Never offer these three as working options. For page-change or RSS monitoring, use a
`schedule` subscription that polls with AI Browser instead.

## 4. Never put credentials in `config_schema`

The digital human runs inside the user's own Halo browser session — cookies and auth are
already there. Never create a `config_schema` field for a password, cookie, or session token.
If a task needs the user logged into a specific site, declare it in `browser_login`:

```json
"browser_login": [{ "url": "https://internal-system.example.com", "label": "Internal System" }]
```

This prompts the user to log in before the automation runs and stores no secret
(`src/shared/apps/spec-types.ts`; used by a real production browser-automation app — see
`create-digital-human/examples.md` §3).

## 5. Quick facts you need on almost every call

- **Permissions are additive-only and default ON.** `ai-browser`, `ai-terminal`, `email`,
  `im-push` are all enabled unless the user explicitly turned one off in the UI. Listing a
  permission never turns anything off; omitting one never disables it. Declare what the app
  genuinely uses (`im-push` is required for the `notify_bot` tool to appear).
- **Any web-interaction task must declare `permissions: ["ai-browser"]` and instruct the agent
  to use AI Browser tools** — never HTTP fetch or a generic MCP for browser work.
- **`output.notify` is schema-only — the runtime never reads it.** Don't put
  `output.notify.system`/`output.notify.channels` in a spec expecting it to trigger desktop
  toasts or channel pushes; it silently does nothing. The desktop toast is actually a per-app
  **user override** (`app.userOverrides.notificationLevel`) set afterward in the app's own
  Settings panel, not something `create_automation_app` configures. External channel delivery
  (email/wecom/dingtalk/feishu/webhook) and IM push are both **AI-driven at runtime**: the agent
  itself decides during a run whether to call `notify_channel` or `notify_bot` (needs
  `permissions: ["im-push"]` + a bound IM contact) — if a task must reliably notify, say so in
  `system_prompt`, don't rely on a spec field. See `create-digital-human/spec-reference.md`'s
  `output` section.
- **`update_automation_app` requires a prior `get_automation_status` call** — it is a JSON
  Merge Patch, so guessing the current spec corrupts fields you didn't intend to touch.
- **`create_automation_app` rolls back on dependency failure** — if `requires.skills`
  installation fails, the app is uninstalled automatically. A failure means nothing was left
  behind; it is safe to fix the spec and retry.
- **Web search, memory, and OCR are always on** and not permission-gated — never ask the user
  to enable them.
- **Persistent memory is what actually distinguishes a digital human from "just chatting in a
  space".** A digital human's `memory.md` (`{space}/.halo/apps/{appId}/memory.md`) is read and
  updated on every run; the plain space conversation the user might otherwise use has no
  equivalent file and nothing persists across sessions there. If the task's value is "remember
  what happened last time", that alone justifies creating a digital human. Full detail:
  `spaces-and-agents/index.md`.
- **`requires.mcps` is a real least-privilege gate for scheduled/webhook/file-triggered runs, not
  documentation** — a user-installed MCP server not listed there is silently unavailable to this
  app's autonomous runs even if it's active in the space and the user can see it working when
  they chat with the digital human directly. It has no effect on built-in capabilities
  (`ai-browser`, `ai-terminal`, etc. — those follow `permissions[]` only). See
  `create-digital-human/spec-reference.md`'s `requires` section before assuming an MCP-dependent
  automation will "just work" on its schedule.

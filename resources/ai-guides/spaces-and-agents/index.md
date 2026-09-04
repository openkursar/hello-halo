# Spaces, Space Conversations, and Digital Humans

Last updated: 2026-09-03

Read this whenever the user asks "what's the difference between a space and a digital human",
"why doesn't my chat remember things next time", "where do my digital human's files go", or
wants to know whether a task needs a new digital human at all. Source of truth:
`src/main/services/space.service.ts`, `src/main/apps/manager/` (DESIGN.md + `service.ts`),
`src/main/apps/runtime/` (`execute.ts`, `app-chat.ts`), `src/main/services/agent/helpers.ts`,
`src/main/services/agent/send-message.ts`, `src/main/platform/memory/`.

This topic has no companion documents yet — everything is in this file. For how a digital human
is actually authored (App Spec fields, triggers, IM binding), read
`create-digital-human/SKILL.md` instead; this document is about the surrounding container model.

## 1. What a Space is

A **Space** (`src/main/services/space.service.ts`) is Halo's top-level workspace unit — the thing
listed in the space switcher. Each space is a `SpaceIndexEntry` with:

- `id`, `name`, `icon` — display identity.
- `path` — Halo's own record-keeping directory, under `~/.{dataFolderName}/spaces/{id}/`.
  `dataFolderName` is a build-time value from `product.json` (`getDataFolderName()`,
  `src/main/foundation/product-config.ts:459-467`), `halo` in the open-source template — so it is
  usually `~/.halo/spaces/{id}/`, but resolve it rather than quoting that literally to a user on
  an unknown build. This is **not** necessarily where the user's project files live.
- `workingDir` (optional) — a user-chosen project folder. When set, this is the space's real
  working directory: the AI's `cwd`, the Artifact panel root, and the file-explorer root. When
  unset, `path` itself serves that role.
- `preferences` — layout-only settings (artifact rail expanded, chat width), stored in the
  space's own `.halo/meta.json`, never in the index.

`getSpaceDir(spaceId)` / `getWorkingDir(spaceId)` (`space.service.ts`, `services/agent/helpers.ts`
— two call sites, same logic: `workingDir || path`) is the **single canonical cwd resolver**. Both
the plain space conversation (`send-message.ts`) and every digital human's execution (`execute.ts`,
`app-chat.ts`) call through this same function for their `cwd`. **Everything running inside one
space — the main conversation and every digital human in it — reads and writes the same project
directory.** There is no per-agent sandboxed folder within a space.

**Halo temp** (`halo-temp`) is the always-present default space. It is never written to
`spaces-index.json` (`registerHaloTemp()` re-registers it in memory on every load) and its
effective working directory is `{temp}/artifacts`, not a user-visible project folder.

## 2. Space conversation vs. Digital Human — the actual difference

Both "chatting in a space" and "chatting with a digital human" go through the same underlying
Claude Code SDK session machinery — the difference is entirely in *what's attached*, not in a
different chat engine:

| | **Space conversation** (the default chat you land in) | **Digital Human** (an installed automation app) |
|---|---|---|
| Backing entity | No DB row — just a conversation/session keyed to the space | A row in `installed_apps`, unique on `(spec_id, space_id)` (`src/main/apps/manager/DESIGN.md` §3) |
| Handler | `src/main/services/agent/send-message.ts` | `src/main/apps/runtime/app-chat.ts` (its own chat window) or `execute.ts` (scheduled/triggered/manual runs) |
| `cwd` | `getWorkingDir(spaceId)` | Same function, same space — **identical cwd to the space conversation it lives in** |
| Persistent memory (`memory.md`) | **None.** `send-message.ts` never constructs a `MemoryCallerScope` or the `memory_status` MCP tool — there is nothing for "remember this across sessions" to attach to | Yes — `{space.path}/.halo/apps/{appId}/memory.md`, always keyed by `space.path` (not `workingDir`, even if one is set) so it matches `AppManager`'s directory layout regardless of cwd |
| Skills available | Global skills + this space's skills (`.claude/skills/` under `workingDir||path`) | **Identical set** — skills are scoped to global-or-space, never to an individual app |
| MCP servers available (interactive chat) | All effective MCP servers for the space (`getDbMcpServers`, global + space-scoped) | **Same as the space conversation** when you chat with the digital human directly (`app-chat.ts` also calls `getDbMcpServers`) |
| MCP servers available (scheduled/triggered run) | n/a | **Same built-in capabilities** (`ai-browser`, `ai-terminal`, `halo-email`, plus the always-on `halo-memory`/`halo-report`/`halo-notify`/`web-search`/`ocr`) — those are gated by `permissions[]` only, identically in `execute.ts` and `app-chat.ts`. **Different for user-installed MCP servers**: a scheduled/webhook/file-triggered run only gets ones explicitly listed in `requires.mcps` (`execute.ts` → `getMcpServersForRequires`, a hard allowlist), while chatting with the digital human directly gets *all* of the space's installed MCP servers minus any `requires.mcps` entry with `enabled: false` (`app-chat.ts` → `getDbMcpServers`, the opposite direction — a denylist). See `create-digital-human/spec-reference.md`'s `requires` section for the full mechanics |
| Can run without you present | No — only responds when you type | Yes — schedule / webhook / file-watch subscriptions, or IM messages (see `create-digital-human/im-triggers.md`) |
| Survives being closed | Conversation history persists, but there is no working-memory file that gets *updated* by the AI itself | Memory is actively maintained by the AI (`# now` / `# History` structure) across every run — see `src/main/platform/memory/DESIGN.md` |

**The practical rule of thumb**: if the user just wants to get something done right now in this
session, the space conversation already has the same files, same skills, and same MCP tools as
any digital human they could create — creating one adds nothing. Create a digital human only when
the task needs to (a) run without the user watching (schedule/webhook/file/IM trigger), or (b)
remember state across sessions on its own initiative (price trackers, running logs, anything
where "what happened last time" matters), or (c) be reachable as a distinct chat identity over
IM. See `create-digital-human/interview-checklist.md` for what to ask before creating one.

## 3. A digital human's space is effectively permanent once created

An app's `(spec_id, space_id)` pair is unique — a digital human belongs to one space. **Tell the
user to choose carefully when creating one**: the creation flow has no "move later" affordance,
so treat the space choice as final at creation time.

The backend does have a generic `moveToSpace(appId, newSpaceId)` (`apps/manager/service.ts`),
reachable via IPC (`app:move-space`) and HTTP (`POST /api/apps/{appId}/move-space`) — but the
**only UI caller in the entire renderer is `SkillInfoCard.tsx`**, i.e. it is wired up for
**skill** apps only. There is no button, menu item, or dialog anywhere in the digital-human
management UI that moves an automation app between spaces. Do not tell a user they can move a
digital human to another space later — for all practical (UI-reachable) purposes, they can't.

If a digital human's space *were* changed through the lower-level API, one consequence is worth
knowing in case it ever comes up (e.g. a scripted/HTTP-API workflow): `moveToSpace` migrates the
skill-filesystem location and notifies MCP-scope listeners, but **does not migrate the app's
memory file** — `app-memory` is always resolved from the *current* `space.path`
(`{space.path}/.halo/apps/{appId}/memory.md`), so the app would start with fresh, empty memory in
the new space while its old memory file is silently left behind in the old space's directory.

Automation apps (digital humans) always have a `spaceId` — `execute.ts` asserts this directly
("Automation apps always have a spaceId"). Only skills and MCP servers can be installed with
`spaceId: null` (global scope, shared across every space) — and, per the above, only skills have
a UI path to change scope after installation.

## 4. Work directory layout, concretely

```
{space.path}/                              -- Halo's own record-keeping root
                                              (~/.{dataFolderName}/spaces/{id}/, default "halo")
{space.path}/.halo/meta.json                -- name, icon, preferences
{space.path}/.halo/memory.md                -- (path exists in platform/memory's scope model, but
                                                no caller currently constructs a 'space'-scope
                                                MemoryCallerScope — not wired into any chat today)
{space.path}/.halo/apps/{appId}/             -- one digital human's root work directory
{space.path}/.halo/apps/{appId}/memory.md    -- that digital human's persistent memory
{space.path}/.halo/apps/{appId}/memory/      -- run summaries + compaction archives

{workingDir || space.path}/                  -- the actual cwd for every agent run in this space
{workingDir || space.path}/.claude/skills/   -- space-scoped skills (shared by the space
                                                 conversation and every digital human in it)
```

Two different roots, two different purposes: `space.path` is where Halo keeps its own state
(never treat it as "the user's files"); `workingDir || space.path` is where the AI actually
reads/writes project content and where skill files are auto-discovered by the Claude Code SDK.
`getSpaceDir()`'s own comment calls conflating the two "a category error that has caused real
bugs (e.g. file-export gates rejecting files the AI legitimately produced in its own cwd)" —
don't make the same mistake when explaining this to a user or writing code that touches it.

## 5. Verification

- **A space exists and is usable** if it appears in the space switcher and its working directory
  (Settings, or the space's file explorer panel) resolves to a real, accessible folder.
- **A digital human is correctly scoped to a space** — check its detail page; the space it's
  installed into is shown there, and moving it is an explicit action, never implicit.
- **Memory is actually being used** — only digital humans have this. Ask the AI (via
  `memory_status`, when running as that digital human) or look at
  `{space.path}/.halo/apps/{appId}/memory.md` on disk. A plain space conversation has no such
  file to check — if a user asks "why doesn't the assistant remember our last conversation" in
  the plain space chat, the answer is that this chat has no persistent memory by design; only a
  digital human does.

## 6. Do not ask / do not assume

- **Do not assume a plain space conversation has any persistent memory.** It doesn't — memory is
  exclusively a digital-human (app) feature. Don't tell a user their space chat "remembers" things
  across sessions in the way a digital human's memory.md does; conversation history persists, but
  nothing is actively curated by the AI the way `# now`/`# History` memory is.
- **Do not tell a user they can move a digital human to another space later.** There is no UI
  path to do this (§3) — only skill apps have a "move to space" action. Make sure they pick the
  right space at creation time.
- **Do not offer to create a digital human just to get access to more tools or skills in the
  current session** — a space conversation already has the same skills and the same MCP servers
  as any digital human's own interactive chat in that space (§2). The only real reasons to create
  one are autonomy (schedules/triggers) and self-maintained cross-session memory.
- **Do not confuse `space.path` with the AI's working directory.** They're the same only when the
  user never set a custom `workingDir`. Always resolve through `getSpaceDir()`/`getWorkingDir()`
  logic, never assume `space.path` is where project files live.
- **Do not claim a digital human's scheduled/triggered runs and its interactive chat always have
  the same tool access — but do not claim the gap is `requires.mcps` either, unqualified.** Built-in
  capabilities (`ai-browser`, `ai-terminal`, `halo-email`, etc.) are identical in both modes,
  governed by `permissions[]`, and `requires.mcps` has no effect on them at all. The real
  difference is scoped to **user-installed MCP servers**: scheduled/triggered runs only see ones
  declared in `requires.mcps` (allowlist), while interactive chat gets every MCP server the space
  has, minus any explicitly disabled there (denylist) — same field, opposite semantics depending
  on which path is running. Telling a user "add it to `requires.mcps`" is the right fix only when
  the missing capability is a real installed MCP server, not a built-in one — see
  `create-digital-human/spec-reference.md`.

# Halo Context

> Audience: AI and human engineers working in this repository.
> Goal: quickly understand what Halo does, its quality standards, and mandatory conventions.

## 1) Product Definition

### Vision & Positioning

> Turn Claude Code — a "DOS-era AI" — into a "Windows-era AI companion"

Halo = Claude Code SDK capabilities + ChatGPT-level UI/UX

**Core value**: Wrap complex technical concepts (Agent Loop / CLI / tool calling) into an intuitive human interaction model. Every UI surface must feel polished, responsive, and production-ready.

### Product Form

Halo is a local-first Electron AI product with:
- Conversational AI + tool calling + Agent Loop
- Space-based work context (temporary and dedicated spaces)
- Artifact/file workflows and content viewing (Content Canvas)
- AI Browser automation capability
- Optional remote access via HTTP + WebSocket (same React app, different transport)
- Installable Apps foundation — digital humans driven by schedule, event, **or inbound IM messages**
- **Digital teams & remote offices** — multiple digital humans coordinated as a team; an office spans machines via P2P federation (LAN or relay gateway), with multi-replica message history
- **IM Channel Integration** — dozens of IM platforms (WeCom, WeChat ilink, Feishu, DingTalk, ...) as first-class input/output via a unified plugin-style provider architecture
- App Store for discovering and installing apps/skills

## 2) Current Delivery State

### Implemented

- **Core chat/agent**: Full Agent Loop with thoughts display, extended thinking, tool calls, permission confirmation, AskUserQuestion, multimodal images, token usage tracking, compact notification
- **Space management**: Halo temporary space + dedicated spaces with centralized storage
- **Conversation management**: Lazy-loaded with thoughts separation, starred conversations, Pulse panel for task status
- **Content Canvas**: Multi-tab preview (Code/Markdown/HTML/Image/JSON/CSV/Browser) with CodeMirror 6
- **AI Browser**: 14 tools (consolidated from 28), Accessibility Tree, anti-detection stealth
- **AI Sources**: Multi-provider architecture (OAuth + Custom API Key), v2 format
- **Remote Access**: HTTP Server + WebSocket, PIN auth, tunnel support
- **OpenAI Compatible Mode**: Anthropic <-> OpenAI protocol bridge
- **Apps Layer**: spec, manager, runtime, conversation-mcp implemented; runtime supports schedule/event/IM triggers
- **IM Channels**: Plugin-style provider architecture — currently ships WeCom Bot + WeChat ilink; designed to scale to dozens of IM platforms via `ImChannelProvider` interface
- **Platform Layer**: store (SQLite), scheduler, event, memory, background implemented
- **App Store**: Registry system, store UI, install/uninstall
- **Digital Team / Remote Office**: in-process coordination kernel (message-bus/blackboard/orchestration) + cross-node federation (device-key identity, authority election/replication/handover, durable feed outbox, multi-replica session transcripts, Go relay gateway); validated by a dedicated multi-process cluster regression tier (`tests/decentralized/`)
- **Health system**: Diagnostics, recovery, process guardian
- **Notification channels**: Email, WeChat Work, DingTalk, Feishu, Webhook (outbound-only; distinct from IM Channels which are bidirectional)
- **MCP**: Supports stdio/http/sse MCP server types
- **Settings**: Multi-section settings with navigation
- **i18n**: Internationalization support
- **System**: Tray/auto-launch, auto-update, global search, performance monitoring

### Pending

- Phase 4 (E2E validation for Apps) is still pending
- `store-index` in apps layer planned but not implemented

## 3) Development Principles (Must Follow)

### 3.1 Architecture Principles

- **Backend Single Source of Truth (SSOT)**: Thoughts/session real-time state is authoritative in the main process; the frontend must not persist state independently.
- **BrowserWindow Safety**: Always check `!mainWindow.isDestroyed()` before accessing `mainWindow`, especially in async callbacks and event listeners.
- **Layering**: `apps/runtime` is the orchestration boundary. New automation behavior should not bypass `apps/runtime` and `platform/*` contracts.
- **Local-first**: No required cloud backend for core behavior.

### 3.2 Styling Principles (Non-Negotiable)

- **Theme system**: Never hardcode colors; use only CSS variables from `globals.css` (shadcn pattern).
  ```css
  /* Correct */
  bg-background, text-foreground, hsl(var(--primary))
  /* Wrong */
  #ffffff, rgb(0,0,0), bg-gray-100
  ```
- **Tailwind first**: Only use CSS files for animations, pseudo-elements, nested selectors, or third-party overrides.
- **Responsive design is mandatory**: Every UI change must work on mobile (< 640px). Use Tailwind `sm:` breakpoint as the mobile/desktop boundary. See `ARCHITECTURE.md §13` for full rules and examples.

### 3.3 Security & Privacy

- **Never commit real API Keys/Tokens to the repository (including docs).**
- Configuration stored in `~/.halo/config.json`; never hardcode secrets in source/docs.
- Remote Access PIN/token is ephemeral (in-memory only); never output to logs/docs.

### 3.4 Web Mode

- Web clients cannot open local paths/folders; UI must show a "Please open in desktop client" prompt.
- If a feature supports Web mode, handle the corresponding adapter and interface properly.
- Web and Electron share the same responsive solution — changes must work in both.

### 3.5 Code Style

- Use English for comments (for internationalization and open-source readability).
- Use `t('English text')` for text internationalization; never hardcode user-facing strings.
- No need to manually maintain locale JSON — translation is automated. Run `npm run i18n` before commit.

### 3.6 Performance

- **Performance is a hard requirement**: do not regress startup speed, runtime responsiveness, or memory behavior.
- Essential startup path must remain minimal; heavy work stays in extended/lazy init.
- Automation model is trigger-driven (schedule/event/manual), not always-on token consumption.

### 3.7 Logging

- Must ensure full-process logging in production to trace every execution stage.
- Include timestamps, context information, and error stack traces.
- Keep logging lightweight — avoid unnecessary computation solely for log output.

## 4) Interface Layout

- **Left sidebar**: Conversation list + Space selector (collapsible)
- **Center**: Chat Stream (conversation flow)
- **Right**: Content Canvas (content preview) + Artifact Rail (file list)
- **No Canvas open**: Chat takes full width
- **Canvas open**: Chat narrows + Canvas + ArtifactRail

This layout applies to both desktop and remote web.

## 5) What This Means for New Development

- Treat `apps/` + `platform/` as the default foundation for new workstation features.
- `services/` remains critical infrastructure, but new automation behavior should not bypass `apps/runtime` and `platform/*` contracts.
- Main-process state is authoritative; renderer should consume APIs/events rather than re-implement persistence.
- Keep desktop and remote behavior aligned when feature scope includes remote usage.
- **Every renderer change must be responsive** — test at mobile width (< 640px).

## 6) Mandatory Next Read

1. `ARCHITECTURE.md` (layer boundaries, directory structure, types, IPC, theme, CSS, responsive, layout, storage, tech stack)
2. `quick.md` (hard rules and task-to-file routing)

Then jump directly to module design docs when implementing:
- `src/main/apps/*/DESIGN.md`
- `src/main/platform/*/DESIGN.md`

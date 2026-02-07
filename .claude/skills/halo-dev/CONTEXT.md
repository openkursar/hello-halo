# Halo — Project Context (AI Developer Required Reading)

> Purpose: The shortest onboarding document for AI developers working on Halo. Read this page, then refer to `ARCHITECTURE.md` (technical architecture) and `CHANGELOG.md` (recent changes) before starting work.

## 0) Vision & Background

### Why Halo?

Market research (October 2025) revealed: most third-party AI clients (Chatbox, NextChat, LobeChat) are just API chat wrappers without real **Agent Loop** capability. The only products with true Agent capabilities are developer tools (Cline, Claude Code CLI).

**Market gap**: No pure desktop client that simultaneously supports:
- Custom API keys
- Native Agent Loop (not just chat)
- User-friendly UI (not a terminal)
- Remote access from anywhere

### Halo's Positioning

> Turn Claude Code — a "DOS-era AI" — into a "Windows-era AI companion"

Halo = Claude Code SDK capabilities + ChatGPT-level UI/UX

**Core value**: Wrap complex technical concepts (Agent Loop/CLI) into an intuitive human interaction model.

### Product Naming

- **Halo** (the product)
- **Halo Space** (temporary workspace) — "Wandering moments where ideas crystallize"
- **Dedicated Space** — User-created persistent workspaces

## 1) Current State (Facts to Align On)

- **Product form**: Electron desktop client (local-first), no external backend dependency; supports optional **Remote Access** (same frontend accessible via HTTP/WS).

- **Core capabilities**:
  - Chat + Agent Loop + Tool calls + Permission confirmation
  - Thought (reasoning process) real-time display and replay
  - Extended Thinking (deep reasoning mode)

- **Shipped modules**:
  - **Space**: Halo temporary space + Dedicated spaces (custom paths)
  - **Conversation**: Lazy-loaded (`ConversationMeta` index for speed); messages persisted (including thoughts/images)
  - **Artifact**: Scans workspace directory to generate artifact list; tree view (file tree)
  - **Content Canvas**: Multi-tab content preview (Code/Markdown/HTML/Image/JSON/CSV/Browser)
  - **AI Browser**: 26 browser tools, AI controls real web pages (Accessibility Tree)
  - **AI Sources**: Multi-provider support (OAuth + Custom API Key)
  - **Remote Access**: Local HTTP Server + WebSocket; PIN login; limited Web capabilities
  - **OpenAI Compatible Mode**: Anthropic request conversion to OpenAI `/v1/chat/completions`
  - **MCP**: Supports stdio/http/sse MCP server types
  - **i18n**: Internationalization support
  - **System**: Tray/auto-launch; auto-update (GitHub Releases); multimodal image messages

## 2) MVP Goals

- **Goal**: Deliver a stable, smooth, polished "AI desktop client that gets things done" on macOS/Windows; focus on **UI/UX/interaction details**, not feature sprawl.
- **Non-goals (deferred)**:
  - External backend/database (keep local-first)
  - Large-scale directory restructuring (unless docs are aligned first and benefits are clear)

## 3) Development Principles (Must Follow)

### 3.1 Architecture Principles

- **Backend Single Source of Truth (SSOT)**: Thoughts/session real-time state is authoritative in the main process; the frontend must not persist state independently.
- **BrowserWindow Safety**: Always check `!mainWindow.isDestroyed()` before accessing `mainWindow`, especially in async callbacks and event listeners.

### 3.2 Styling Principles

- **Theme system**: Never hardcode colors; use only CSS variables from `globals.css` (shadcn pattern).
  ```css
  /* Correct */
  bg-background, text-foreground, hsl(var(--primary))
  /* Wrong */
  #ffffff, rgb(0,0,0), bg-gray-100
  ```
- **Tailwind first**: Only use CSS files for animations, pseudo-elements, or third-party overrides.

### 3.3 Security & Privacy

- **Never commit real API Keys/Tokens to the repository (including docs).**
- Configuration is stored in `~/.halo/config.json`; never hardcode secrets in source/docs.
- Remote Access PIN/token is ephemeral (in-memory only); never output to logs/docs.

### 3.4 Web Mode

- Web clients cannot open local paths/folders; UI must show a "Please open in desktop client" prompt.
- If a feature supports Web mode, handle the corresponding adapter and interface properly.

### 3.5 Code Style

- Use English for comments (for internationalization and open-source readability)
- Use `t('English text')` for text internationalization; never hardcode Chinese or any non-English strings

---

## Appendix: Core Product Concepts

### Space Concept

- **Halo Space (temporary)**: Default workspace, `~/.halo/temp/`
- **Dedicated Space**: User-created persistent space, can point to any directory

### Interface Layout

- **Left**: Chat Stream (conversation flow)
- **Right**: Content Canvas (content preview) + Artifact Rail (file list)

### File Display

- Not a developer-style tree structure (optional)
- Default: card-style user-friendly display



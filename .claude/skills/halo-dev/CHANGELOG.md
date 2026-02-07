# Halo Changelog

> For AI developers: Read this file to understand the project's evolution and key implementation details. Read alongside `CONTEXT.md` (product requirements) and `ARCHITECTURE.md` (technical architecture).
>
> Only records iterations with significant impact on architecture or feature modules. Minor UI tweaks are not recorded. Keep it concise.

---

## AI Sources Multi-Provider Architecture

Extensible AI provider authentication architecture. The core defines only abstract interfaces; concrete Provider implementations are independent.

**Architecture**:
```
AISourcesConfig
├── current: '<provider-type>'        # Currently active source
├── custom?: CustomSourceConfig       # Built-in: API Key method
└── [provider]?: OAuthSourceConfig    # Dynamic: third-party Provider
```

**Provider interface**:
```typescript
interface OAuthAISourceProvider {
  isConfigured(config): boolean
  getBackendConfig(config): BackendRequestConfig | null
  startLogin(): Promise<OAuthStartResult>
  completeLogin(state): Promise<OAuthCompleteResult>
  refreshToken() / checkToken() / logout()
}
```

**Extension method**: Third-party Providers go in `halo-local/src/providers/`, dynamically loaded via `product.json`.

**New files**:
```
src/main/services/ai-sources/
├── index.ts
├── manager.ts           # Provider manager
├── auth-loader.ts       # Dynamic loading
└── providers/
    └── custom.provider.ts
src/main/services/secure-storage.service.ts  # Token secure storage
src/main/ipc/auth.ts
src/renderer/components/setup/LoginSelector.tsx
```

**New IPC channels**:
- `auth:get-providers` / `auth:start-login` / `auth:complete-login`
- `auth:refresh-token` / `auth:check-token` / `auth:logout`
- `auth:login-progress` (Event)

---

## Content Canvas File Previewer

"AI Browser" experience — preview AI-generated files in-app.

**Core components**:
```
src/renderer/components/canvas/
├── ContentCanvas.tsx      # Main container + tab switching
├── CanvasTabs.tsx         # Tab bar
└── viewers/
    ├── CodeViewer.tsx     # CodeMirror 6
    ├── MarkdownViewer.tsx # react-markdown
    ├── HtmlViewer.tsx     # iframe srcdoc
    ├── ImageViewer.tsx    # Zoom/pan
    ├── JsonViewer.tsx     # Format/minify
    ├── CsvViewer.tsx      # Table view
    ├── TextViewer.tsx
    └── BrowserViewer.tsx  # Live web pages
```

**Layout switching**:
- No Canvas: Full-width chat
- With Canvas: Narrow chat (380px) + Canvas + ArtifactRail

**Technical decisions**:
- HTML preview uses `<iframe srcdoc>` to avoid CSP issues
- Fullscreen uses `BrowserWindow.maximize()`

---

## Agent Module Refactoring

Split `agent.service.ts` (1927 lines) into a modular structure.

**New structure**:
```
src/main/services/agent/
├── index.ts              # Public API
├── types.ts              # Type definitions
├── helpers.ts            # Utility functions
├── session-manager.ts    # V2 Session management
├── mcp-manager.ts        # MCP state management
├── permission-handler.ts # Permission handling
├── message-utils.ts      # Message building/parsing
├── send-message.ts       # Core send logic
└── control.ts            # Generation control
```

**Affected files**:
- `src/main/ipc/agent.ts`
- `src/main/controllers/agent.controller.ts`

---

## AI Browser Module

AI-controlled embedded browser. Uses Electron BrowserView + CDP.

**26 browser tools**:

| Category | Tools |
|----------|-------|
| Navigation | `browser_new_page`, `browser_navigate`, `browser_list_pages`, `browser_select_page`, `browser_close_page`, `browser_wait_for` |
| Input | `browser_click`, `browser_fill`, `browser_fill_form`, `browser_hover`, `browser_drag`, `browser_press_key`, `browser_upload_file`, `browser_handle_dialog` |
| Snapshot | `browser_snapshot` (core!), `browser_screenshot`, `browser_evaluate` |
| Debug | `browser_console`, `browser_network_requests`, `browser_network_request` |
| Emulation | `browser_emulate`, `browser_resize` |
| Performance | `browser_perf_start`, `browser_perf_stop`, `browser_perf_insight` |

**Core innovation — Accessibility Tree**:
- Uses CDP `Accessibility.getFullAXTree`
- Each element assigned a unique UID (e.g., `snap_1_42`)
- AI locates elements by UID — no CSS selectors needed
- Lower token cost than DOM parsing

**New files**:
```
src/main/services/ai-browser/
├── index.ts
├── types.ts
├── context.ts            # Browser context management
├── snapshot.ts           # Accessibility tree snapshot
├── sdk-mcp-server.ts
└── tools/
    ├── navigation.ts
    ├── input.ts
    ├── snapshot.ts
    ├── network.ts
    ├── console.ts
    ├── emulation.ts
    └── performance.ts
src/main/ipc/ai-browser.ts
src/renderer/stores/ai-browser.store.ts
```

---

## Windows Git Bash Auto-Detection & Installation

Resolves the issue where Windows users cannot use the Agent due to missing Git Bash.

**Root cause**: Claude Code CLI on Windows depends on Git Bash as the shell execution environment.

**Solution**:
1. Detect Git Bash presence at startup
2. Show setup screen if not detected
3. One-click download of Portable Git (~50MB) with silent extraction
4. Optional skip (limited functionality mode)

**New files**:
- `src/main/services/git-bash.service.ts`
- `src/main/services/git-bash-installer.service.ts`
- `src/main/ipc/git-bash.ts`
- `src/renderer/components/setup/GitBashSetup.tsx`

---

## Global Search

Cross-space, cross-conversation message search.

**Search scopes**:
- `conversation`: Current conversation
- `space`: All conversations in current space
- `global`: All spaces

**New files**:
- `src/main/services/search.service.ts`
- `src/main/ipc/search.ts`
- `src/renderer/stores/search.store.ts`
- `src/renderer/components/search/`

---

## MCP Server Configuration UI

Visual MCP configuration interface with dual editing modes.

**Features**:
- Server list view
- Visual mode: Form-based editing
- JSON mode: textarea editor
- Enable/disable: Click power icon to temporarily disable
- Supports stdio/http/sse types
- Format compatible with Cursor/Claude Desktop

---

## OpenAI Compatible Mode

Supports OpenAI-format APIs (OpenAI, DeepSeek, etc.).

**Implementation**: Local Express Router that converts Anthropic protocol to OpenAI format — SDK is unaware.

**New directory**: `src/main/openai-compat-router/`

---

## Multimodal Message Support

Supports sending images in conversations.

**Features**:
- Image drag-and-drop, paste, and file picker
- Smart compression (Canvas API)
- Fullscreen image viewer

---

## V2 Session Reuse

Uses `unstable_v2_createSession` for persistent sessions.

**Improvements**:
- Subsequent messages in the same conversation reuse the process
- After the first message, response time reduced by ~45%
- SDK limitations fixed via `patch-package`

---

## Remote Access

Control desktop Halo remotely via browser.

**Core changes**:
```
src/main/http/               # HTTP server
├── server.ts               # Express + Vite proxy
├── auth.ts                 # Token authentication
├── websocket.ts            # Real-time communication
└── routes/
src/main/controllers/        # Business logic (IPC/HTTP shared)
src/renderer/api/            # API adapter
├── index.ts                # Unified interface
└── transport.ts            # IPC/HTTP transport layer
```

**Authentication flow**:
1. Server generates 6-digit PIN
2. Browser enters PIN -> receives Token
3. Token stored in localStorage; auto-logout on 401

**Web mode limitations**:
- Artifacts cannot be clicked to open
- Shows "Please open in desktop client" prompt

---

## Thought System

Real-time display and replay of Agent reasoning process.

**Thought types**:
```typescript
type ThoughtType = 'thinking' | 'text' | 'tool_use' | 'tool_result' | 'system' | 'result' | 'error';
```

**Message addition timing**:
- `handleAgentMessage` -> Only updates `streamingContent`
- `handleAgentComplete` -> The sole place where assistant messages are added

---

## Backend Single Source of Truth (SSOT)

Thoughts data flow refactoring — backend becomes the single source of truth.

**Improvement**:
```
Old flow: Backend generates -> Sends to frontend -> Frontend accumulates -> Frontend saves
New flow: Backend generates -> Backend accumulates -> Backend saves -> Frontend loads from backend
```

**Result**:
- Thoughts persist through page refresh
- Frontend crashes don't affect data integrity

---

## System Tray & Auto-Launch

**Features**:
- Auto-launch at startup
- Close window minimizes to tray
- Tray icon context menu

**New files**:
- `src/main/services/tray.service.ts`
- `src/main/ipc/system.ts`

---

## Performance Monitoring Service

Developer tool — monitor application performance.

**Features**:
- FPS/frame time monitoring
- Memory usage tracking
- Long task detection
- Performance warnings

**New files**:
```
src/main/services/perf/
├── perf.service.ts
└── types.ts
src/main/ipc/perf.ts
src/renderer/stores/perf.store.ts
```

---

## Stealth Anti-Detection Module

AI Browser anti-detection rules to prevent websites from identifying automated tools.

**New directory**:
```
src/main/services/stealth/
├── index.ts
├── utils.ts
└── evasions/    # 15 anti-detection rules
    ├── navigator.webdriver.ts
    ├── chrome.runtime.ts
    └── ...
```

---

## Initial Release v0.1.0

- Electron + React + TailwindCSS + Zustand architecture
- Claude Code SDK integration
- Space management (Halo temporary space + Dedicated spaces)
- Conversation management
- Tool calls + Permission confirmation
- Dark/Light/System theme

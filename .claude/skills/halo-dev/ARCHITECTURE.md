# Halo Architecture

> For AI developers: Read this file to understand the project's key architecture.
> Only records iterations with significant impact on architecture or feature modules. Minor UI tweaks are not recorded. Keep it concise.

## Directory Structure

```
halo/
├── electron.vite.config.ts       # Electron Vite config
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── tsconfig.web.json
│
├── src/
│   ├── main/                      # Electron Main Process
│   │   ├── index.ts               # Main entry, app lifecycle
│   │   ├── bootstrap/             # App startup logic
│   │   │   ├── essential-services.ts
│   │   │   └── extended-services.ts
│   │   ├── controllers/           # Business logic (IPC/HTTP shared)
│   │   │   ├── agent.controller.ts
│   │   │   ├── config.controller.ts
│   │   │   ├── conversation.controller.ts
│   │   │   └── space.controller.ts
│   │   ├── http/                  # Remote Access: Express + WebSocket
│   │   │   ├── auth.ts
│   │   │   ├── server.ts
│   │   │   ├── websocket.ts
│   │   │   └── routes/
│   │   ├── ipc/                   # IPC handlers (16 modules)
│   │   │   ├── agent.ts
│   │   │   ├── ai-browser.ts
│   │   │   ├── artifact.ts
│   │   │   ├── auth.ts
│   │   │   ├── browser.ts
│   │   │   ├── config.ts
│   │   │   ├── conversation.ts
│   │   │   ├── git-bash.ts
│   │   │   ├── onboarding.ts
│   │   │   ├── overlay.ts
│   │   │   ├── perf.ts
│   │   │   ├── remote.ts
│   │   │   ├── search.ts
│   │   │   ├── space.ts
│   │   │   └── system.ts
│   │   ├── openai-compat-router/  # OpenAI compat: Anthropic <-> OpenAI bridge
│   │   │   ├── converters/
│   │   │   ├── server/
│   │   │   ├── stream/
│   │   │   └── types/
│   │   └── services/              # Domain services
│   │       ├── agent/             # Agent engine (modular)
│   │       │   ├── index.ts
│   │       │   ├── types.ts
│   │       │   ├── helpers.ts
│   │       │   ├── session-manager.ts
│   │       │   ├── mcp-manager.ts
│   │       │   ├── permission-handler.ts
│   │       │   ├── message-utils.ts
│   │       │   ├── send-message.ts
│   │       │   └── control.ts
│   │       ├── ai-browser/        # AI Browser (26 tools)
│   │       │   ├── index.ts
│   │       │   ├── types.ts
│   │       │   ├── context.ts     # BrowserContext management
│   │       │   ├── snapshot.ts    # Accessibility tree
│   │       │   ├── sdk-mcp-server.ts
│   │       │   └── tools/
│   │       │       ├── navigation.ts
│   │       │       ├── input.ts
│   │       │       ├── snapshot.ts
│   │       │       ├── network.ts
│   │       │       ├── console.ts
│   │       │       ├── emulation.ts
│   │       │       └── performance.ts
│   │       ├── ai-sources/        # Multi-provider auth
│   │       │   ├── index.ts
│   │       │   ├── manager.ts
│   │       │   ├── auth-loader.ts
│   │       │   └── providers/
│   │       │       ├── github-copilot.provider.ts
│   │       │       └── custom.provider.ts
│   │       ├── analytics/         # Usage analytics
│   │       │   ├── analytics.service.ts
│   │       │   └── providers/
│   │       ├── perf/              # Performance monitoring
│   │       │   ├── perf.service.ts
│   │       │   └── types.ts
│   │       ├── stealth/           # Anti-detection rules
│   │       │   ├── index.ts
│   │       │   └── evasions/      # 15 evasion modules
│   │       ├── artifact.service.ts
│   │       ├── artifact-cache.service.ts
│   │       ├── browser-view.service.ts
│   │       ├── config.service.ts
│   │       ├── conversation.service.ts
│   │       ├── git-bash.service.ts
│   │       ├── git-bash-installer.service.ts
│   │       ├── mock-bash.service.ts
│   │       ├── onboarding.service.ts
│   │       ├── overlay.service.ts
│   │       ├── protocol.service.ts
│   │       ├── remote.service.ts
│   │       ├── search.service.ts
│   │       ├── secure-storage.service.ts
│   │       ├── space.service.ts
│   │       ├── tunnel.service.ts
│   │       ├── updater.service.ts
│   │       └── window.service.ts
│   │
│   ├── preload/
│   │   └── index.ts               # ~300 lines, exposes HaloAPI
│   │
│   └── renderer/                  # React Frontend
│       ├── index.html
│       ├── main.tsx
│       ├── App.tsx
│       ├── api/                   # API Adapter (IPC/HTTP transport)
│       │   ├── index.ts           # ~1000 lines, unified interface
│       │   └── transport.ts
│       ├── components/
│       │   ├── artifact/
│       │   │   ├── ArtifactCard.tsx
│       │   │   ├── ArtifactRail.tsx
│       │   │   └── ArtifactTree.tsx
│       │   ├── canvas/            # Content Canvas (v1.1)
│       │   │   ├── ContentCanvas.tsx
│       │   │   ├── CanvasTabs.tsx
│       │   │   └── viewers/
│       │   │       ├── CodeViewer.tsx      # CodeMirror
│       │   │       ├── MarkdownViewer.tsx
│       │   │       ├── HtmlViewer.tsx
│       │   │       ├── ImageViewer.tsx
│       │   │       ├── JsonViewer.tsx
│       │   │       ├── CsvViewer.tsx
│       │   │       ├── TextViewer.tsx
│       │   │       └── BrowserViewer.tsx
│       │   ├── chat/
│       │   │   ├── ChatView.tsx
│       │   │   ├── ChatHistoryPanel.tsx
│       │   │   ├── ConversationList.tsx
│       │   │   ├── InputArea.tsx
│       │   │   ├── MessageList.tsx
│       │   │   ├── MessageItem.tsx
│       │   │   ├── MarkdownRenderer.tsx
│       │   │   ├── ThinkingBlock.tsx
│       │   │   ├── ThoughtProcess.tsx
│       │   │   ├── CollapsedThoughtProcess.tsx
│       │   │   ├── ImageViewer.tsx
│       │   │   ├── ImageAttachmentPreview.tsx
│       │   │   └── tool-result/   # Tool result viewers
│       │   ├── diff/
│       │   │   ├── DiffModal.tsx
│       │   │   ├── DiffContent.tsx
│       │   │   └── FileChangesList.tsx
│       │   ├── layout/
│       │   │   ├── Header.tsx
│       │   │   ├── ModelSelector.tsx
│       │   │   └── ChatCapsule.tsx
│       │   ├── onboarding/
│       │   │   ├── OnboardingOverlay.tsx
│       │   │   └── Spotlight.tsx
│       │   ├── search/
│       │   │   ├── SearchPanel.tsx
│       │   │   └── SearchHighlightBar.tsx
│       │   ├── settings/
│       │   │   └── McpServerList.tsx
│       │   ├── setup/
│       │   │   ├── SetupFlow.tsx
│       │   │   ├── ApiSetup.tsx
│       │   │   ├── LoginSelector.tsx
│       │   │   ├── GitBashSetup.tsx
│       │   │   └── GitBashWarningBanner.tsx
│       │   ├── tool/
│       │   │   ├── ToolCard.tsx
│       │   │   └── TodoCard.tsx
│       │   ├── updater/
│       │   └── ui/                # shadcn/ui components
│       ├── pages/
│       │   ├── HomePage.tsx
│       │   ├── SpacePage.tsx
│       │   └── SettingsPage.tsx
│       ├── stores/                # Zustand (8 stores)
│       │   ├── app.store.ts
│       │   ├── chat.store.ts
│       │   ├── space.store.ts
│       │   ├── canvas.store.ts
│       │   ├── search.store.ts
│       │   ├── onboarding.store.ts
│       │   ├── perf.store.ts
│       │   └── ai-browser.store.ts
│       ├── hooks/
│       │   ├── useCanvasLifecycle.ts
│       │   ├── useLayoutPreferences.ts
│       │   ├── useSmartScroll.ts
│       │   ├── useSearchShortcuts.ts
│       │   └── useIsMobile.ts
│       ├── types/
│       │   └── index.ts           # All shared types (~670 lines)
│       ├── lib/
│       │   ├── codemirror-setup.ts
│       │   ├── highlight-loader.ts
│       │   └── utils.ts           # cn() helper
│       ├── i18n/
│       │   ├── index.ts
│       │   └── locales/
│       └── assets/styles/
│           ├── globals.css        # Theme variables, @keyframes
│           ├── syntax-theme.css
│           └── canvas-tabs.css
│
├── patches/                       # patch-package (SDK fixes)
│   └── @anthropic-ai+claude-agent-sdk+*.patch
│
└── resources/                     # App resources
    ├── icon.icns
    └── tray/
```

## Data Types

**Primary source**: `src/renderer/types/index.ts`

Key types:

| Type | Description |
|------|-------------|
| `HaloConfig` | App config: `api`, `aiSources`, `permissions`, `appearance`, `system`, `remoteAccess`, `mcpServers` |
| `AISourcesConfig` | Multi-provider: `current`, `oauth`, `custom`, dynamic providers |
| `ConversationMeta` | Lightweight list item (no messages) |
| `Conversation` | Full conversation with `messages` and `sessionId` |
| `Message` | Contains `content`, `toolCalls`, `thoughts`, `images`, `tokenUsage` |
| `Thought` | Agent reasoning: `thinking`, `text`, `tool_use`, `tool_result` |
| `Artifact` / `ArtifactTreeNode` | Files in space |
| `McpServerConfig` | MCP server: `stdio` / `http` / `sse` types |
| `CanvasContext` | AI awareness of open Canvas tabs |

## IPC Channels

```typescript
// ===== Auth (Multi-provider) =====
'auth:get-providers'
'auth:start-login'
'auth:complete-login'
'auth:refresh-token'
'auth:check-token'
'auth:logout'
'auth:login-progress'        // Event

// ===== Config =====
'config:get'
'config:set'
'config:validate-api'
'config:refresh-ai-sources'

// ===== Space =====
'space:get-halo'
'space:list'
'space:create'
'space:update'
'space:delete'
'space:get'
'space:open-folder'
'space:get-default-path'
'space:get-preferences'
'space:update-preferences'
'dialog:select-folder'

// ===== Conversation =====
'conversation:list'
'conversation:create'
'conversation:get'
'conversation:update'
'conversation:delete'
'conversation:add-message'
'conversation:update-last-message'

// ===== Agent =====
'agent:send-message'
'agent:stop'
'agent:approve-tool'
'agent:reject-tool'
'agent:get-session-state'
'agent:ensure-session-warm'
'agent:test-mcp'
// Events (main -> renderer)
'agent:message'
'agent:thought'
'agent:thought-delta'
'agent:tool-call'
'agent:tool-result'
'agent:error'
'agent:complete'
'agent:mcp-status'
'agent:compact'

// ===== Artifact =====
'artifact:list'
'artifact:list-tree'
'artifact:load-children'
'artifact:init-watcher'
'artifact:changed'           // Event
'artifact:open'
'artifact:show-in-folder'
'artifact:read-content'
'artifact:save-content'
'artifact:detect-type'

// ===== Search =====
'search:execute'
'search:cancel'
'search:progress'            // Event
'search:cancelled'           // Event

// ===== Browser (Content Canvas) =====
'browser:create-view'
'browser:destroy-view'
'browser:show-view'
'browser:hide-view'
'browser:resize-view'
'browser:navigate'
'browser:go-back'
'browser:go-forward'
'browser:reload'
'browser:stop'
'browser:get-state'
'browser:capture'
'browser:execute-js'
'browser:set-zoom'
'browser:toggle-devtools'
'browser:context-menu'
'browser:state-change'       // Event
'browser:zoom-changed'       // Event

// ===== AI Browser =====
'ai-browser:active-view-changed'  // Event

// ===== Canvas Tab =====
'canvas:tab-context-menu'
'canvas:tab-action'          // Event
'canvas:exit-maximized'      // Event

// ===== Overlay =====
'overlay:show-chat-capsule'
'overlay:hide-chat-capsule'

// ===== Remote Access =====
'remote:enable'
'remote:disable'
'remote:status'
'remote:qrcode'
'remote:set-password'
'remote:regenerate-password'
'remote:tunnel:enable'
'remote:tunnel:disable'
'remote:status-change'       // Event

// ===== System =====
'system:get-auto-launch'
'system:set-auto-launch'

// ===== Window =====
'window:set-title-bar-overlay'
'window:maximize'
'window:unmaximize'
'window:is-maximized'
'window:toggle-maximize'
'window:maximize-change'     // Event

// ===== Updater =====
'updater:check'
'updater:install'
'updater:get-version'
'updater:status'             // Event

// ===== Performance =====
'perf:start'
'perf:stop'
'perf:get-state'
'perf:get-history'
'perf:clear-history'
'perf:set-config'
'perf:export'
'perf:report-renderer-metrics'
'perf:snapshot'              // Event
'perf:warning'               // Event

// ===== Git Bash (Windows) =====
'git-bash:status'
'git-bash:install'
'shell:open-external'

// ===== Bootstrap =====
'bootstrap:get-status'
'bootstrap:extended-ready'   // Event

// ===== Onboarding =====
'onboarding:write-artifact'
'onboarding:save-conversation'
```

### Checklist for Adding New IPC Channels

When adding a new IPC event channel, update these **3 files** in sync:

| File | Purpose | Example |
|------|---------|---------|
| `src/preload/index.ts` | Expose listener to `window.halo` | `onAgentMcpStatus: (cb) => createEventListener('agent:mcp-status', cb)` |
| `src/renderer/api/transport.ts` | Map channel to method name in `methodMap` | `'agent:mcp-status': 'onAgentMcpStatus'` |
| `src/renderer/api/index.ts` | Export unified API | `onAgentMcpStatus: (cb) => onEvent('agent:mcp-status', cb)` |

**Missing any of these will cause events to not reach the renderer process.**

## State Flow

```
Renderer (UI)
  → api adapter (IPC in Electron, HTTP in Web)
  → Main Process (controllers/services)
  → Agent Loop (@anthropic-ai/claude-agent-sdk)
  → Events (IPC or WebSocket for remote)
  → UI Update
```

**BrowserWindow lifecycle**: Always check `!mainWindow.isDestroyed()` before accessing `mainWindow`, especially in async callbacks and event listeners (the window may already be destroyed).

## Service Inter-Communication

Services in the Main Process use a **callback registration pattern** for cross-module notifications to avoid circular dependencies:

**API config hot-reload**:
- `config.service.ts` provides `onApiConfigChange(callback)` registration
- `agent.service.ts` registers the callback at module load
- When API config changes (provider/apiKey/apiUrl), agent is automatically notified to clean up all V2 Sessions
- User's next message automatically creates a new Session with the updated config

## AI Browser Module

AI-controlled embedded browser for web automation. Uses Electron BrowserView + CDP.

### 26 Browser Tools

| Category | Tools |
|----------|-------|
| Navigation | `browser_new_page`, `browser_navigate`, `browser_list_pages`, `browser_select_page`, `browser_close_page`, `browser_wait_for` |
| Input | `browser_click`, `browser_fill`, `browser_fill_form`, `browser_hover`, `browser_drag`, `browser_press_key`, `browser_upload_file`, `browser_handle_dialog` |
| Snapshot | `browser_snapshot` (core!), `browser_screenshot`, `browser_evaluate` |
| Debug | `browser_console`, `browser_network_requests`, `browser_network_request` |
| Emulation | `browser_emulate`, `browser_resize` |
| Performance | `browser_perf_start`, `browser_perf_stop`, `browser_perf_insight` |

### Accessibility Tree (Core Innovation)

- Uses CDP `Accessibility.getFullAXTree` for page structure
- Each interactive element gets a unique UID (e.g., `snap_1_42`)
- AI references elements by UID — no CSS selectors needed
- Lower token cost than DOM parsing

## AI Sources (Multi-Provider)

Extensible AI provider architecture. The core defines only abstract interfaces; concrete implementations are provided by individual Providers.

### Architecture

```
AISourcesConfig
├── current: '<provider-type>'        # Currently active source
├── custom?: CustomSourceConfig       # Built-in: API Key method
└── [provider]?: OAuthSourceConfig    # Dynamic: third-party Providers
```

### Provider Interface

```typescript
interface OAuthAISourceProvider {
  type: AISourceType
  displayName: string

  // State queries
  isConfigured(config): boolean
  getBackendConfig(config): BackendRequestConfig | null
  getCurrentModel(config): string | null
  getAvailableModels(config): Promise<string[]>
  getUserInfo(config): AISourceUserInfo | null

  // OAuth lifecycle (concrete flow implemented by each Provider)
  startLogin(): Promise<OAuthStartResult>
  completeLogin(state): Promise<OAuthCompleteResult>
  refreshToken(): Promise<void>
  checkToken(): Promise<{ valid, expiresIn }>
  logout(): Promise<void>
  refreshConfig(config): Promise<Partial<AISourcesConfig>>
}
```

### Extension Method

Third-party Providers go in `halo-local/src/providers/`, dynamically loaded via `product.json`.
Core code contains no concrete Provider implementations, keeping it open-source friendly.

Token secure storage: `secure-storage.service.ts` (Electron safeStorage)

## Content Canvas

"AI Browser" experience — preview AI-generated files in-app.

### Components

```
ContentCanvas.tsx          # Main container + tab switching
├── CanvasTabs.tsx         # Tab bar
└── viewers/
    ├── CodeViewer.tsx     # CodeMirror 6 with syntax highlighting
    ├── MarkdownViewer.tsx # react-markdown
    ├── HtmlViewer.tsx     # iframe srcdoc
    ├── ImageViewer.tsx    # Zoom/pan
    ├── JsonViewer.tsx     # Format/minify
    ├── CsvViewer.tsx      # Table view
    ├── TextViewer.tsx
    └── BrowserViewer.tsx  # Live web pages
```

### Layout Modes

- **No Canvas**: Full-width chat
- **With Canvas**: Narrow chat (380px) + Canvas + ArtifactRail

### IPC Extensions

```typescript
// Artifact content reading
'artifact:read-content'

// Window control (maximize/restore)
'window:maximize'
'window:unmaximize'
'window:is-maximized'
'window:toggle-maximize'
'window:maximize-change'    // Event: main -> renderer
```

### Technical Decisions

- **HTML preview**: Uses `<iframe srcdoc>` instead of blob URLs (avoids CSP restrictions)
- **Fullscreen**: Calls `BrowserWindow.maximize()` for window-level maximization (similar to Chrome/VSCode)

## Multi-Platform Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Electron App                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────────┐  │
│  │  Renderer   │    │    Main     │    │    HTTP Server      │  │
│  │  (React)    │◄──►│  Process    │◄──►│    (Express)        │  │
│  │             │IPC │             │    │                     │  │
│  └─────────────┘    └─────────────┘    │  ┌───────────────┐  │  │
│                                        │  │  WebSocket    │  │  │
│                                        │  │  (ws)         │  │  │
│                                        │  └───────────────┘  │  │
│                                        │  ┌───────────────┐  │  │
│                                        │  │  REST API     │  │  │
│                                        │  │  (/api/*)     │  │  │
│                                        │  └───────────────┘  │  │
│                                        └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │ HTTP/WS
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Remote Web Client                            │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                    Same React App                        │    │
│  │                                                          │    │
│  │   api adapter: isElectron() ? IPC : HTTP                │    │
│  │                                                          │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### API Adapter Pattern

```typescript
// src/renderer/api/index.ts
export const api = {
  getConfig: async () => {
    if (isElectron()) return window.halo.getConfig()  // IPC
    return httpRequest('GET', '/api/config')          // HTTP
  }
}
```

### Authentication Flow

1. Server generates 6-digit PIN on start
2. User enters PIN on login page
3. Token stored in localStorage
4. All API requests include `Authorization: Bearer <token>`
5. On 401, auto-clear token and redirect to login

### WebSocket Events

Remote clients receive real-time events via WebSocket:
- Subscribe to conversation: `{ type: 'subscribe', payload: { conversationId } }`
- Receive events: `{ type: 'event', channel: 'agent:thought', data: {...} }`

### Dev Mode

In development, the HTTP server proxies to Vite dev server:
- Static files -> Vite (localhost:5173)
- WebSocket HMR -> Vite
- API routes -> Express handlers

### Web Mode Limitations

Some features are disabled in web mode:
- Open file/folder (cannot access local filesystem)
- Artifact click-to-open (shows "Please open in desktop client" hint)

## OpenAI Compatible Mode

When `provider = openai`:

```
SDK (Anthropic format)
  → openai-compat-router (localhost)
  → Convert to OpenAI /v1/chat/completions
  → External OpenAI-compatible API
  → Convert response back to Anthropic format
  → SDK receives standard response
```

Location: `src/main/openai-compat-router/`

## Local Storage Layout

Halo uses the local filesystem for data storage (no external database/backend):

```
~/.halo/
├── config.json                 # Global config (API/permissions/theme/remote access/etc.)
├── spaces-index.json           # Records custom-path spaces (customPaths)
├── temp/                       # Halo temporary space (id: halo-temp)
│   ├── artifacts/              # Temporary space artifacts
│   └── conversations/          # Temporary space conversations (with index.json)
└── spaces/                     # Default dedicated spaces directory
    └── <spaceName>/
        ├── .halo/
        │   ├── meta.json       # Space metadata (id/name/icon/timestamps)
        │   └── conversations/  # Conversation storage (with index.json)
        └── <user files / agent outputs...>
```

Notes:
- **Custom-path spaces**: Also create `.halo/` in the target directory; deleting the space only removes `.halo/` (preserves user files).
- **Lazy-loaded conversations**: `conversation.service.ts` uses `index.json` for fast listing; full conversation data (`<conversationId>.json`) is loaded only when entering a conversation.

## Theme System

CSS variable-based theming. **Do not use hardcoded colors.**

- Follows shadcn/ui design pattern
- Uses CSS variables (`--background`, `--foreground`, `--primary`, etc.)
- Components reference colors via `hsl(var(--xxx))`
- Default dark theme, `.light` class overrides to light

```css
/* Use */
bg-background, text-foreground, border-border
hsl(var(--primary)), hsl(var(--muted-foreground))

/* Never */
#ffffff, rgb(0,0,0), bg-gray-100
```

### CSS Architecture: Tailwind First

**Use Tailwind by default.** Only use CSS files for what Tailwind can't handle:
- `@keyframes` animations
- Complex `::before` / `::after` pseudo-elements
- Nested selectors (`.parent:hover .child`)
- Third-party library overrides (e.g., highlight.js)

```
src/renderer/assets/styles/
├── globals.css           # Theme variables, @keyframes, base styles
├── syntax-theme.css      # highlight.js syntax colors
├── canvas-tabs.css       # VS Code style tab bar
└── browser-task-card.css # AI Browser effects
```

### Responsive Design

**Web mode requires consideration of different platform displays**, using responsive solutions consistent with Tailwind system.

- **Unified mobile breakpoint**: Use Tailwind's `sm:` breakpoint (640px) as the boundary between mobile and desktop
- **Prefer Tailwind responsive classes**: Use `sm:`, `md:`, `lg:`, etc.; minimize JavaScript detection logic
- **Mobile-first adaptation**: Focus on mobile adaptation (< 640px); large screens are not a priority for now
- **Web and Electron consistency**: Web browser and Electron desktop share the same responsive solution

Theme switch: `<html>` class toggle in `App.tsx`
Anti-flash: `index.html` inline script reads `localStorage('halo-theme')`

## Internationalization (i18n)

**No hardcoded text.** Use `t('English text')`.

```tsx
// Correct
<Button>{t('Save')}</Button>
// Wrong
<Button>Save</Button>
```

No need to manually write translation files — translation is automated.

Run `npm run i18n` before commit.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Electron 28 |
| UI | React 18 + TailwindCSS 3.4 |
| State | Zustand 4.5 |
| i18n | i18next 25.7 |
| Code Editor | CodeMirror 6 |
| Markdown | react-markdown 10 + remark-gfm + rehype-highlight |
| File Tree | react-arborist |
| Diff | diff + react-diff-viewer-continued |
| HTTP | Express 5 |
| WebSocket | ws |
| Agent | @anthropic-ai/claude-agent-sdk |
| Icons | lucide-react |
| Build | electron-vite + Vite 5 |
| Test | Vitest + Playwright |

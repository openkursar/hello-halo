# quick.md

> Fast execution rules and routing for AI/human developers.
> Read after `CONTEXT.md` and `ARCHITECTURE.md`.

## 1) Hard Rules (Must Follow)

1. **Modularity, quality, and maintainability are first priority.**
   - Keep responsibilities isolated by module and layer.
   - Do not use quick fixes that create long-term architecture debt.
   - Every change must preserve or improve performance (startup, runtime latency, memory).
   - If there is a trade-off conflict (quick fix vs architecture quality), request explicit user approval before proceeding.

2. **No hardcoded user text in renderer.** Use `t('English text')`.
   - Do not manually maintain locale JSON for normal changes.
   - Run `npm run i18n` before final handoff.
   - Use English for all code comments.

3. **Tailwind first.**
   - Prefer utility classes for all styling.
   - Only use CSS files for: `@keyframes` animations, complex pseudo-elements, nested selectors, third-party overrides.
   - Do not create new CSS files unless these exceptions apply.
   - Existing CSS files and their responsibilities:
     - `globals.css` — Theme variables, @keyframes, base styles
     - `syntax-theme.css` — highlight.js syntax colors
     - `canvas-tabs.css` — VS Code style tab bar
     - `browser-task-card.css` — AI Browser effects

4. **No hardcoded colors. Ever.**
   - Use theme tokens/classes: `bg-background`, `text-foreground`, `border-border`, `hsl(var(--primary))`, `hsl(var(--muted-foreground))`
   - Never use: `#ffffff`, `rgb(0,0,0)`, `bg-gray-100`, `text-white` (except on explicitly colored backgrounds like `bg-primary`)
   - Do not use Tailwind palette colors (e.g. `bg-slate-100`, `bg-zinc-800`) as substitutes for theme tokens. Palette colors are fine for functional/semantic purposes (e.g. `bg-red-500` for error indicators).
   ```tsx
   /* Correct */
   <div className="bg-background text-foreground border border-border">
   <span className="text-muted-foreground">
   <button className="bg-primary text-primary-foreground">

   /* Wrong */
   <div className="bg-white text-black border border-gray-200">
   <span className="text-gray-500">
   <button className="bg-blue-500 text-white">
   ```

5. **Responsive design is mandatory for every UI change.**
   - Use Tailwind `sm:` breakpoint (640px) as mobile/desktop boundary.
   - Write mobile-first: base classes for mobile, `sm:` prefix for desktop overrides.
   - Prefer Tailwind responsive classes over JS detection (`useIsMobile` only when CSS alone cannot solve it).
   - Test all UI at < 640px width.
   ```tsx
   /* Correct: mobile-first responsive */
   <div className="flex flex-col sm:flex-row gap-2 sm:gap-4">
   <div className="w-full sm:w-80">
   <div className="p-3 sm:p-6">
   <div className="text-sm sm:text-base">
   <nav className="hidden sm:flex">       {/* desktop only */}
   <nav className="flex sm:hidden">        {/* mobile only */}

   /* Wrong: desktop-only, breaks on mobile */
   <div className="flex flex-row gap-4">
   <div className="w-80">
   <div className="p-6">
   ```

6. **Respect layering and module boundaries.**
   - Do not move business logic into IPC/HTTP/preload/renderer transport.
   - Keep orchestration in `apps/runtime` and infrastructure in `platform/*`.

7. **Transport contract changes must be synchronized.**
   - IPC request APIs: update main handler + preload + renderer API.
   - Event channels: update sender + preload listener + renderer transport/API.
   - Remote-capable features: also align HTTP routes and WebSocket behavior.
   - **Missing any sync file will cause events to silently not reach the renderer.**

8. **Essential startup is protected.**
   - New feature default = extended phase.
   - Only first-screen-critical handlers belong in essential init.

9. **Schema/persistence changes require migrations.**
   - Add versioned migration in the owning module (`apps/*` or `platform/*`).

10. **Tests are required for Apps/Platform changes.**
    - Add/update tests under `tests/unit/apps/*` or `tests/unit/platform/*`.

11. **Never expose secrets.**
    - No API keys/tokens in source, docs, logs, or fixtures.

12. **Production logging is required.**
    - Log all process stages with timestamps and context information.
    - Include error stack traces. Keep logging lightweight.

13. **IM providers are plug-ins, not first-class code.**
    - Adding support for a new IM = create one new `<brand>.provider.ts` under `src/main/apps/runtime/im-channels/`.
    - Never modify `ImChannelManager`, `dispatch-inbound.ts`, or any existing provider when adding support.
    - Never introduce provider-specific branches (`if (type === 'xxx')`) in generic code paths — put the logic in a provider method.
    - Never bypass the `InboundMessage` / `ReplyHandle` contract; providers must normalize all upward traffic to it.
    - Brand-specific IPC files (`ipc/wecom-bot.ts`, etc.) only expose unique setup/auth flows (QR login, token refresh). Generic channel operations go in `ipc/im-channels.ts` / `ipc/im-sessions.ts`.
    - See `ARCHITECTURE.md §22` for the full contract and recipe.

## 2) Fast Task Router

### Backend / Apps / Platform

| If you need to... | Start here | Usually also touch |
|---|---|---|
| Change config / logging / window / secure-storage / product.json | `src/main/foundation/*` | Foundation is the bedrock tier (zero upward deps). NEVER import `platform/services/apps/http` from here. |
| Let a service use App data (manager, halo-apps MCP) | `src/main/services/app-bridge.ts` | Register impls in `apps/runtime/index.ts`. Do NOT import `apps/*` values from `services/*` (type-only is OK). |
| Add/change App spec fields | `src/main/apps/spec/schema.ts` | `spec/parse.ts`, `spec/validate.ts`, `src/shared/apps/spec-types.ts`, `tests/unit/apps/spec/*` |
| Change install/config/status lifecycle | `src/main/apps/manager/service.ts` | `manager/store.ts`, `manager/migrations.ts`, `tests/unit/apps/manager/*` |
| Change execution/trigger/escalation/activity | `src/main/apps/runtime/service.ts` | `runtime/execute.ts`, `runtime/report-tool.ts`, `runtime/store.ts`, `tests/unit/apps/runtime/*` |
| Change scheduling behavior | `src/main/platform/scheduler/index.ts` | `scheduler/schedule.ts`, `scheduler/store.ts`, `tests/unit/platform/scheduler/*` |
| Add event source/filter behavior | `src/main/platform/event/*` | `src/main/bootstrap/extended.ts` |
| Change memory behavior/tools | `src/main/platform/memory/index.ts` | `memory/tools.ts`, `memory/prompt.ts`, `tests/unit/platform/memory/*` |
| Change agent engine (session / stream / prompt / subagent / permissions / MCP) | **Read `src/main/services/agent/DESIGN.md` first**, then jump to named file | Co-edits depend on the exact concern — see DESIGN.md routing |
| **Support a new IM platform** | New file: `src/main/apps/runtime/im-channels/<brand>.provider.ts` | Register in `runtime/index.ts`, extend `ImChannelType` in `shared/types/im-channel.ts`. **Do NOT touch `manager.ts` / `dispatch-inbound.ts`.** Only add `ipc/<brand>.ts` if the brand has unique setup/auth flow. |
| Change generic IM channel lifecycle / session mgmt | `src/main/apps/runtime/im-channels/manager.ts` / `dispatch-inbound.ts` | `ipc/im-channels.ts`, `ipc/im-sessions.ts`, `shared/types/im-channel.ts`. Must remain provider-agnostic. |

### Renderer / UI

| If you need to... | Start here | Usually also touch |
|---|---|---|
| Modify chat UI | `src/renderer/components/chat/ChatView.tsx` | `MessageList.tsx`, `MessageItem.tsx`, `InputArea.tsx`, `chat.store.ts` |
| Modify Content Canvas | `src/renderer/components/canvas/ContentCanvas.tsx` | `CanvasTabs.tsx`, relevant viewer, `canvas.store.ts` |
| Add/change settings section | `src/renderer/components/settings/` | `nav-config.ts`, `SettingsPage.tsx` |
| Modify Apps UI | `src/renderer/pages/AppsPage.tsx` | `src/renderer/components/apps/*`, `apps.store.ts`, `apps-page.store.ts` |
| Modify Store UI | `src/renderer/components/store/StoreView.tsx` | `StoreGrid.tsx`, `StoreCard.tsx`, `StoreDetail.tsx` |
| Add a new page | `src/renderer/pages/` | `App.tsx` routing, `app.store.ts` (AppView type) |
| Add a new Zustand store | `src/renderer/stores/` | Import in relevant components |
| Add a new hook | `src/renderer/hooks/` | Import in relevant components |

### Transport / IPC

| If you need to... | Start here | Usually also touch |
|---|---|---|
| Add new IPC request API | `src/main/ipc/<module>.ts` | `src/preload/index.ts`, `src/renderer/api/index.ts`, HTTP route if remote-capable |
| Add new real-time event | emitter in main domain service | `src/preload/index.ts`, `src/renderer/api/transport.ts` methodMap, `src/renderer/api/index.ts` |
| Add App IPC APIs | `src/main/ipc/app.ts` | `src/preload/index.ts`, `src/renderer/api/index.ts` |
| Add App HTTP APIs (remote) | `src/main/http/routes/index.ts` | `src/renderer/api/index.ts`, auth/WS flow as needed |
| Add App real-time events | emitter in `src/main/apps/runtime/*` | `src/preload/index.ts`, `src/renderer/api/transport.ts`, `src/renderer/api/index.ts` |

## 3) Common Checklists

### A) Add a new IPC request API

1. Add `ipcMain.handle(...)` in main (domain IPC module).
2. Expose typed method in `src/preload/index.ts` (interface + implementation).
3. Add unified call in `src/renderer/api/index.ts`.
4. If remote must support it, add matching HTTP route and non-Electron fallback.
5. Add/adjust unit tests for touched domain logic.

### B) Add a new real-time event channel

1. Emit event from main domain (`sendToRenderer(...)` and/or `broadcastToAll(...)`).
2. Add preload listener (`createEventListener('channel', ...)`).
3. Add channel mapping in `src/renderer/api/transport.ts` `methodMap`.
4. Add API helper in `src/renderer/api/index.ts`.
5. Verify desktop and remote clients both receive the event when required.

### C) Add a new persistent field (App/Platform)

1. Add migration with new version in owning module.
2. Update store read/write mapping and service-level types.
3. Keep backward compatibility defaults explicit.
4. Add migration-focused unit tests.

### D) Add a new automation trigger path

1. Extend spec schema/type for trigger config.
2. Map trigger to scheduler or event-bus subscription in runtime activation.
3. Ensure run context is included for prompt building.
4. Emit activity entries and status updates for observability.
5. Add tests for activate/deactivate and execution paths.

### E) Add/modify a renderer component

1. Use `t('English text')` for all user-visible strings.
2. Use theme tokens only — no hardcoded colors.
3. Write mobile-first responsive classes (base = mobile, `sm:` = desktop).
4. Test at < 640px viewport width.
5. If it affects Canvas layout, consider `useCanvasLifecycle` and `useLayoutPreferences` hooks.
6. If it shows files/artifacts, handle Web mode limitations (no local file open).

## 4) Known Gaps You Must Account For

1. App activity HTTP route currently uses `limit` and `before`; renderer option names include `since/offset/type` (not all are consumed by backend).

## 5) Minimum Validation Before Handoff

- Run focused unit tests for touched module(s), for example:
  - `npm run test:unit -- tests/unit/apps/manager/manager.test.ts`
  - `npm run test:unit -- tests/unit/apps/runtime/runtime.test.ts`
- Run `npm run i18n` when renderer text changed.
- Confirm desktop path (IPC) and remote path (HTTP/WS) expectations for changed APIs.
- Visually verify responsive behavior at mobile width (< 640px) for any UI changes.

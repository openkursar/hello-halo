# services/ai-terminal — AI Terminal

> Interactive pty terminals the AI controls via MCP tools and the user can see
> and take over. Read this before touching anything under
> `src/main/services/ai-terminal/` or `src/worker/pty-host/`.

## 1) What it is

A pty-backed terminal subsystem, modeled on `services/ai-browser`:

- The AI drives sessions through 7 MCP tools (`terminal_*`), exposed as the
  `ai-terminal` on-demand toolset (see `services/agent/toolsets`).
- The user sees a live xterm.js view in the Canvas and can type into the same
  pty — full-duplex human takeover. Ctrl+C always reaches the pty.
- pty sessions live at **process scope**, fully decoupled from any SDK session
  or UI window: a task keeps running across model switches, session rebuilds,
  and canvas open/close.

Platform: macOS + Windows only. Linux is excluded at packaging (node-pty
prebuilds omitted); `isTerminalAvailable()` gates the whole feature so it never
appears in the capability index, toolset menu, or transport on Linux.

## 2) Process model (pty host) — the architectural core

Ptys do NOT live in the Electron main process. They live in a dedicated
**pty-host worker** (`src/worker/pty-host/`, forked via `child_process.fork`
like the file-watcher worker):

```
renderer (xterm view)  ── IPC/WS (unchanged transport) ──  main
main (ai-terminal module: policy + proxies + fan-out)
    │  child_process IPC, contract: shared/protocol/pty-host.protocol.ts
pty-host worker: node-pty + @xterm/headless + write queue + pause/resume
```

Why: node-pty's spawn is a **synchronous native call** — under endpoint
scanning / weak VDI hardware it can stall for seconds, and in-main it froze the
whole app. Per-chunk ANSI interpretation is also CPU the main loop should never
pay. The worker is forked lazily on first terminal use (never at app startup —
essential-startup rule).

Division of labor (hard boundary):

| Concern | Where | Why |
|---|---|---|
| Shell resolution (`shell.ts`), space scoping, flow-control policy, event fan-out | main | May touch Electron/config; policy must stay out of the worker |
| pty spawn/write/resize/kill, headless xterm buffer, read modes, write-and-wait, wait-for polling, replay buffer, session cap + exited-session pruning | worker | Must sit next to the pty; heavy and stall-prone |
| Session metadata (TerminalInfo) | worker-authoritative, mirrored in main proxies | list()/scoping stay synchronous; event snapshots refresh the mirror |

Main-side pieces: `host.ts` (fork lifecycle, request correlation + timeouts,
crash policy), `session-proxy.ts` (async ops via RPC; input/resize/kill are
fire-and-forget notifications so keystrokes never wait), `context.ts` (proxy
registry + worker-event fan-out to the process event bus).

**Crash policy:** if the worker dies, every pty died with it — nothing is
revivable. Pending RPCs reject, the context marks all sessions exited (UI shows
its ended banner; replay degrades to "output no longer available"), and the
next create() forks a fresh host. We deliberately do NOT implement session
revival: that pattern exists for window reloads, which our process-scoped ptys
already survive.

`terminal_wait_for` runs **worker-side as one RPC** (baseline snapshot +
since-diff poll loop next to the buffer) — never a poll loop chatting over IPC.

## 3) ConPTY / slow-tty hardening mechanics (do not "simplify" away)

Three mechanisms guard the pty against known ConPTY and slow-tty failure modes:

1. **Chunked write queue** (worker `session.ts`): every pty write is split
   (≤50 chars, escape sequences never split, 5ms pacing — `chunkInput`). A
   large paste in one syscall corrupts on slow ttys.
2. **ConPTY kill/spawn throttle** (worker): ≥250ms spacing between kill/spawn
   native calls on Windows ConPTY, to dodge a conhost hang when kill and spawn
   race within a short window.
3. **Flow control** (`flow-control.ts` in main + `pause/resume` in worker +
   viewer acks): attached viewers ack rendered chars (5k batches, sent from the
   xterm `write` callback in `TerminalViewer` / WS `terminal-ack`); when any
   viewer's unacked backlog passes 100k chars the pty is paused, resumed when
   all are back under 5k. **A deliberate design point:** our sessions can be
   headless (AI-only, no view) — flow control engages only while ≥1 viewer is
   attached (`terminal:attach`/`detach`; WS disconnect force-detaches) or a dead
   viewer would pause a pty forever. Headless consumption is the worker's own
   xterm, which backpressures naturally.

## 4) Default shell (Windows = PowerShell, deliberately)

`resolveShell()` (main): Windows default is **powershell.exe** — the standard
Windows default shell. Not just familiarity: `ssh` must resolve to native
Windows OpenSSH (System32). Git Bash's MSYS ssh runs on the msys-2.0.dll
emulated socket layer, which breaks inside VDI virtual-network stacks
(connection killed ~10s after connect, then ssh wedges in raw mode = frozen
terminal); and Git Bash `--login` MSYS init forks dozens of processes (10s+
open under endpoint scanning). Git Bash stays reachable via an explicit
`preferred` path (`terminal_create`'s `shell` arg). This is unrelated to the
Claude-Code Git Bash dependency (`services/git-bash`), which is untouched.

## 5) MCP tools (AI-facing)

`terminal_create`, `terminal_list`, `terminal_write`, `terminal_read`,
`terminal_search`, `terminal_wait_for`, `terminal_kill`. Design principle: common
path is one call (`terminal_write` sends a command and returns its output); the
ground truth (`mode:'screen'`) is always reachable.

**Read is split by intent (`terminal_read` vs `terminal_search`).** `terminal_read`
is *positional* — `new` (incremental), `screen` (ground truth), `scrollback`
(history by `lines`/`offset`). `terminal_search` is the *content query* — a
smart-case regex grep over the interpreted history, returning matches with
±context, 1-based line numbers, and a total-match count. The two are separated so
neither tool carries a parameter that is silently ignored in the other's mode:
`terminal_read` has no `pattern`, `terminal_search` does not page. Smart-case
(`safeRegExp`) means an all-lowercase pattern is case-insensitive and any
uppercase letter makes it case-sensitive, so the AI never sets a case flag. Both
returns are output-capped; on a truncated search the tool header tells the AI to
narrow the pattern rather than page.

## 6) Command-completion model (important)

We do **not** inject prompt hacks (PS1/PROMPT_COMMAND rewriting). Per-shell
injection is fragile (quoting differs across bash/zsh/fish, breaks under ConPTY,
and pollutes the screen the AI reads — this actually broke the first smoke test
on zsh). Instead:

- **Output-idle heuristic** drives completion: N ms with no new output = settled.
  Shell-agnostic, and exactly what the SSH/remote path needs, so it is a
  first-class mechanism, not a fallback.
- **Prompt-line detection** (`endsAtPrompt` in text-utils) distinguishes "settled
  at a prompt" from "went quiet mid-command" (e.g. `sleep 2 && echo done`), so
  `terminal_write` reports `running` accurately. Note the `%` special-case: a
  progress percentage (`45%`) must not read as a zsh prompt.
- **OSC 133 markers are parsed opportunistically** (worker `session.ts` registers
  the handler): if a shell or remote host already emits them, we get precise
  boundaries + exit codes for free. We just never inject them.
- **Continuation-prompt detection** (`endsAtContinuation`) is checked *before*
  the generic prompt test: zsh PS2 tokens (`dquote>`, `heredoc>`, stacked
  `cmdand cmdand dquote>`, …) and bash's bare `>` end in `>` and would otherwise
  be misread as a settled prompt. A wedged parser is reported as
  `awaitingContinuation`, never `done` — otherwise the AI sends its next command
  into an open quote and cascades corruption. The tool tells the AI to send the
  closing delimiter or Ctrl-C (`\u0003`).

SSH is the headline use case and runs on the idle heuristic — validate against
it as a first-class path, not an exception.

### Input delivery: submit flag + CR + split Enter (don't "simplify" this)

`terminal_write` input does not go to the pty verbatim. It takes a `submit`
argument (default true), and the worker's `deliverInput` (via `toPtyWrites`)
shapes the bytes so AI input behaves like a human typing:

1. **`submit` decides the Enter, not the AI's newline**: with `submit=true` the
   caller sends only the command text (`"npm run build"`) and the submitting
   Enter is appended for us; any trailing newline the caller *did* include is
   de-duplicated to a single Enter, so `"cmd"` and `"cmd\n"` are identical. This
   exists because the newline byte is the layer weak models most often
   double-escape into a literal `\n` (which then just gets typed onto the prompt
   line, never submits) — taking the newline out of the model's hands removes the
   failure. `submit=false` writes the bytes raw with no Enter, for keystrokes
   (arrow, Esc, a menu digit) that must not confirm.
2. **LF→CR** (`toPtyInput`): a newline becomes CR (`\r`, 0x0D) — the byte a real
   Return key sends. Cooked-mode shells tolerate a bare LF, but raw-mode TUIs
   recognise Enter *only* as CR, so a bare LF just inserts a newline and never
   submits.
3. **Split the appended Enter into its own delayed write**: Ink-based TUIs (Claude
   Code, Codex) paste-detect a single pty read carrying *text-then-CR* and insert
   a newline instead of submitting. The body and the submitting CR must land in
   **separate reads**; the chunked write queue does not guarantee the split (a
   short body + CR fit one chunk), so the Enter is sent after
   `SUBMIT_KEY_DELAY_MS`. A multi-line body stays one paste; just the appended
   Return submits.

Verified against real Claude Code: `"/help\r"` delivered verbatim (one write)
does not open help; body + a split, delayed CR submits reliably. Harmless for
shells (the tty maps CR→NL either way). User keyboard input (proxy `input`) is
passed through raw — xterm.js already emits CR per keystroke.

### One-time session hardening (AI-owned posix shells)

Distinct from prompt injection (rejected above): when an **AI-owned** session
spawns a **posix** shell, the worker's `prime()` writes a single startup command
`set +o histexpand` before the first AI command (gated by `session.ready`).
Rationale: an interactive shell performs `!` history expansion, which mangles
quote parsing and wedges the parser (`echo "done!"` → zsh stuck at `dquote>`) —
a footgun that exists only because the AI drives a real interactive shell. This
is a one-shot `set -o` toggle (the single spelling bash and zsh share), **not** a
per-prompt PS1/PROMPT_COMMAND hook: it never runs on later prompts, never
rewrites the user's prompt, and emits no escape sequences into the read buffer.
Its echo is swallowed from the AI's incremental view by advancing the read
watermark. User-owned sessions are never primed (humans keep `!!`); non-posix
shells (PowerShell/cmd — including the Windows default) are skipped.

Wrapped-line note: `renderAll()` rejoins physically-wrapped rows
(`joinWrappedLines`) so a line longer than the terminal width is not split
mid-token (the "HTTP 500" → "50\n0" bug). `screen` mode intentionally keeps the
raw grid so cursor coordinates stay valid.

## 7) File map

Main (`src/main/services/ai-terminal/`):

| File | Responsibility |
|---|---|
| `available.ts` | `isTerminalAvailable()` platform gate (os.platform only — safe to import anywhere) |
| `shell.ts` | Per-platform shell resolution → `ResolvedShellSpec` (policy; see §4) |
| `host.ts` | pty-host fork lifecycle, typed RPC client, crash policy |
| `session-proxy.ts` | Per-session handle: mirrored info + RPC ops + fire-and-forget input/resize/kill |
| `flow-control.ts` | Viewer-ack flow controller (high/low watermarks; see §3) |
| `context.ts` | Proxy registry; worker-event fan-out; one process-global singleton |
| `events.ts` | Process-global event bus the context forwards to; transport subscribes here |
| `sdk-mcp-server.ts` | `createTerminalMcpServer(ctx, scope)` — the 7 MCP tools |
| `service.ts` | User/transport-facing ops (list/input/resize/kill/create/replay/viewer attach-detach-ack) |
| `index.ts` | Public API + `AI_TERMINAL_SYSTEM_PROMPT` |

Worker (`src/worker/pty-host/`):

| File | Responsibility |
|---|---|
| `index.ts` | Message loop + session registry (cap, exited-retention pruning) |
| `session.ts` | pty + `@xterm/headless` + read modes + write-and-wait + ConPTY/tty hardening. **node-pty is lazy-required here** (see §8) |
| `text-utils.ts` | Pure helpers (completion heuristic, output shaping) — unit-tested, no pty/xterm deps |

Shared: `shared/types/terminal.ts` (domain types, importable by worker/main/
transport), `shared/protocol/pty-host.protocol.ts` (RPC/event contract).

## 8) node-pty / @xterm/headless loading (cross-platform safety)

Worker `session.ts` loads node-pty via `createRequire(import.meta.url)` inside a
`loadPty()` function, **not** a top-level import — constructing a session is the
only thing that touches the native binding, and the worker is only forked where
`isTerminalAvailable()` passed. `@xterm/headless` is bundled into the worker
build (excluded from `externalizeDepsPlugin` in `electron.vite.config.ts`)
because its CommonJS named exports are not reachable via ESM interop when left
external. The worker entry is registered next to the file-watcher entry in
`electron.vite.config.ts`.

## 9) Read strategy (AI never sees raw ANSI)

The AI reads from the interpreted `@xterm/headless` buffer, never the raw stream:

- `new` — incremental output since last read/write (cheap; for polling).
- `screen` — rendered grid + cursor (ground truth; progress bars, TUIs, prompts).
- `scrollback` — history with `lines`/`offset` paging; capped (~10k lines).
- `terminal_search` — smart-case regex grep over the same history (its own tool,
  not a read mode), returning matches + `context` + line numbers + total count.

All returns are hard-capped (`capOutput`, 2000 lines / 50KB) with a
machine-readable truncation hint. The renderer's xterm gets the **raw** replay
buffer (`replay` RPC) so it can reproduce colors/cursor faithfully.

## 10) Transport & UI

- IPC/HTTP request ops: `ipc/terminal.ts` (+ `terminalRpc` contract) and
  `http/routes/terminal.routes.ts`. Events `terminal:data` / `terminal:lifecycle`
  are forwarded from the global event bus to the renderer and WS clients.
- Remote keyboard/resize use dedicated WS inbound messages
  (`terminal-input` / `terminal-resize` in `http/websocket.ts`) for low-latency
  takeover, with an HTTP fallback. Flow control adds `terminal-attach` /
  `terminal-detach` / `terminal-ack` (WS-only for remote — meaningless without
  the live stream; desktop uses the `terminal:attach/detach/ack` IPC methods).
  A WS disconnect force-detaches that client's attachments.
- Renderer: `stores/terminal.store.ts`, `components/canvas/viewers/TerminalViewer.tsx`
  (xterm + fit + replay + attach/ack), the canvas `terminal` tab type,
  `components/tool/TerminalTaskCard.tsx` (chat card → opens the tab), and
  `components/chat/LiveSessionsHeader.tsx` (ambient strip docked to the composer's
  top edge to perceive, reveal, and stop live AI sessions; sourced via the
  `hooks/useLiveSessions.ts` seam, which surfaces every running **aiTouched**
  session — see §12), and `components/canvas/TerminalCloseGuard.tsx` (tab-close
  policy — see §12).

## 11) Lifecycle hard rules

1. **TerminalContext is process-scoped** and decoupled from SDK sessions. Never
   tie a pty's lifetime to a conversation/session rebuild.
2. **One global singleton** backs every caller (main chat and automation runs)
   and forwards to the event bus, so all sessions are visible and stoppable in
   the UI. Cross-space isolation is enforced by the MCP tool layer
   (`sdk-mcp-server` scopes lookups by `spaceId`), not by separate registries.
3. Max sessions is capped in the worker; app shutdown kills the worker (and all
   ptys) via `cleanupAITerminal()` (wired in `bootstrap/extended.ts`).
4. `terminal_write` is arbitrary command execution — same trust model as the
   Bash tool. The tool description constrains reading during credential entry.
5. The pty-host worker is forked lazily on first terminal use — never during
   startup phases.

## 12) aiTouched & the tab-close policy

The pty outlives its tab (§11.1), so closing a terminal tab is a separate question
from ending the process. That question is answered by **`aiTouched`**, a sticky
flag on `TerminalInfo` (worker-authoritative, mirrored in the proxy):

- `owner: 'ai'` sessions are `aiTouched` from birth (the AI created them).
- A `owner: 'user'` session flips to `aiTouched` the first time the AI drives it
  through **any** `terminal_*` tool (`ctx.markAiTouched`, called in
  `sdk-mcp-server` for write/read/search/wait; create is AI-owned already). The
  flip emits the `touched` lifecycle event **once** so the renderer store updates
  the session's close policy and tray membership. Never cleared.

Two surfaces key off it, replacing the old `owner === 'ai'` checks:

- **Tab close** (`TerminalCloseGuard` registers a two-method policy via
  `canvasLifecycle.setTerminalClosePolicy`, mounted at **SpacePage** so it stays
  active even when the canvas is collapsed):
  - `confirmSingleClose` — deliberate single-tab close (tab X, middle-click, ⌘W,
    context menu): a not-running session just closes; a running non-`aiTouched`
    session (the user's own) is terminated with its tab; a running `aiTouched`
    session prompts keep-in-background vs terminate (killing a pty is
    irreversible, so keep is the safe default).
  - `disposeOnBulkClose` — non-interactive bulk teardown (`closeAll`, and
    `enterSpace` → `closeAll` on space switch): **no prompt**; terminate the
    user's own terminals (the tab was their only handle), keep `aiTouched` ones
    running (they remain in the tray). This holds the invariant *every live pty
    is reachable via a tab or the tray* on every tab-removal path.
- **Live-sessions tray** (`useLiveSessions`): shows every running `aiTouched`
  terminal **scoped to the current space** (`spaceId === currentSpaceId`), so a
  user terminal the AI drove stays perceivable and stoppable after its tab is
  closed, without leaking another space's sessions into this one (it reappears on
  return). The AI browser is a single active view destroyed on space switch, so
  it needs no such filter.

Contrast with the AI browser (`services/ai-browser`): its WebContents is
**tab-bound** (the canvas tab's `browserViewId` *is* the AI's `activeViewId`), so
closing the tab / `closeAll` / space switch destroys it — a page is cheap to
re-open. A pty's running process and state are not recreatable, so the terminal
deliberately decouples and keeps `aiTouched` work alive with the tray as the
reclaim path.

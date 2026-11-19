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

Platform: macOS, Windows, Linux x64. node-pty ships mac/win prebuilds in the npm
package; the Linux binary is vendored at `resources/prebuilds/node-pty/` and
installed by `scripts/prepare-binaries.mjs` (see that file for the linux/amd64 rebuild recipe). Unlike the upstream mac/win binaries, this Linux addon was supplied separately, not downloaded from the npm tarball. Its source package version and reviewed binary digest are pinned in `scripts/lib/node-pty-prebuild.cjs`; prepare and packaging check the digest and ELF architecture. A digest detects substitution, not build provenance; reviewing or rebuilding the addon from the locked source remains part of updating that pin.
`isTerminalAvailable()` gates the whole feature so it never appears in the
capability index, toolset menu, or transport where no prebuild is packaged.

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
| Shell resolution incl. pty environment (`shell.ts`), space scoping, flow-control policy, event fan-out | main | May touch Electron/config; policy must stay out of the worker |
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

### Environment: main assembles it whole, the worker never adds its own

`ResolvedShellSpec.env` is the **complete** pty environment, built by
`resolveShell()` from main's `process.env`. The worker spawns with exactly that
and must never merge in its own `process.env`: `child_process.fork` gives every
worker an `ELECTRON_RUN_AS_NODE=1` (Electron injects it so the fork runs as
Node), and a user shell that inherits it turns every Electron the user launches
into a plain Node process — `npm run dev` in this repo then fails with a missing
`BrowserWindow` export. Main's env is also the only one with fix-path's PATH
repair. Same rule for any future spawn of a user-visible process: the
environment is policy, and policy lives in main.

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
| `person-input.ts` | Whether keyboard-channel input came from a person (terminal replies stripped); see §12 |
| `sdk-mcp-server.ts` | `createTerminalMcpServer(ctx, scope)` — the 7 MCP tools |
| `service.ts` | User/transport-facing ops (list/input/resize/kill/create/replay/viewer attach-detach-ack) |
| `index.ts` | Public API and service metadata exports |
| `guidance.ts` | Resource-independent description and service instructions; no resident terminal tutorial |

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
  `terminal:lifecycle` carries `created` / `exited` / `title` / `ai-activity` /
  `touched` / `removed` (§11.6). The client snapshot (`terminal:list` or
  `GET /api/terminal/list`) adds main's `operating` and `conversationId` to each
  `TerminalInfo`, without changing the worker protocol. Desktop reads it when
  attaching; remote clients read it after authentication, including reconnects.
  The store reconciles missed events without polling or overwriting newer events
  delivered during the read.
- Remote keyboard/resize use dedicated WS inbound messages
  (`terminal-input` / `terminal-resize` in `http/websocket.ts`) for low-latency
  takeover, with an HTTP fallback. Flow control adds `terminal-attach` /
  `terminal-detach` / `terminal-ack` (WS-only for remote — meaningless without
  the live stream; desktop uses the `terminal:attach/detach/ack` IPC methods).
  A WS disconnect force-detaches that client's attachments.
- Renderer: `stores/terminal.store.ts`, `components/canvas/viewers/TerminalViewer.tsx`
  (xterm + fit + replay + attach/ack), the canvas `terminal` tab type,
  `components/tool/TerminalTaskCard.tsx` (chat card → opens the tab). A running
  **aiTouched** session is one of the AI's canvas tabs, added quietly by
  `renderer/services/ai-work-tabs.ts` (see §12); closing it goes through
  `components/canvas/CanvasCloseGuard.tsx`.

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
6. **Every removal is announced; nothing downstream re-derives retention.** A
   session leaves main's registry on worker eviction or a kill of an
   already-exited session, and each path emits a `removed` lifecycle event
   (`TerminalContext.dropSession`) after its `exited`. The worker's bound is
   *not* reproducible upstream: `pruneExitedSessions(keepId)` exempts the
   session that just exited, and orders the rest by `lastActivityAt`, which
   `onExit` does not refresh — so a terminal that idled for hours before dying
   is at once the one the worker keeps and the "oldest" one any copied rule
   evicts first. A mirror bounding itself by that rule drops precisely the entry
   the user is watching, and a viewer re-deriving liveness from the missing
   entry re-opens its keyboard onto a dead pty (hence the latch in
   `lib/terminal-liveness.ts`).

## 12) aiTouched, the AI's tabs and closing them

The pty outlives its tab (§11.1), so closing a terminal tab is a separate question
from ending the process. That question is answered by **`aiTouched`**, a sticky
flag on `TerminalInfo` (worker-authoritative, mirrored in the proxy):

- `owner: 'ai'` sessions are `aiTouched` from birth (the AI created them).
- A `owner: 'user'` session flips to `aiTouched` the first time the AI drives it
  through **any** `terminal_*` tool (`ctx.markAiTouched`, called in
  `sdk-mcp-server` for write/read/search/wait; create is AI-owned already), or
  brings it in front of the user with `canvas_show`. The flip emits the
  `touched` lifecycle event **once**. Never cleared.

**Every running `aiTouched` session is a canvas tab of its space** — there is no
background list. Each client derives the set from its terminal store
(`renderer/services/ai-work-tabs.ts`) and the canvas adds missing tabs at the
end of that space's tabs without opening the canvas or switching tabs, in a
space not on screen too. When the process ends, a tab nobody ever looked at
disappears; one someone looked at stays as the "Session ended" replay, unmarked.

**Closing** (`CanvasCloseGuard` registers the canvas close policy, decisions in
`renderer/services/ai-work-close.ts`, mounted at SpacePage / TlonPage so it
holds while the canvas is collapsed):
- one tab (×, ⌘W, middle-click, context menu): the AI's terminal asks once
  ("End this terminal?" — end and close / cancel; Enter never confirms) and
  closing really ends the process; the user's own running terminal ends with its
  tab, unasked; an exited one just closes;
- several at once (close canvas, close others, close to the right): the user's
  own terminals end with their tabs and the AI's stay, unasked; only when the
  AI's tabs are all that is closing does it ask once — cancel / end all;
- a removed space: everything ends, unasked — main ends the space's sessions
  (`endSpaceTerminals`, called by the space controller), the renderer ends what
  its tabs held.

**Whether the AI is operating a session** comes from main, not from any chat UI:
every `terminal_*` call wraps itself in `ctx.beginAiOperation(id, conversationId)`
/ `endAiOperation(id)`. `shared/ai-operating.ts` holds the state from the first
call until 10 s after the last one ends, and only those two moments are emitted,
as the `ai-activity` lifecycle event (`operating`, plus the operating
`conversationId` so the tab can name whose work it is). A conversation taking a
session over mid-hold re-announces it. Exit, eviction and a worker crash forget
it silently.

**A person typed.** User keyboard input (`service.terminalInput`, IPC and WS
alike) calls `ctx.noteUserInput`: on an `aiTouched` session, input a person made
(`person-input.ts` strips what the terminal writes by itself: cursor/device/
focus/colour reports, mouse motion and releases) sets a per-session flag. The
next `terminal_write`/`read`/`search`/`wait_for` on that session takes the flag
and puts one line in front of its result — the user typed here, read the screen
first. A `read` in `screen` mode takes it silently (it is the resync). What was
typed is never stored; no new message or turn is created.

Contrast with the AI browser (`services/ai-browser`): its pages are canvas tabs
the same way (owned pages of a context with a UI), and closing one ends the page
through `ai-browser:stop-page`, refused while another conversation is on it.

# services/ai-terminal — AI Terminal

> Interactive pty terminals the AI controls via MCP tools and the user can see
> and take over. Read this before touching anything under
> `src/main/services/ai-terminal/`.

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

## 2) File map

| File | Responsibility |
|---|---|
| `types.ts` | Public types (session info, read/write results, events) |
| `available.ts` | `isTerminalAvailable()` platform gate (os.platform only — safe to import anywhere) |
| `shell.ts` | Per-platform shell resolution (zsh/bash, Git Bash on Windows) |
| `session.ts` | `TerminalSession`: pty + `@xterm/headless` screen buffer + read modes + write-and-wait. **node-pty is lazy-required here** (see §5) |
| `text-utils.ts` | Pure helpers (completion heuristic, output shaping) — unit-tested, no pty/xterm deps |
| `context.ts` | `TerminalContext`: session registry; global singleton (main chat) + scoped (automation) |
| `events.ts` | Process-global event bus the global context forwards to; transport subscribes here |
| `sdk-mcp-server.ts` | `createTerminalMcpServer(ctx)` — the 7 MCP tools |
| `service.ts` | User/transport-facing ops (list/input/resize/kill/create/replay) |
| `index.ts` | Public API + `AI_TERMINAL_SYSTEM_PROMPT` |

## 3) MCP tools (AI-facing)

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

## 4) Command-completion model (important)

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
- **OSC 133 markers are parsed opportunistically** (`session.ts` registers the
  handler): if a shell or remote host already emits them, we get precise
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
argument (default true), and `session.deliverInput` (via `toPtyWrites`) shapes
the bytes so AI input behaves like a human typing:

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
   **separate reads**; writing them back-to-back in the same tick races (the OS
   coalesces them). So the Enter is sent after `SUBMIT_KEY_DELAY_MS`. A multi-line
   body stays one paste; just the appended Return submits.

Verified against real Claude Code: `"/help\r"` delivered verbatim (one write)
does not open help; body + a split, delayed CR submits reliably. Harmless for
shells (the tty maps CR→NL either way). User keyboard input (`session.input`) is
passed through raw — xterm.js already emits CR per keystroke.

### One-time session hardening (AI-owned posix shells)

Distinct from prompt injection (rejected above): when an **AI-owned** session
spawns a **posix** shell, `session.prime()` writes a single startup command
`set +o histexpand` before the first AI command (gated by `session.ready`).
Rationale: an interactive shell performs `!` history expansion, which mangles
quote parsing and wedges the parser (`echo "done!"` → zsh stuck at `dquote>`) —
a footgun that exists only because the AI drives a real interactive shell. This
is a one-shot `set -o` toggle (the single spelling bash and zsh share), **not** a
per-prompt PS1/PROMPT_COMMAND hook: it never runs on later prompts, never
rewrites the user's prompt, and emits no escape sequences into the read buffer.
Its echo is swallowed from the AI's incremental view by advancing the read
watermark. User-owned sessions are never primed (humans keep `!!`); non-posix
shells (PowerShell/cmd) are skipped.

Wrapped-line note: `renderAll()` rejoins physically-wrapped rows
(`joinWrappedLines`) so a line longer than the terminal width is not split
mid-token (the "HTTP 500" → "50\n0" bug). `screen` mode intentionally keeps the
raw grid so cursor coordinates stay valid.

## 5) node-pty lazy loading (cross-platform safety)

`session.ts` loads node-pty via `createRequire(import.meta.url)` inside a
`loadPty()` function, **not** a top-level import. Rationale: the toolset registry
imports this module on every platform to read `isTerminalAvailable()` and the
usage guide. A top-level `import 'node-pty'` would execute the native binding
load at import time and crash on Linux (no prebuild). The lazy require is only
hit when a session is actually constructed, which `isTerminalAvailable()`
prevents on Linux.

`@xterm/headless` is bundled into the main process (excluded from
`externalizeDepsPlugin` in `electron.vite.config.ts`) because its CommonJS named
exports are not reachable via ESM interop when left external.

## 6) Read strategy (AI never sees raw ANSI)

The AI reads from the interpreted `@xterm/headless` buffer, never the raw stream:

- `new` — incremental output since last read/write (cheap; for polling).
- `screen` — rendered grid + cursor (ground truth; progress bars, TUIs, prompts).
- `scrollback` — history with `lines`/`offset` paging; capped (~10k lines).
- `terminal_search` — smart-case regex grep over the same history (its own tool,
  not a read mode), returning matches + `context` + line numbers + total count.

All returns are hard-capped (`capOutput`, 2000 lines / 50KB) with a
machine-readable truncation hint. The renderer's xterm gets the **raw** replay
buffer (`getReplayData`) so it can reproduce colors/cursor faithfully.

## 7) Transport & UI

- IPC/HTTP request ops: `ipc/terminal.ts` (+ `terminalRpc` contract) and
  `http/routes/terminal.routes.ts`. Events `terminal:data` / `terminal:lifecycle`
  are forwarded from the global event bus to the renderer and WS clients.
- Remote keyboard/resize use dedicated WS inbound messages
  (`terminal-input` / `terminal-resize` in `http/websocket.ts`) for low-latency
  takeover, with an HTTP fallback.
- Renderer: `stores/terminal.store.ts`, `components/canvas/viewers/TerminalViewer.tsx`
  (xterm + fit + replay), the canvas `terminal` tab type, `components/tool/
  TerminalTaskCard.tsx` (chat card → opens the tab), and
  `components/chat/LiveSessionsHeader.tsx` (ambient strip docked to the composer's
  top edge to perceive, reveal, and stop live AI sessions; sourced via the
  `hooks/useLiveSessions.ts` seam).

## 8) Lifecycle hard rules

1. **TerminalContext is process-scoped** and decoupled from SDK sessions. Never
   tie a pty's lifetime to a conversation/session rebuild.
2. **Global singleton** backs the main chat and forwards to the event bus;
   **scoped contexts** (automation) are isolated and do NOT forward to the bus.
3. Max sessions per context is capped; app shutdown kills all via
   `cleanupAITerminal()` (wired in `bootstrap/extended.ts`).
4. `terminal_write` is arbitrary command execution — same trust model as the
   Bash tool. The tool description constrains reading during credential entry.

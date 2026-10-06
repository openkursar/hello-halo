# AI Terminal — A Persistent Terminal Shared with the User

Last updated: 2026-10-06

Read this when the user asks what the AI Terminal (AI 终端) is, how to turn it on, how to log in to a
server and hand over to the AI, why a terminal kept running after its tab closed, or why there is
no terminal on their machine. This topic has no companion documents.

## 1. What it is

- **Real interactive pty sessions** that the agent drives through the `terminal_*` tools
  (`terminal_create`, `terminal_write`, `terminal_read`, `terminal_search`, `terminal_wait_for`,
  `terminal_list`, `terminal_kill`) and that the user sees live in the canvas and can type into —
  full human takeover; Ctrl+C always reaches the pty (`src/main/services/ai-terminal/DESIGN.md`).
- **Sessions live at process scope**, not conversation scope: they survive model switches,
  conversation rebuilds and closing the canvas, and all end when Halo quits.
- **Up to 12 live sessions** at once (`MAX_SESSIONS`, `src/worker/pty-host/index.ts`).
- **Space-scoped for the agent:** the tools only see terminals of the current space.
- **Platforms:** macOS and Windows. Linux builds do not include it (`isTerminalAvailable()`), so
  on Linux the feature is absent everywhere — do not walk a Linux user through enabling it.
- **Shell:** macOS uses the user's login shell (`$SHELL`); Windows uses PowerShell on purpose, so
  `ssh` resolves to Windows' built-in OpenSSH (`shell.ts`, DESIGN §4).

## 2. Turning it on

- **Let the agent use terminals:** Halo 3.0 — the composer's **+** menu → **AI Terminal**
  (AI 终端). Halo 2.1.x — the composer's **Tools** (工具) menu → **Terminal** (终端). It is a
  per-conversation toolset; if the tools are missing in this conversation, ask the user to turn it
  on (`request_toolset`) instead of claiming you cannot use terminals at all.
- **The user opens one first:** Halo 3.0 — **More** (更多) at the top → **Open terminal**
  (打开终端), which opens a terminal in the current space's directory. Halo 2.1.x — the **Open
  terminal** button in the file panel on the right. A terminal the user opened can then be driven
  by the agent once the toolset is on.
- **Digital humans** need the **AI Terminal** capability allowed in their settings.

## 3. The SSH hand-over pattern

1. Ask the user to log in themselves (in a terminal you created, or one they opened): `ssh
   user@host`, then they type the password or passphrase.
2. **Do not read the screen while credentials are being typed**; wait for a shell prompt with
   `terminal_wait_for`, then take over.
3. Several machines → one terminal each.

Passwords typed by the user go to the terminal, never into the conversation. Do not ask the user to
paste secrets into chat so you can type them.

## 4. How it looks in the app

- When the agent uses a terminal, a card appears in the conversation with **Open terminal**, which
  opens the terminal tab in the canvas.
- Running sessions the agent touched show in the strip above the composer, where the user can open
  or **Stop** (停止) them.
- **Closing a tab is not killing the process.** Closing the tab of a running terminal the AI has
  used asks: **Keep running in background** (保持在后台运行) or **Close completely** (完全关闭).
  A running terminal the user opened and the AI never touched ends with its tab.
- Through remote access the user can view and type into terminals as well.

## 5. Do not ask / do not assume

- **Do not assume a terminal survives an app restart** — it does not.
- **Do not treat it as sandboxed.** `terminal_write` runs arbitrary commands with the same trust as
  the shell tool; on important servers, say what you are about to run.
- **Do not open a new terminal per command.** Reuse the session; the session limit is 12.
- **Do not offer the AI Terminal on Linux**, and do not tell Windows users to switch it to Git Bash
  for SSH — PowerShell is the deliberate default for that reason.

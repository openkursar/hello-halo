---
name: halo-cli-tools
description: Use the command-line tools Halo installed for this session (company or partner CLIs). Use when a task may be done with an installed CLI, when the user names a CLI tool, or when the environment variable HALO_CLI_TOOLS_BIN is set and you need to know which commands it provides.
version: 1.0.0
author: Halo
---

# Installed CLI Tools

Halo can install command-line tools for your sessions. When it has, the
environment variable `HALO_CLI_TOOLS_BIN` names their launcher directory, and
that directory is already on PATH.

## Find what is installed

Read `TOOLS.md` next to the launcher directory before the first use:

- bash/zsh: `cat "$HALO_CLI_TOOLS_BIN/../TOOLS.md"`
- PowerShell: `Get-Content "$env:HALO_CLI_TOOLS_BIN\..\TOOLS.md"`

It lists each command, its tool and version, whether it writes data, how it
signs in, and the path of the tool's own guide. Read that guide before using a
tool for the first time in a task.

If `HALO_CLI_TOOLS_BIN` is not set, no tool is installed for this session.

## Rules

- Run the commands exactly as listed. A command shown as `halo-<name>` means
  another `<name>` already exists on this computer; plain `<name>` runs that
  other program.
- Never install, update or remove these tools yourself (no `npm install`,
  no downloads). Ask the user to install a missing tool through Halo.
- Never put passwords, tokens or other secrets in command arguments, files or
  the conversation. Follow the tool's own sign-in flow.
- When a tool that writes data fails or times out with an unknown outcome,
  check the result first; do not simply run the write again.

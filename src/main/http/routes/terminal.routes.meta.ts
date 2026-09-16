import type { RouteModuleMeta } from './_meta-types'

/**
 * These sessions are the shared pty the user watches and can type into, so the
 * ai-terminal toolset owns them: it detects when a command settles, separates
 * the live screen from scrollback, and searches history. Driving the raw
 * endpoints means writing bytes and never knowing when to read them back.
 */
const useTerminalToolset = {
  expose: 'wrapped',
  group: 'terminal',
  useInstead: 'the ai-terminal toolset',
  bypassCost:
    'command-completion detection, reading the live screen separately from history, and history search — raw input returns before the command has produced anything',
  unavailable:
    'If the ai-terminal tools are not in your toolset, you cannot drive this terminal at all — calling request_toolset only highlights the switch in the user\'s "Tools" menu and takes effect from their next message, so tell them to turn ai-terminal on there. Meanwhile use your own Bash tool for work that does not need the shared terminal.',
} as const

export const MODULE: RouteModuleMeta = {
  file: 'terminal',
  routes: {
    'GET /api/terminal/list': {
      ...useTerminalToolset,
      summary: 'List open terminal sessions',
    },
    'POST /api/terminal/create': {
      ...useTerminalToolset,
      summary: 'Open a terminal session',
    },
    'POST /api/terminal/input': {
      ...useTerminalToolset,
      summary: 'Send keystrokes to a terminal session',
    },
    'POST /api/terminal/resize': {
      ...useTerminalToolset,
      summary: 'Resize a terminal session',
    },
    'POST /api/terminal/kill': {
      ...useTerminalToolset,
      summary: 'Close a terminal session',
    },
    'POST /api/terminal/replay': {
      ...useTerminalToolset,
      summary: 'Read back a terminal session buffer',
    },
  },
}

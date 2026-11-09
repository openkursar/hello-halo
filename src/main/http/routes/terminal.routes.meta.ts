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
    'Use the ai-terminal tools when available. If they are absent, consult the available service directory and ToolSearch if offered. Request user enablement only when request_toolset explicitly lists ai-terminal as requiring it. Otherwise shared-terminal access is unavailable; use Bash for work that does not need the shared terminal.',
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

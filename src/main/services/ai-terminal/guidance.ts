export const AI_TERMINAL_DESCRIPTION = 'Use a user-visible interactive terminal for SSH, REPLs and other stateful shell work; use the command tool for one-off commands.'

export const AI_TERMINAL_INSTRUCTIONS = `
Interactive terminals are shared with the user, who can type or take over; Ctrl+C remains theirs. Use the command-execution tool for one-off commands and terminal_create for SSH, REPLs or other stateful work.
For SSH, let the user enter passwords or passphrases. Do not read the screen during credential entry; use terminal_wait_for on a success prompt before continuing. After user input, read mode="screen" to resynchronize.
terminal_write submits commands by default: omit a trailing newline; use submit=false for raw control keys. If it reports "awaiting continuation", close the unfinished quote/here-doc or cancel with Ctrl+C before issuing another command. Quiet output is not proof of completion; inspect the reported state and verify the exit status when needed. Prefer terminal_wait_for to repeated reads, mode="screen" for interactive state, and terminal_search to scan history. Follow the individual tool definitions for exact arguments and key encoding.
`.trim()

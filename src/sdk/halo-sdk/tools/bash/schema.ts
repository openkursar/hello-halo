export const BASH_TOOL_NAME = 'Bash';

export const BASH_TOOL_DESCRIPTION = `Run a shell command and receive its exit status and captured output.

Commands share the session's working directory and exported environment variables. Shell functions, aliases and background jobs are not carried between calls. Quote paths and arguments for the shell you are using, and distinguish data from executable syntax.

Prefer available file tools for reading, searching and editing: they track file access and constrain returned content. Use Bash for programs, builds, tests and operations those tools do not cover, or when the user specifically requests a shell command. A permission refusal is a boundary, not an invitation to try the same action through another tool.

The default foreground timeout is 120000 milliseconds. An explicit timeout sets the execution deadline in either mode, capped at 600000 milliseconds. Choose run_in_background for session-owned work whose result is not needed immediately. Without an explicit timeout, background work runs until it exits or the session closes or is interrupted. The response supplies a task ID, output path and deadline. TaskOutput waits for completion and TaskStop cancels the task; Read can inspect its output file. A TaskOutput wait timeout does not stop the command or change its execution deadline. If the final answer depends on that work, collect its completed result before finishing. Completion notices appear at the next active turn.

Background tasks are owned by this session, not persistent service deployments. Session close or interruption stops them, and nonpersistent sessions remove their output files on close. When the user requires a service to outlive this session, use an appropriate service manager or independent process lifecycle and verify that requirement separately.

Independent observations may run together. A command that depends on another command's effects must wait for it and check the outcome. Diagnose a failure before repeating it. Avoid repeatedly checking background tasks that already send completion notices; if the next step needs a result, wait through TaskOutput. Use an external service's own wait or status operation for work it owns.

Repository changes still follow the user's scope and local workflow. Do not turn a request to edit code into permission to commit, publish, discard work or rewrite history. Preserve hooks, signing and repository configuration unless changing them is explicitly part of the authorized task. Use an available matching skill for a specialized commit or review-request workflow.`;

export const BASH_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'Shell program or command line to run in the session working directory.',
    },
    description: {
      type: 'string',
      description: 'A short explanation of the command and its intended effect, including any changes it makes.',
    },
    timeout: {
      type: 'number',
      description: 'Execution deadline in milliseconds, capped at 600000. Foreground commands default to 120000; background commands have no deadline unless this is supplied.',
    },
    run_in_background: {
      type: 'boolean',
      description: 'Return a session-owned task reference immediately. Retrieve completion with TaskOutput or inspect output with Read. Without timeout, it runs until completion, cancellation or session close.',
    },
  },
  required: ['command'],
} as const;

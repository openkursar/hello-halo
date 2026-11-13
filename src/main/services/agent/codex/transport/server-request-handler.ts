/**
 * Bridge between Codex app-server's bidirectional JSON-RPC requests and
 * Halo's existing user-interaction surfaces.
 *
 * Codex issues several kinds of server requests during a turn:
 *
 *   item/commandExecution/requestApproval   shell command approval
 *   item/fileChange/requestApproval         file write/patch approval
 *   item/permissions/requestApproval        sandbox/policy upgrade
 *   item/tool/requestUserInput              tool elicitation
 *   mcpServer/elicitation/request           MCP elicitation passthrough
 *   item/tool/call                          dynamic-tool dispatch (we don't register any)
 *   account/chatgptAuthTokens/refresh       only fires for ChatGPT auth (we use API keys)
 *   applyPatchApproval / execCommandApproval  legacy V1 names
 *
 * Approval-style requests are auto-approved here because Halo runs Codex in
 * "bypass permissions" mode by default (consistent with the CC engine
 * behavior). The user explicitly opted into Codex; we don't surface a
 * second consent prompt for every shell command. This matches the
 * user-confirmed answer (approvalPolicy='never' + elicitation→AskUserQuestion).
 *
 * Elicitation-style requests (`item/tool/requestUserInput` and
 * `mcpServer/elicitation/request`) are bridged to Halo's existing
 * `agent:ask-question` UI flow via the `askQuestion` callback the session
 * adapter injects. That keeps the user experience identical to CC's
 * AskUserQuestion tool — the renderer's `AskUserQuestionCard` does not
 * need engine-specific handling.
 *
 * Anything else is rejected with a not-implemented error so the server
 * surfaces a clear failure rather than a silent timeout.
 */

import {
  ServerRequestMethods,
  type ApprovalDecisionResponse,
  type CommandExecutionRequestApprovalParams,
  type FileChangeRequestApprovalParams,
  type McpServerElicitationRequestParams,
  type PermissionsRequestApprovalParams,
  type ToolRequestUserInputParams,
} from '../types/codex-protocol'
import type { JsonRpcClient, ServerRequestContext } from './jsonrpc-client'

/**
 * A question payload compatible with Halo's `agent:ask-question` event.
 * Mirrors the shape the renderer's `AskUserQuestionCard` consumes.
 */
export interface AskQuestionPayload {
  questions: Array<{
    question: string
    header: string
    multiSelect: boolean
    options: Array<{ label: string; description: string }>
  }>
}

/** Result of an ask — keys are the full question text. */
export type AskQuestionAnswers = Record<string, string>

export interface ServerRequestHandlerDeps {
  /** Conversation context — used for logging / future auditing. */
  conversationId: string
  /**
   * Bridge to Halo's existing AskUserQuestion UI. Must:
   *   - emit an `agent:ask-question` event for the renderer
   *   - resolve with user's answers when the user submits
   *   - reject if the user cancels / interrupts / closes the conversation
   */
  askQuestion: (payload: AskQuestionPayload) => Promise<AskQuestionAnswers>
}

/**
 * Register all server-request handlers on the supplied JSON-RPC client.
 * Returns a disposer that removes every registration in one call (used on
 * session close).
 */
export function registerServerRequestHandlers(
  client: JsonRpcClient,
  deps: ServerRequestHandlerDeps
): () => void {
  const disposers: Array<() => void> = []

  // ==========================================================================
  // Approval flows — auto-approve under our bypass-permissions policy.
  // ==========================================================================

  const autoApprove = (label: string) => async (ctx: ServerRequestContext): Promise<ApprovalDecisionResponse> => {
    if (process.env.HALO_CODEX_LOG_APPROVALS) {
      console.log(`[Codex][approval] auto-approved ${label} for ${deps.conversationId}`, ctx.params)
    }
    return { decision: 'approved' }
  }

  disposers.push(
    client.onServerRequest(
      ServerRequestMethods.CommandExecutionRequestApproval,
      async (ctx) => {
        const params = ctx.params as CommandExecutionRequestApprovalParams | undefined
        return autoApprove(`exec "${params?.command ?? ''}"`)(ctx)
      },
    ),
    client.onServerRequest(
      ServerRequestMethods.FileChangeRequestApproval,
      async (ctx) => {
        const params = ctx.params as FileChangeRequestApprovalParams | undefined
        return autoApprove(`file-change reason="${params?.reason ?? ''}"`)(ctx)
      },
    ),
    client.onServerRequest(
      ServerRequestMethods.PermissionsRequestApproval,
      async (ctx) => {
        const params = ctx.params as PermissionsRequestApprovalParams | undefined
        return autoApprove(`permissions reason="${params?.reason ?? ''}"`)(ctx)
      },
    ),
    // Legacy V1 names — same flow.
    client.onServerRequest(ServerRequestMethods.ApplyPatchApproval, autoApprove('applyPatch (v1)')),
    client.onServerRequest(ServerRequestMethods.ExecCommandApproval, autoApprove('execCommand (v1)')),
  )

  // ==========================================================================
  // Elicitation flows — bridge to AskUserQuestion UI.
  // ==========================================================================

  disposers.push(
    client.onServerRequest(
      ServerRequestMethods.ToolRequestUserInput,
      async (ctx) => {
        const params = ctx.params as ToolRequestUserInputParams | undefined
        const payload = elicitationToAskQuestion(params)
        const answers = await deps.askQuestion(payload)
        const question = payload.questions[0].question
        if (typeof answers[question] !== 'string') {
          console.warn('[Codex][elicitation] Tool input answer missing; returning an empty value', {
            conversationId: deps.conversationId,
          })
        }
        return normalizeElicitationAnswers(answers, question, params)
      },
    ),
    client.onServerRequest(
      ServerRequestMethods.McpServerElicitationRequest,
      async (ctx) => {
        const params = ctx.params as McpServerElicitationRequestParams | undefined
        const payload: AskQuestionPayload = {
          questions: [{
            header: 'MCP request',
            question: typeof params?.message === 'string' ? params.message : 'The MCP server is requesting input.',
            multiSelect: false,
            options: [
              { label: 'Approve', description: 'Allow the MCP server to proceed.' },
              { label: 'Deny', description: 'Reject the request.' },
            ],
          }],
        }
        const answers = await deps.askQuestion(payload)
        const question = payload.questions[0].question
        if (typeof answers[question] !== 'string') {
          console.warn('[Codex][elicitation] MCP answer missing; rejecting the request', {
            conversationId: deps.conversationId,
          })
        }
        const decision = (answers[question] || '').toLowerCase().startsWith('approve')
        return { action: decision ? 'accept' : 'reject' }
      },
    ),
  )

  // ==========================================================================
  // Things we explicitly do not implement.
  // ==========================================================================

  disposers.push(
    client.onServerRequest(
      ServerRequestMethods.ItemToolCall,
      async () => {
        const err = new Error('Halo does not register dynamic tools; rejecting item/tool/call')
        ;(err as any).code = -32601
        throw err
      },
    ),
    client.onServerRequest(
      ServerRequestMethods.ChatgptAuthTokensRefresh,
      async () => {
        const err = new Error('Halo uses API-key auth; chatgpt token refresh is not supported')
        ;(err as any).code = -32601
        throw err
      },
    ),
  )

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* best-effort */ }
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function elicitationToAskQuestion(params: ToolRequestUserInputParams | undefined): AskQuestionPayload {
  const text = params?.question ?? params?.prompt ?? 'The agent is requesting your input.'
  const options = Array.isArray(params?.options) && params!.options!.length > 0
    ? params!.options!.map((opt) => ({
        label: opt.label || opt.value,
        description: '',
      }))
    : [
        { label: 'Continue', description: 'Proceed with the request.' },
        { label: 'Cancel', description: 'Abort this elicitation.' },
      ]
  return {
    questions: [{
      header: 'Tool input',
      question: text,
      multiSelect: false,
      options,
    }],
  }
}

function normalizeElicitationAnswers(
  answers: AskQuestionAnswers,
  question: string,
  params: ToolRequestUserInputParams | undefined,
): unknown {
  const choice = answers[question]
  // If the original options were enumerated, return the chosen value with
  // the same label the server provided. Otherwise return the free-text choice.
  if (Array.isArray(params?.options) && params!.options!.length > 0) {
    const matched = params!.options!.find((o) => (o.label || o.value) === choice)
    return { value: matched?.value ?? choice ?? '' }
  }
  return { value: choice ?? '' }
}

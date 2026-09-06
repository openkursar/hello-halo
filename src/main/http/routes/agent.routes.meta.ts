import type { RouteModuleMeta } from './_meta-types'

export const MODULE: RouteModuleMeta = {
  file: 'agent',
  routes: {
    // Starting a brand-new Halo turn from the self-API has no depth limit:
    // the agent that just called this can be messaged again by the turn it
    // started, and so on, with nothing to stop it. Ruled internal — see
    // conversation.withheld in _meta-groups.ts, which tells the AI this
    // exists but is not something it can do on the user's behalf.
    'POST /api/agent/message': {
      expose: 'internal',
    },
    'POST /api/agent/stop': {
      expose: 'ai',
      group: 'conversation',
      summary: 'Stop whatever Halo is currently doing in a conversation',
      body: '{"conversationId": "<conversationId — a uuid from GET /api/spaces/$HALO_SPACE_ID/conversations>"}',
      returns: '{success:true}',
      notes: 'conversationId is optional — omit the field (or send {}) to stop everything Halo is doing',
    },
    // Not a confirmation-bypass risk like message/answer-question below —
    // these are dead code. agent.controller.ts:74-83: both functions are an
    // unconditional `return { success: true }`, doing nothing (the agent
    // always runs with permissionMode:'bypassPermissions', sdk-config.ts:863).
    // Exposing a call that always reports success while doing nothing is
    // worse than not exposing it: the AI would tell the user "approved" when
    // nothing happened.
    'POST /api/agent/approve': {
      expose: 'internal',
    },
    'POST /api/agent/reject': {
      expose: 'internal',
    },
    'GET /api/agent/sessions': {
      expose: 'ai',
      group: 'conversation',
      summary: 'List conversations Halo is currently working on',
      returns: '{success:true,data:string[]}  // array of conversationId, each one currently generating a reply',
    },
    'GET /api/agent/generating/:conversationId': {
      expose: 'ai',
      group: 'conversation',
      summary: 'Check whether Halo is still working on a reply in one conversation',
      returns: '{success:true,data:boolean}',
      notes: 'Pairs with POST /api/agent/stop — check this before deciding whether there is anything to stop',
    },
    // Reconnect/refresh recovery snapshot (thoughts, pendingQuestion) for the
    // chat UI to rebuild its view — not a general-purpose read.
    'GET /api/agent/session/:conversationId': {
      expose: 'internal',
    },
    // Answering a pending prompt on the user's behalf is a confirmation-bypass
    // risk, same family as message above but distinct: this one actually does
    // something (unlike approve/reject) — it would let the AI answer a
    // question Halo raised precisely because it needed a real human decision.
    // See conversation.withheld in _meta-groups.ts ("answering a pending
    // question on the user's behalf").
    'POST /api/agent/answer-question': {
      expose: 'internal',
    },
    // Diagnostic-only: starts a temporary SDK query against every configured
    // MCP server to test connectivity. Heavier than a simple read (spins up
    // a real query) and produces UI-facing telemetry (settings "Test
    // connections" button), not something an agent needs mid-task.
    'POST /api/agent/test-mcp': {
      expose: 'internal',
    },
    // Diagnostic-only: native handshake probe for one installed MCP-type app,
    // used by the MCP settings/status UI to refresh a single server's badge.
    'POST /api/agent/probe-mcp': {
      expose: 'internal',
    },
    // Reports this build's own execution capabilities/availability — describes
    // conditions the agent runs under, not something it acts on. Per explicit
    // product decision, kept off the manual with the toolset-broker routes below.
    'GET /api/agent/engine-capabilities': {
      expose: 'internal',
    },
    'GET /api/agent/engine-availability': {
      expose: 'internal',
    },
    // Toolset broker (on-demand MCP toolset open/close for THIS session) —
    // controls the agent's own available tools mid-run. Per explicit product
    // decision this whole family stays internal.
    'POST /api/agent/toolsets/list': {
      expose: 'internal',
    },
    'POST /api/agent/toolsets/open': {
      expose: 'internal',
    },
    'POST /api/agent/toolsets/close': {
      expose: 'internal',
    },
  },
}

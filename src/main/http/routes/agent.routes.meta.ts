import type { RouteModuleMeta } from './_meta-types'

export const MODULE: RouteModuleMeta = {
  file: 'agent',
  routes: {
    'POST /api/agent/message': {
      expose: 'ai',
      group: 'conversation',
      summary: 'Start a new Halo turn in a conversation',
      body: '{"spaceId": "<spaceId — a uuid from GET /api/spaces>", "conversationId": "<conversationId — a uuid from GET /api/spaces/$HALO_SPACE_ID/conversations>", "message": "Summarise the activity log"}',
      returns: '{success:true}  // no data — the turn runs after the call returns',
      notes: [
        'This really starts Halo working, and the reply is produced after the response comes back. success:true means accepted, not answered.',
        'Poll GET /api/agent/generating/<conversationId> for progress — back off (2s, then double), do not tight-loop.',
        'Optional body fields: resumeSessionId, thinkingEnabled (boolean), knowledgeBaseId, images (base64 attachments).',
        'Create the conversation you target with POST /api/spaces/$HALO_SPACE_ID/conversations. Nothing tells you which id in GET /api/agent/sessions is your own, so picking one from there risks talking to yourself, and nothing stops the turn you start from messaging you back.',
        'A turn you start can stop to ask a question, and answering it is not open to you — the user answers it in the Halo app. Do not start one you are unwilling to leave pending.',
      ].join('\n'),
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
    // Halo raised this question inline, mid-turn, to the person already typing
    // in that conversation; answering it from here substitutes for a human who
    // is by definition present. Its sibling POST /api/apps/:appId/escalation/
    // :entryId/respond IS exposed and looks identical, but a digital human
    // escalates from an unattended run precisely because nobody is there —
    // out-of-band answering is the mechanism working, not a bypass of it.
    // See conversation.withheld in _meta-groups.ts.
    'POST /api/agent/answer-question': {
      expose: 'internal',
    },
    'POST /api/agent/test-mcp': {
      expose: 'ai',
      group: 'settings',
      summary: 'Test every configured MCP server connection',
      returns:
        '{success:true,servers:[{name,status:"connected"|"failed"|"needs-auth"|"pending",tools?:string[],serverInfo?:{name,version},error?}]}  // servers, not data',
      notes: [
        'Starts a real query against every configured server, so it is slow and it costs tokens. Say so before running it.',
        '"Test already in progress" = another test is running; wait and retry.',
        '"No MCP servers configured" comes back with success:true and nothing to report.',
      ].join('\n'),
    },
    'POST /api/agent/probe-mcp': {
      expose: 'ai',
      group: 'settings',
      summary: 'Probe one installed MCP server for connectivity and tools',
      body: '{"appId": "<appId — a uuid from GET /api/apps>"}',
      returns:
        '{success:true,result:{status:"connected"|"failed"|"needs-auth",tools?:string[],serverInfo?:{name,version},latencyMs:number}}  // result, not data',
      notes: [
        '400 if appId is missing.',
        '"App is not an MCP server" = that app exists but is not an MCP-type app; probe only applies to those.',
      ].join('\n'),
    },
    'GET /api/agent/engine-capabilities': {
      expose: 'ai',
      group: 'settings',
      summary: 'Read what the running agent engine can do',
      returns:
        '{success:true,data:{engineId,displayName,streaming:{text,reasoning,toolInput,toolOutput},tools:{native,synthetic,shellHeuristics},todo:{states,hasActiveForm},subAgent:{...}}}',
      notes: 'Describes the conditions you run under — which streaming and tool features are native versus emulated. Always answers; falls back to the active engine defaults.',
    },
    'GET /api/agent/engine-availability': {
      expose: 'ai',
      group: 'settings',
      summary: 'List which agent engines are installed and which one is active',
      returns:
        '{success:true,data:{engines:[{engineId:"anthropic"|"halo"|"codex",available:boolean,version:string,fingerprint:string}],activeEngine,degradedFrom}}',
      notes: 'degradedFrom is non-null when Halo fell back off the engine the user picked — that is the thing worth telling them about.',
    },
    'POST /api/agent/toolsets/list': {
      expose: 'ai',
      group: 'conversation',
      summary: 'List the on-demand toolsets available to a conversation',
      body: '{"spaceId": "<spaceId — a uuid from GET /api/spaces>", "conversationId": "<conversationId — a uuid from GET /api/spaces/$HALO_SPACE_ID/conversations>"}',
      returns: '{success:true,data:[{id:string,displayName:string,summary:string,open:boolean}]}',
      notes: [
        'Read-only. Opening and closing are the user\'s to do — ask with the request_toolset tool, which highlights the switch for them.',
        'For your own session you need its conversationId; GET /api/agent/sessions lists the ones generating right now, which includes yours.',
      ].join('\n'),
    },
    // Both call the *ByUser* opener, so the change is recorded as the user's
    // own and reaches rememberLastToolsets, which
    // persists it as config.lastToolsets — the seed every future conversation
    // starts from. An agent flipping its own tools would silently rewrite a
    // preference the user set by hand, across conversations it will never see.
    // toolsets/DESIGN.md states the rule this keeps: the AI asks via
    // request_toolset and the user flips the switch.
    'POST /api/agent/toolsets/open': {
      expose: 'internal',
    },
    'POST /api/agent/toolsets/close': {
      expose: 'internal',
    },
  },
}

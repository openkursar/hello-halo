import type { RouteModuleMeta } from './_meta-types'

export const MODULE: RouteModuleMeta = {
  file: 'apps',
  routes: {
    // ── Listing / reading ─────────────────────────────────────────────
    // Full InstalledApp includes userConfig (raw config_schema values — no
    // 'password' input type exists, so credential fields are plain strings)
    // and, for mcp-type apps, spec.mcp_server.env/headers (plaintext process
    // env and auth headers). None of it is redacted in the read path
    // (apps/manager/service.ts:936-942). Per §5.6, the loopback self-API
    // transport applies a blanket leaf-value redaction to every JSON
    // response, so this is handled at the transport layer, not here — keys
    // survive redaction (e.g. userConfig:{"api_key":"[redacted]"}), so the
    // shape below still shows real field names.
    'GET /api/apps': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'List digital humans (and other installed apps) in a space',
      returns: '{success:true,data:[{id,specId,spaceId,spec,status,userConfig,userOverrides,permissions,installedAt,lastRunAt?,lastRunOutcome?,errorMessage?}]}  — userConfig/spec.mcp_server.env/headers values are redacted to "[redacted]", keys are preserved',
      notes: 'Optional query: ?spaceId=, ?status=. Without ?status, uninstalled apps are excluded by default.',
    },
    'GET /api/apps/:appId': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Get one installed digital human (or other app) by id',
      returns: '{success:true,data:InstalledApp|null}  — same shape as GET /api/apps entries, redacted the same way',
    },
    // Exports the raw spec as a YAML string, not JSON — the transport-level
    // redaction in §5.6 only rewrites JSON response bodies, so it cannot
    // reach into this one. mcp_server.env/headers would come out in plain
    // text.
    'GET /api/apps/:appId/export-spec': {
      expose: 'internal',
    },

    'GET /api/apps/:appId/available-skills': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'List skills this digital human can load (global + space-local)',
      returns: '{success:true,data:[{name,description,scope:"global"|"space",dirName,path}]}',
      notes: '404-equivalent = {success:false,error:"App not found or has no space"} — the app must have a spaceId',
    },
    // Live preview of the identifier a skill name would install under (form
    // helper for a name field, e.g. "My Skill" -> "my-skill"). No side effect.
    'GET /api/skills/command-name': {
      expose: 'internal',
    },

    // ── Install / uninstall / lifecycle ───────────────────────────────
    // Generic installer: accepts any AppSpec (automation/mcp/skill) and only
    // auto-activates automation apps. It shares manager.install() (and thus
    // the same Zod validation) with create_automation_app, but skips: the
    // authoring-guide gate (no guideConsulted check), forcing type='automation',
    // and installRequiredSkills()-with-rollback (declared skill dependencies
    // are never installed, and nothing is rolled back if they would have
    // failed). For creating a digital human, create_automation_app is the
    // only door; this endpoint remains the only way to install a raw
    // mcp/skill AppSpec object outside the Store, so blocking it entirely
    // has a real cost — flagged to Lead alongside the secret-leak question.
    'POST /api/apps/install': {
      expose: 'wrapped',
      group: 'digital-human',
      summary: 'Install a digital human (or other app type) from its full definition (spec) object',
      useInstead: 'create_automation_app',
      bypassCost: 'the authoring-guide gate, forcing type to "automation", and automatic required-skill install with rollback on failure',
    },
    'DELETE /api/apps/:appId': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Soft-delete (uninstall) a digital human; recoverable via reinstall',
      returns: '{success:true}',
      notes: 'No body. There is a ?purge=true query param but it is currently a no-op (ignored by the handler) — it does not delete on-disk data. This is reversible (see POST /:appId/reinstall). For permanent, unrecoverable deletion use delete_automation_app instead.',
      impact: 'reversible',
      narrowerAlternative: 'POST /api/apps/:appId/pause',
    },
    'POST /api/apps/:appId/reinstall': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Reinstall a previously soft-deleted (uninstalled) digital human',
      returns: '{success:true,data:{activationWarning?:string}} — activationWarning is set (non-fatal) if restarting it failed',
      notes: '404-equivalent: manager.reinstall throws if appId was never installed or is not currently uninstalled',
      impact: 'reversible',
    },
    // delete_automation_app does deactivate -> uninstall -> deleteApp in one
    // call; manager.deleteApp() itself requires the app to already be in
    // 'uninstalled' status (soft-deleted first) and refuses to delete
    // protected built-in apps. Calling this route directly on an active app
    // fails outright rather than corrupting state, but you must sequence
    // DELETE /:appId (soft) yourself first — the wrapper does both in order.
    'DELETE /api/apps/:appId/permanent': {
      expose: 'wrapped',
      group: 'digital-human',
      summary: 'Permanently delete a digital human and all its data',
      useInstead: 'delete_automation_app',
      bypassCost: 'the deactivate -> soft-uninstall -> hard-delete sequencing; calling this alone on an app that is not already uninstalled fails. If you only want it gone from view but recoverable, DELETE /api/apps/:appId (soft, no wrapper needed) is the narrower operation',
    },
    'POST /api/apps/:appId/pause': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Pause a digital human (stops scheduling)',
      returns: '{success:true}',
      notes: '404-equivalent: manager.pause throws for an unknown appId',
      impact: 'reversible',
    },
    'POST /api/apps/:appId/resume': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Resume a paused digital human',
      returns: '{success:true}',
      notes: '404-equivalent: manager.resume throws for an unknown appId',
      impact: 'reversible',
    },
    // trigger_automation_app translates a per-app concurrency conflict into a
    // friendly non-error result the AI can relay ("already running, wait").
    // A raw call surfaces the same conflict as {success:false,error:"..."}
    // from ConcurrencyLimitError's message instead.
    'POST /api/apps/:appId/trigger': {
      expose: 'wrapped',
      group: 'digital-human',
      summary: 'Manually trigger a digital human to run immediately',
      useInstead: 'trigger_automation_app',
      bypassCost: 'the friendly "already running or queued, please wait" message — a raw call surfaces this as a plain error instead',
    },
    'GET /api/apps/:appId/activity': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Get the activity/run-history entries for a digital human',
      returns: '{success:true,data:[{id,appId,runId,type:"run_complete"|"run_skipped"|"run_error"|"milestone"|"escalation"|"output",ts,content,userResponse?}]}',
      notes: 'Query params: limit (max entries), before (only entries with ts older than this epoch ms)',
    },
    'POST /api/apps/:appId/escalation/:entryId/respond': {
      expose: 'ai',
      group: 'digital-human',
      summary: "Answer a digital human's pending question (it stopped to ask a human before continuing)",
      body: '{"choice": "approve", "text": "optional free-text explanation"}',
      returns: '{success:true}',
      notes: 'choice and text are both optional (send whichever the pending question asked for). Find the pending entryId via GET /:appId/activity (type:"escalation") or by app.status==="waiting_user". This is the human decision it was waiting for — answer with the user\'s actual input, never a guessed one, and there is no way to un-answer it afterward.',
      impact: 'irreversible',
    },
    'POST /api/apps/:appId/runs/:runId/continue': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Resume a run that stopped prematurely on an error',
      returns: '{success:true}',
      notes: 'Only valid for a run that ended in a premature-stop error, not any run. This re-opens the run with full tool permissions (bypassPermissions) and can take real-world action that Halo cannot undo.',
      impact: 'irreversible',
    },
    'POST /api/apps/:appId/runs/:runId/inject': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Inject a text message into a currently active run',
      body: '{"text": "your message here"}',
      returns: '{success:true}',
      notes: '400 if text is missing or the run is not currently active. This can resume/redirect a run with full tool permissions (bypassPermissions) and take real-world action that Halo cannot undo.',
      impact: 'irreversible',
    },
    // Raw internal session transcript for the UI's "View process" debug
    // panel — unshaped SDK message dump, not a curated response.
    'GET /api/apps/:appId/runs/:runId/session': {
      expose: 'internal',
    },
    'GET /api/apps/:appId/state': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Get real-time run state of a digital human (running/queued/idle/etc.)',
      returns: '{success:true,data:{status:"running"|"queued"|"idle"|"paused"|"waiting_user"|"error",nextRunAtMs?,runningRunId?,lastRunAtMs?,lastStatus?,lastError?,consecutiveErrors?,pendingEscalationId?}}',
      notes: 'More detail than the "status" field on GET /:appId alone (adds nextRunAtMs, queued/idle distinction)',
    },
    'POST /api/apps/:appId/clear-memory': {
      expose: 'ai',
      group: 'digital-human',
      summary: "Delete all of a digital human's memory files",
      returns: '{success:true,data:{filesRemoved:number}}',
      impact: 'irreversible',
    },
    'POST /api/apps/:appId/move-space': {
      expose: 'ai',
      group: ['digital-human', 'workspace'],
      summary: 'Move a digital human to a different space (or make it global)',
      body: '{"newSpaceId": "<spaceId — a uuid from GET /api/spaces>"}',
      returns: '{success:true,data:{activationWarning?:string}}',
      notes: 'Send {"newSpaceId": null} to make it global (available in every space). 404 if appId does not exist; 400 if newSpaceId is an empty string.',
      impact: 'reversible',
    },

    // ── Configuration ──────────────────────────────────────────────────
    'POST /api/apps/:appId/config': {
      expose: 'ai',
      group: 'digital-human',
      summary: "Replace a digital human's user configuration values",
      body: '{"someField": "value"}',
      returns: '{success:true}',
      notes: 'Body is the full config object, keyed by config_schema field id. This replaces userConfig wholesale; read current values first with GET /:appId to avoid dropping fields.',
      impact: 'reversible',
    },
    'PATCH /api/apps/:appId/overrides': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Merge-patch per-installation overrides (frequency, notification level, model)',
      body: '{"notificationLevel": "important"}',
      returns: '{success:true}',
      notes: 'Other fields you can set the same way: frequency (object keyed by subscriptionId), modelSourceId, modelId. JSON Merge Patch semantics: send null to clear a field (e.g. {"modelSourceId":null} to fall back to the global model).',
      impact: 'reversible',
    },
    'POST /api/apps/:appId/frequency': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Change how often a digital human runs, without editing its full definition (spec)',
      body: '{"subscriptionId": "<subscriptionId — read app.spec.subscriptions via GET /api/apps/<appId>>", "frequency": "30m"}',
      returns: '{success:true}',
      notes: 'frequency can also be a cron expression (e.g. "0 8 * * *"). subscriptionId must already exist — read app.spec.subscriptions via GET /:appId first. This sets a non-destructive override; it does not change the spec.',
      impact: 'reversible',
    },
    'POST /api/apps/:appId/permissions/grant': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Grant a named permission to a digital human',
      body: '{"permission": "ai-browser"}',
      returns: '{success:true}',
      impact: 'reversible',
    },
    'POST /api/apps/:appId/permissions/revoke': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Revoke a named permission from a digital human',
      body: '{"permission": "ai-browser"}',
      returns: '{success:true}',
      impact: 'reversible',
    },
    'POST /api/apps/:appId/upgrade-strategy': {
      expose: 'ai',
      group: ['digital-human', 'store'],
      summary: 'Set how a store-installed digital human handles version upgrades',
      body: '{"strategy": "auto"}',
      returns: '{success:true}',
      notes: 'strategy is one of "auto" (silent patch/minor, notify on major), "notify" (always notify), or "manual" (no automatic checks)',
      impact: 'reversible',
    },
    // update_automation_app edits the same spec via the same manager.updateSpec
    // call, but additionally: rejects any change to spec.type, and offers a
    // frequency shorthand that finds-or-creates the schedule subscription
    // instead of requiring the full subscriptions array. A raw patch that
    // changes subscriptions still hot-syncs the scheduler (same as the
    // wrapper), but you must write the complete subscriptions array yourself
    // and nothing stops you from changing spec.type.
    'PATCH /api/apps/:appId/spec': {
      expose: 'wrapped',
      group: 'digital-human',
      summary: "Edit part of a digital human's definition (spec) without replacing all of it",
      useInstead: 'update_automation_app',
      bypassCost: 'the guard against changing spec.type, and the "frequency" shorthand that rewrites the schedule subscription for you',
    },
    // Creates apps from a YAML spec via the same validation path as
    // create_automation_app (parseAndValidateAppSpec -> manager.install, both
    // ultimately call validateAppSpec), but — like POST /install — skips the
    // authoring-guide gate and installRequiredSkills()-with-rollback, and can
    // install any app type, always auto-activating regardless of type.
    'POST /api/apps/import-spec': {
      expose: 'wrapped',
      group: 'digital-human',
      summary: 'Install a digital human (or other app type) from a YAML definition (spec) string',
      useInstead: 'create_automation_app',
      bypassCost: 'the authoring-guide gate and automatic required-skill install with rollback on failure',
    },

    // ── App chat (talk to a digital human directly) ─────────────────────
    // Lead ruled this must be 'wrapped', not 'ai': apps.routes.ts:820 calls
    // sendAppChatMessage(request).catch(...) WITHOUT awaiting — genuinely
    // fire-and-forget, unlike /api/agent/message which awaits. Confirmed
    // `grep -cE "Semaphore|maxConcurrent|acquire" apps/runtime/app-chat.ts`
    // = 0: unlike automation runs (which share a global Semaphore(10) in
    // runtime/service.ts:93), chat has no throttle at all. A raw loop over
    // this route starts N full-tool-permission agent processes at once with
    // no pacing and no delivery confirmation.
    // Held 'internal' for now rather than 'wrapped', because 'wrapped'
    // requires a real useInstead MCP tool and none exists yet — grepped
    // conversation-mcp/index.ts and toolsets/registry.ts, zero hits for any
    // chat-with-a-digital-human tool or toolset. Pointing useInstead at a
    // tool that does not exist is a dead end, which is worse than internal.
    // Needs: Lead to confirm the name of the throttled wrapper tool once
    // built (or already planned with engineering), then flip this to
    // 'wrapped' with bypassCost: 'delivery confirmation and one-at-a-time
    // pacing — a raw POST returns before the digital human has read
    // anything, so a loop over it starts N agents at once with nothing
    // telling you they are running'.
    'POST /api/apps/:appId/chat/send': {
      expose: 'internal',
    },
    'POST /api/apps/:appId/chat/stop': {
      expose: 'ai',
      group: 'digital-human',
      summary: "Stop a digital human's in-progress chat reply",
      body: '{"conversationId": "<conversationId — a uuid from GET /api/spaces/$HALO_SPACE_ID/conversations>"}',
      returns: '{success:true}',
      notes: 'conversationId is optional — omit it (or send {}) to stop every session of this app',
    },
    'GET /api/apps/:appId/chat/status': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Check whether a digital human chat is currently generating a reply',
      returns: '{success:true,data:{isGenerating:boolean,conversationId}}',
      notes: 'Use this to poll a chat that is already running instead of guessing a wait time; back off (2s, then double), never poll tightly',
    },
    // Carries the raw tool call and result records of the digital human's own
    // run, the same content the sibling endpoints were closed for.
    'GET /api/apps/:appId/chat/messages': { expose: 'internal' },
    // Recovery-after-refresh snapshot (thoughts, pendingQuestion) for the
    // chat UI to rebuild its view on reconnect — not a general-purpose read.
    'GET /api/apps/:appId/chat/session-state': {
      expose: 'internal',
    },
    // Carries the raw tool call and result records of the digital human's own
    // run, the same content the sibling endpoints were closed for.
    'GET /api/apps/:appId/im-chat/messages': { expose: 'internal' },
    'POST /api/apps/:appId/chat/clear': {
      expose: 'ai',
      group: 'digital-human',
      summary: "Clear a digital human's chat history",
      body: '{"spaceId": "<spaceId — a uuid from GET /api/spaces>"}',
      returns: '{success:true}',
      notes: 'spaceId is required even though the app is already scoped to one. Optional conversationId clears one specific session instead of the default one.',
      impact: 'irreversible',
    },
    'POST /api/apps/:appId/chat/restart': {
      expose: 'ai',
      group: 'digital-human',
      summary: "Restart a digital human's chat agent process (reloads system prompt and config)",
      returns: '{success:true,data:{sessionsClosed:number}}',
      notes: 'Interrupts any in-flight turn. Conversation history is preserved.',
    },
    'POST /api/apps/:appId/im-chat/clear': {
      expose: 'ai',
      group: ['digital-human', 'channels'],
      summary: "Clear a digital human's chat history in a bound IM chat",
      body: '{"spaceId": "<spaceId — a uuid from GET /api/spaces>", "channel": "wecom", "chatType": "direct", "chatId": "<chatId — from GET /api/im-sessions>"}',
      returns: '{success:true}',
      notes: 'All four body fields are required, 400 otherwise. chatType is "direct" or "group".',
      impact: 'irreversible',
    },
    'POST /api/apps/:appId/im-chat/stop': {
      expose: 'ai',
      group: ['digital-human', 'channels'],
      summary: "Stop a digital human's in-progress reply in a bound IM chat (keeps history)",
      body: '{"channel": "wecom", "chatType": "direct", "chatId": "<chatId — from GET /api/im-sessions>"}',
      returns: '{success:true,data:{stopped:boolean}}',
      notes: 'chatType is "direct" or "group". Unlike im-chat/clear, this only aborts the current turn — the session and its history continue on the next inbound message.',
    },

    // ── Native multi-session lifecycle ──────────────────────────────────
    'POST /api/apps/:appId/sessions/create': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Start a new chat thread with a digital human',
      returns: '{success:true,data:{conversationId}}',
    },
    'POST /api/apps/:appId/sessions/fork': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Branch an existing chat thread into a new one, copying its history',
      body: '{"spaceId": "<spaceId — a uuid from GET /api/spaces>", "sourceConversationId": "<conversationId — a uuid from GET /api/spaces/$HALO_SPACE_ID/conversations>"}',
      returns: '{success:true,data:{conversationId}}',
      notes: '400 if spaceId or sourceConversationId is missing',
    },
    'POST /api/apps/:appId/sessions/delete': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Delete a chat thread with a digital human',
      body: '{"spaceId": "<spaceId — a uuid from GET /api/spaces>", "conversationId": "<conversationId — a uuid from GET /api/spaces/$HALO_SPACE_ID/conversations>"}',
      returns: '{success:true}',
      notes: '400 if spaceId or conversationId is missing',
      impact: 'irreversible',
    },
  },
}

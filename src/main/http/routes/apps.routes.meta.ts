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
      notes: [
        'Optional query: ?spaceId=, ?status=. Without ?status, uninstalled apps are excluded by default.',
        'Omitting ?spaceId= lists every space, which is what the Halo app itself shows — pass $HALO_SPACE_ID to narrow it to the one you are working in. Say which of the two you did, since "how many digital humans do I have" has a different answer for each.',
      ].join('\n'),
    },
    'GET /api/apps/:appId': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Get one installed digital human (or other app) by id',
      returns: '{success:true,data:InstalledApp|null}  — same shape as GET /api/apps entries, redacted the same way',
    },
    // The whole spec arrives as one opaque YAML string, and self-api/redact.ts
    // walks parsed JSON by key — it cannot see inside a serialized blob, so
    // mcp_server.env would leave verbatim. Keeping this route off the listener
    // is what lets that module keep promising every response is redacted, and
    // that promise is what the next serializing route will be written against.
    // The agent reads a spec off disk with its own tools instead.
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
    'GET /api/skills/command-name': {
      expose: 'ai',
      group: 'store',
      summary: 'Preview the slash-command name a skill title would install under',
      returns: '{success:true,data:string}  // e.g. "My Skill" -> "my-skill"',
      notes: 'Query: ?name=. A missing name returns an empty string, not a 400. Pure string transform — it does not check whether that name is already taken.',
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
    // This route answers only when the whole run is over (minutes), because the
    // UI it was built for shows live progress meanwhile. trigger_automation_app
    // instead returns at run start, and translates a per-app concurrency
    // conflict into a friendly non-error result the AI can relay
    // ("already running, wait") rather than {success:false,error:"..."}.
    'POST /api/apps/:appId/trigger': {
      expose: 'wrapped',
      group: 'digital-human',
      summary: 'Manually trigger a digital human to run immediately',
      useInstead: 'trigger_automation_app',
      bypassCost: 'this route blocks until the entire run finishes (minutes) — the tool returns as soon as the run starts; a raw call also surfaces "already running or queued" as a plain error instead of a friendly message',
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
    'GET /api/apps/:appId/runs/:runId/session': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Read what a run actually did, step by step',
      returns:
        '{success:true,data:[{id,role:"user"|"assistant",content,timestamp,thoughts?,thoughtsSummary?,images?}]}',
      notes: [
        'The transcript behind the "View process" panel — same shape as chat/messages, but for one automation run. It is the only way to see why a run did what it did rather than what it reported.',
        'Get the runId from GET /api/apps/<appId>/activity. Read this when a run went wrong; for what it concluded, its activity entry is shorter and enough.',
        '404 when the app or its space is gone. An empty array means that run left no transcript, not that the ids were wrong.',
      ].join('\n'),
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
    // Unlike automation runs, which share a global semaphore, app chat has no
    // throttle and the route does not await the send — so N calls start N
    // full-tool-permission agent processes at once. The pacing note below is
    // the only brake there is.
    'POST /api/apps/:appId/chat/send': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Send a message to a digital human and let it reply',
      body: '{"spaceId": "<spaceId — the app\'s own spaceId from GET /api/apps>", "message": "What did you find today?"}',
      returns: '{success:true,data:{conversationId}}  // accepted, not answered',
      notes: [
        'conversationId decides which thread it lands in. Omit it for the main thread. For a fresh thread, take the one POST /api/apps/<appId>/sessions/create hands back — it is already in the right form. To continue a thread the user created in Halo, build it from GET /api/im-sessions?appId=: join appId, channel, chatType and chatId as app-chat:<appId>:<channel>:<chatType>:<chatId>.',
        'Only the "local" and "http" channels are accepted; a thread whose source is "im" is refused, because this API must not put words into a real conversation with a person. 400 with the expected form when the id is malformed, and chatId must match [A-Za-z0-9_-].',
        'Returns before the digital human has read anything. Poll GET /api/apps/<appId>/chat/status until isGenerating is false, then read the reply with GET /api/apps/<appId>/chat/messages, passing the same conversationId.',
        'Nothing here paces you: each send starts another full agent process immediately. Send one at a time and wait for the reply — never loop over this route.',
        'Optional body fields: thinkingEnabled, images.',
      ].join('\n'),
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
    'GET /api/apps/:appId/chat/messages': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Read a digital human chat transcript',
      returns:
        '{success:true,data:[{id,role:"user"|"assistant",content,timestamp,thoughts?,thoughtsSummary?,images?}]}',
      notes: [
        'Reads the main thread by default. For any other thread pass ?conversationId=, the same key chat/send takes: app-chat:<appId>:<channel>:<chatType>:<chatId>, built from GET /api/im-sessions?appId=.',
        'Empty array when the thread has no history yet — a wrong conversationId looks identical, so list the threads first rather than guessing one.',
        'thoughts carries the raw tool calls and results of the run; skip it unless you are diagnosing what the digital human actually did.',
      ].join('\n'),
    },
    // Recovery-after-refresh snapshot (thoughts, pendingQuestion) for the
    // chat UI to rebuild its view on reconnect — not a general-purpose read.
    'GET /api/apps/:appId/chat/session-state': {
      expose: 'internal',
    },
    'GET /api/apps/:appId/im-chat/messages': {
      expose: 'ai',
      group: ['digital-human', 'channels'],
      summary: "Read a digital human's transcript in a bound IM chat",
      query: '?channel=wecom-bot&chatId=<chatId — from GET /api/im-sessions>&spaceId=<spaceId — the app\'s own spaceId from GET /api/apps>',
      returns:
        '{success:true,data:[{id,role:"user"|"assistant",content,timestamp,thoughts?,thoughtsSummary?,images?}]}',
      notes: [
        'All three query params are required, 400 otherwise. spaceId must be the app\'s own — a different but valid one is accepted and reads the wrong space. Optional ?chatType=group, defaults to direct.',
        'This is real correspondence with a person on the other end — read it only when the task needs it.',
      ].join('\n'),
    },
    'POST /api/apps/:appId/chat/clear': {
      expose: 'ai',
      group: 'digital-human',
      summary: "Clear a digital human's chat history",
      body: '{"spaceId": "<spaceId — the app\'s own spaceId from GET /api/apps>"}',
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
      body: '{"spaceId": "<spaceId — the app\'s own spaceId from GET /api/apps>", "channel": "wecom", "chatType": "direct", "chatId": "<chatId — from GET /api/im-sessions>"}',
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
      returns: '{success:true,data:{conversationId}}  // already in the form chat/send takes',
      notes: 'The shortest path to a thread of your own: the conversationId comes back ready to pass to chat/send and chat/messages, with nothing to assemble. Continuing a thread the user already made is the case that needs GET /api/im-sessions.',
    },
    'POST /api/apps/:appId/sessions/fork': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Branch an existing chat thread into a new one, copying its history',
      body: '{"spaceId": "<spaceId — the app\'s own spaceId from GET /api/apps>", "sourceConversationId": "<conversationId — a thread of THIS app, from POST /api/apps/<appId>/sessions/create or assembled from GET /api/im-sessions?appId=>"}',
      returns: '{success:true,data:{conversationId}}',
      notes: [
        'A digital human\'s threads are not the conversations in a space — do not take an id from GET /api/spaces/<spaceId>/conversations, it belongs to the user\'s chats with the Halo assistant and this route will not find it.',
        '400 if spaceId or sourceConversationId is missing.',
      ].join('\n'),
    },
    'POST /api/apps/:appId/sessions/delete': {
      expose: 'ai',
      group: 'digital-human',
      summary: 'Delete a chat thread with a digital human',
      body: '{"spaceId": "<spaceId — the app\'s own spaceId from GET /api/apps>", "conversationId": "<conversationId — a thread of THIS app, from GET /api/im-sessions?appId=>"}',
      returns: '{success:true}',
      notes: [
        'The id names one of this digital human\'s own threads, never a conversation from GET /api/spaces/<spaceId>/conversations.',
        '400 if spaceId or conversationId is missing.',
      ].join('\n'),
      impact: 'irreversible',
    },
  },
}

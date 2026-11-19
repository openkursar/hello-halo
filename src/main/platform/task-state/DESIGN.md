# Task state

`platform/task-state` persists conversation task-panel bookkeeping in the shared
application database. Its public index exposes initialization, the current
service and conversation-state contracts. The store owns synchronous SQL; the
service applies conversation eligibility and existence checks and broadcasts
refreshes to desktop and remote clients. It does not own conversation lifecycle
or digital-human placement, and imports neither Apps nor conversation services.
Bootstrap supplies the conversation-existence check and an optional
`resolveSpaceId(conversationId, reportedSpaceId)` callback. The callback runs only
for eligible `markUnseen` / `markRead` writes, before the existence check. It maps
digital-human reports to the manager's current placement, so stale renderer
completion reports cannot restore a former workspace. Ordinary conversations
retain their reported space. Initialization, listing and periodic cleanup do not
resolve placement; there is no new startup scan or background work.

## Workspace relocation

`TaskStateService.repointAppConversations(appId, spaceId)` synchronously updates
only `space_id` for the exact `app-chat:<appId>` identity and its colon-delimited
descendants. Other identities, titles, read timestamps, kept flags and update
timestamps remain unchanged. It returns the number of rows actually repointed;
repeating the same destination returns zero. The store uses literal prefix
comparison, so SQL wildcard characters in an identity cannot select another
person's rows.

The caller owns the move transaction on the shared application database. It
repoints these rows together with the person's placement before any old-space
cascade can remove task state. This method emits nothing: a rollback must not
announce a move that did not commit. After commit, the caller invokes
`notifyStateChanged()` once for the batch. No schema migration or startup scan
is needed for relocation.

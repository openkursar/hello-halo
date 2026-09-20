# Digital human and capability presentation

`AppsPage` owns navigation between the people directory, an installed person's
work/conversation/teams/settings, the existing team workbench, capability library,
and marketplace. Resource installation and the marketplace retain their existing
entry points. A system coordinator is hidden only when the team summary explicitly
identifies it; being a leader or having “Lead” in a name is not sufficient.

`PeopleDirectory` renders server-filtered bounded pages from `appListPeople`.
The directory projection contains no prompts, credentials, or full installed specs.
`people-directory.store` rejects out-of-order search responses; opening a person
hydrates only that full record with `appGet`. Team and capability consumers retain
their full inventory loading when entering those surfaces. It must not fetch every person's history. `people-view.store`
contains presentation preferences, recent navigation, per-surface scroll position,
and per-question drafts; drafts remain in memory and are not persisted with the
non-sensitive directory preferences. Runtime records stay in `apps.store` and are
authoritative backend projections. Pure source/visibility/record merge rules live
in `renderer/utils/people-model` and are shared by these projections.

`ActivityThread` reads pending decisions separately from paginated history so an
old unresolved request is not lost beyond the first history page. Automatic intake,
actual execution, and pending decisions are separate facts. The renderer does not
turn a pending team question into a global paused or waiting lifecycle. Answering
uses the server's canonical record; it does not invent a local success timestamp.
Continuation state is shown separately and retry continues the saved answer.
Task closure and expiry are never rendered as the owner's answer. Legacy closure
records carry unverified attribution and preserve their original text. Drafts are cleared only after successful reception, and
remain copyable when another surface has already resolved the same request.

`ActivitySource` trusts recorded source and legacy structured team context. Missing
source remains unknown. Team navigation carries the team, user-visible task,
member, and decision/activity anchor; internal subtask IDs are not task routes.
`TeamView` consumes that intent and preserves a return destination. Member profiles
are opened only for locally owned installed digital humans; remote members keep
the workbench's existing read-only boundary. Existing team conversation drafts and
scroll positions survive the profile round trip.

Desktop and HTTP clients use the same APIs. Layout is mobile-first; long source
names, selected answers, loading failures and unavailable teams remain readable
without hover. Errors are explicit and retain the last useful records and drafts.
No view claims that a connection failure, missing event or absent team implies a
closed request or a stalled execution.

`PeopleInbox` reads a bounded aggregate pending query, including team coordinators
that are intentionally absent from the people directory. Pending cursors use
ascending `(ts,id)`; history uses descending `(ts,id)`. Canonical activity events
update existing records across surfaces. Notification links first resolve the
record when possible, then navigate to its source and exact activity anchor.
Source snapshots retain historical team and task titles when a target is gone.

The authorized `read_digital_human_context` tool can return structured team
references. The tool-result renderer validates their shape and offers navigation
buttons; prose and arbitrary tool output never become application commands.

`PersonTeamWork` queries only the currently open person's memberships, six teams
at a time and at most three requests concurrently. It projects roster busy labels
and epoch IDs supplied by the team service, never infers a person's activity from
the team's total task count. Shadow activity is labelled last synced; unreachable
or failed queries remain unknown. Subscriptions and query-result application stop
when leaving the activity view.

The home Studio card uses a separate lightweight three-per-category summary. It
must not prepopulate the full installed-app cache before the directory opens.
`refreshApp` hydrates or updates a full selected record; list-change events refresh
the full inventory only after a consumer has actually requested that inventory.
The global request inbox receives page-local display names with its entries, so
opening it does not require loading every person's complete specification.

# openai-compat-router/balancing — group balancing policy

The judgment half of load-balancing groups. A group is an ordered list of
members (account × model). For one logical model request this module says
**which members to try, in what order, and what a failure means for the
member's future**. It never sends a request, reads a config or touches a
socket: time comes from an injected clock, evidence comes from the caller, and
everything it remembers is bounded and serializable. The router's group
dispatch (`../server/group-dispatch.ts`) owns the I/O and calls this module.

Public contract: `types.ts`. Entry: `createBalancer(options)` from `index.ts`.

## Principles

1. **Switching and resting are separate decisions.** Any attempt that produced
   nothing the caller received may move on to the next member. Whether the
   failed member should *sit out afterwards* depends on evidence. A third party
   we cannot classify costs at most one wasted attempt; it never locks anyone
   out.
2. **Never hard-block.** A rest is a guess. A resting member is tried again when
   its rest ends, and while no member is ready the soonest-returning one is
   tried at least once per `forcedProbeIntervalMs` even before its rest ends.
3. **One request, bounded cost.** A run hands out at most `maxAttempts`
   attempts, and never the same member twice in one run.
4. **Stay where the conversation is.** A session sticks to the member that last
   served it; recovery of a better member does not move it (each move loses the
   provider's prompt cache). Only a failure moves it.
5. **Bounded memory.** Health and session tables have caps and eviction.

## Defaults

| Config | Value | Meaning |
|---|---|---|
| `maxAttempts` | 3 | Attempts per logical request, first included |
| `transientFailuresBeforeRest` / `transientWindowMs` | 3 / 120 000 | Unexplained failures that rest a member |
| `transientRestInitialMs` / `transientRestMaxMs` | 30 000 / 300 000 | Backoff of that rest |
| `rateRestInitialMs` / `rateRestMaxMs` | 30 000 / 300 000 | Rate limit, overload |
| `announcedRestMinMs` / `announcedRestMaxMs` | 1 000 / 86 400 000 | Clamp on a provider-announced time |
| `quotaRestInitialMs` / `quotaRestMaxMs` | 1 800 000 / 86 400 000 | Quota or billing, nothing announced |
| `authRestInitialMs` / `authRestMaxMs` | 300 000 / 3 600 000 | 401/403 and unusable credentials |
| `unavailableRestInitialMs` / `unavailableRestMaxMs` | 1 800 000 / 21 600 000 | 404, model withdrawn |
| `shapeFailuresBeforeRest` / `shapeRestMs` | 3 / 300 000 | Settled request-shape failures in a row |
| `probeLeaseMs` | 150 000 | A probe holds a half-open member this long |
| `forcedProbeIntervalMs` | 60 000 | Probe cadence while nothing is ready |
| `stickyMaxSessions` / `stickyTtlMs` | 4 096 / 86 400 000 | Session table |
| `healthMaxEntries` | 512 | Members with evidence |
| `idleForgetMs` | 86 400 000 | Evidence with no rest and no failure this long is dropped |

Backoff doubles per consecutive failure of that kind: `initial × 2^(n-1)`, capped
at the maximum. `n` is `RestInfo.failures`.

## Health model

Per member key: `failures` (consecutive counted failures), `lastFailureAt`,
`lastSuccessAt`, `rest` (member scope), plus a window of recent transient
failure times. Per account (`sourceId`): `rest` (account scope), which covers
every model of the account. A member is **resting** while `now < until` of its
own rest or of its account's rest.

A member whose rest has ended is **half-open** until it succeeds or fails again:
it may be tried, but only one attempt at a time holds it (a *probe lease*, valid
for `probeLeaseMs`; released by `succeeded`/`failed`/`abandoned`). A request that
finds the lease taken treats the member as resting.

- **Success** (`succeeded`): clears the member's `failures`, transient window and
  rest. It also clears an account rest, but only when the succeeding attempt began
  after that rest did: a request that was already running when the rest started
  proves nothing about it.
- **Failure that ends a probe**: the new rest uses `failures + 1` when it is of the
  same kind as the rest that just ended, so backoff keeps growing across failed
  probes; a different kind starts again at 1.
- **Concurrent failures do not compound.** An attempt that began before the
  current rest of its member (or account) started carries evidence the rest
  already reflects: the rest keeps the later `until`, `failures` does not grow.
  Otherwise ten parallel requests failing together would multiply the backoff.

## Failure verdicts

`failed(attempt, evidence)` always lets the run continue to the next member. It
returns the rest it started (or `null`) and whether the member is blamed.

| Evidence | Reason | Scope | Rest |
|---|---|---|---|
| http 402, or 4xx whose body names quota/billing/balance¹ | `quota` | account | announced time (clamped) else quota backoff |
| http 429 whose body names quota/billing¹ | `quota` | account | as above |
| http 429, 529 | `rate` | member | announced time (clamped) else rate backoff |
| http 401 | `auth` | account | auth backoff |
| http 403 | `auth` | member | auth backoff |
| credential | `auth` | account | auth backoff |
| http 404 | `unavailable` | member | unavailable backoff |
| http 408, 5xx (other than 529), network, timeout, empty, stream-error | `transient` | member | none until `transientFailuresBeforeRest` within the window; then transient backoff |
| http 400, 413, 422 | — | — | provisional **request** blame (below) |
| any other status | `transient` | member | as 5xx |

¹ Quota wording: `quota`, `usage limit`, `billing`, `insufficient balance|credit|
funds|quota`, `credit balance`, `payment required`, `余额不足`, `额度`, `配额` (case-
insensitive; the router's existing pattern). 402 needs no wording.

**Announced time.** `retry-after` (seconds or HTTP date), `retry-after-ms`, or a
reset header (`anthropic-ratelimit-*-reset`, `x-ratelimit-reset-*`, `ratelimit-
reset` — RFC 3339 timestamp or duration like `1s`, `6m0s`, `30`) gives `until`.
Clamp the resulting duration to `[announcedRestMin, announcedRestMax]`;
`announced = true`. A time in the past or unparsable counts as nothing announced.
When several are present use the largest.

**Request blame.** A 400/413/422 may be the request's fault. The member is not
rested and the failure is *provisional*: when the run later `succeeded` on
another member, each provisionally blamed member counts one shape failure; at
`shapeFailuresBeforeRest` in a row, it rests `shapeRestMs` (`unavailable`,
member scope). If the run ends without a success, nobody is blamed. A success
of the member resets its shape count.

**Abandoned** attempts change nothing except releasing a probe lease.

## Order of attempts

`start(group, sessionKey)` builds the candidate order once; `next()` hands them
out one at a time, skipping members that stopped being eligible meanwhile (e.g.
their lease was taken by a concurrent request).

1. **Eligible** members are those not resting, plus half-open members whose
   lease is free (these are probes).
2. **Order**
   - If the session has a sticky member and it is eligible, it goes first.
   - `priority`: remaining eligible members in the group's order.
   - `spread`: without a sticky member, the eligible member with the fewest live
     sessions stuck to it goes first (ties by group order); the rest follow in
     group order. With a sticky member, as above.
3. **Nothing eligible.** If every member rests (a member whose rest ended is
   eligible, so this is about rests still running): the member with the
   earliest `until` is offered as a probe when its rest began at least
   `forcedProbeIntervalMs` ago and no probe was handed out for the group in the
   last `forcedProbeIntervalMs`; otherwise the run has nothing to try
   (`nothingToTry`, `retryAt` = earliest `until`). Only a run that has handed
   out nothing yet may do this.
4. A run never offers the same member twice and stops after `maxAttempts`.
   A resting member is offered *after* all eligible ones only in case 3.
5. `hasNext()` answers whether `next()` would hand out an attempt now, with no
   side effect (no lease taken, no forced probe recorded). The router asks it
   before an attempt to learn whether this one is the last chance, and waits
   longer for a last chance than for one that has an alternative behind it.

Members with an in-flight lease belong to another request: in case 1 they are
skipped; in case 3 they are skipped too (no second probe).

## Sticky sessions

`succeeded(attempt)` records `sessionKey → member` (when a key was given) and
refreshes its time. The table is an LRU of `stickyMaxSessions`; entries unused
for `stickyTtlMs` are ignored and dropped. A resting sticky member is skipped
for the request but the entry is **replaced only on success elsewhere** — so a
request that fails everywhere leaves it in place. `spread` counts live entries
per member for its choice. Members that left the group make their entries
invalid (ignored, dropped lazily).

## Introspection and lifecycle

- `health(group)` reports each member's state: `resting` while a rest holds,
  `half-open` once it ended, `ready` otherwise.
- `currentMember(groupId, sessionKey)` is the sticky target.
- `clearRest(filter)` releases rests ("retry now"). `{ memberKey }` releases that
  member's own rest and its account's rest, since an account rest would still
  keep it out. `{ sourceId }` releases the account's rest and the rest of every
  member of that account. No filter clears everything. Failure counts of the
  members released are reset. It returns how many rests (member or account)
  were released.
- `resetSource(sourceId)` forgets everything about an account (its key was
  edited or it signed in again): member health, account rest, shape counts,
  leases, sticky entries pointing at it.
- Both controls invalidate earlier attempts for the affected account(s), including
  provisional request-shape evidence. A late outcome still describes the request,
  but cannot change health or stickiness for an invalidated account. Clearing one
  member also invalidates its account's attempts because it clears the account
  rest. Attempts handed out afterwards and other accounts are unaffected.
- Runs retain invalidation records only while an attempt is open or its rejection
  is provisional. Outcomes release them; `finish()` releases any remainder and
  must be called in the dispatch's `finally` block, including exceptional exits.
  No historical generations or timers are retained.
- `forgetGroup(groupId)` drops that group's sessions.
- `snapshot()`/`restore()` carry health and rests (not sessions or leases).
  `restore` ignores entries whose `until` is more than `announcedRestMax` in the
  future (a clock moved backwards) and entries beyond `healthMaxEntries`.

## Bounds

Health entries are evicted when over `healthMaxEntries`: members with no rest
and no recent failure first, then the oldest `lastFailureAt`. Evidence that has
had no rest and no failure for `idleForgetMs` is dropped, and so is a half-open
member nobody has tried for that long. Every table is cleared of garbage on
access, never on a timer.

## Test matrix (must be covered, with a fake clock)

Ordering: priority order; sticky first; sticky member resting; recovery does not
move a sticky session; new session returns to the recovered primary; spread picks
least loaded, ties by order, keeps sticky; members removed from a group.
Budget: three attempts; never the same member twice; fewer members than budget;
`budgetSpent`. Failures: each evidence row above (reason, scope, duration, announced
clamps, backoff growth and cap); transient threshold inside and outside the window;
quota wording in 402/429/403/400; announced time parsing (seconds, date, ms,
reset durations, invalid, past); account rest covering other models of the
account; success clears account rest only through its own members. Request blame:
all-fail run blames nobody; success after request failures counts shape failures;
threshold rest; success resets the count. Probes: half-open single-flight, lease
expiry, release on every outcome, backoff growth over failed probes. Nothing
ready: soonest member probed after its rest ends; forced probe cadence;
`nothingToTry` with `retryAt`. Lifecycle: `clearRest`, `resetSource`,
`forgetGroup`, snapshot round trip, clock-backwards restore, bounds/eviction.
Determinism: same inputs and clock give the same order.

## Dispatch contract (`../server/group-dispatch.ts`)

The balancer only advises; the dispatch sends. What it guarantees the engine:

- **Hold until content.** Each member runs the router's ordinary handler behind a
  stand-in response (`server/held-response.ts`) that buffers what is written
  until the reply carries something the engine would act on (`server/commit-detector.ts`):
  non-blank text or reasoning, a tool call starting, or tool input. Start-of-message
  frames, pings, empty blocks and the single space the router pads an empty reply
  with are not content. A member that fails before that — an error status, an
  error event, an empty reply, a stream that ends or stalls — is passed over and
  the engine never sees it.
- **Never replay.** Once a member's reply has begun it is the engine's. A stream
  cut short afterwards is not retried on another member (a tool call must never
  run twice) and is not counted against the member.
- **Budget shared with the engine.** After a real failover (two or more distinct
  members failed) the final error carries `x-should-retry: false`, so one request
  costs at most `maxAttempts` in total. The failing provider's own status is
  kept. A single failing member leaves the engine's normal retry in charge.
- **Patience follows alternatives.** A streamed attempt with another member
  behind it waits at most 90 s for headers and 180 s for first content; the last
  chance and any non-streamed call keep the full timeout.
- **Client gone means no verdict.** Closing the connection abandons the attempt
  (a probe lease is released) and judges nobody.
- **Not every request picks a member.** Requests the router answers itself
  (the engine's warm-up) never reach the balancer.
- **Conversation identity.** `x-claude-code-session-id` / `session_id`, else a
  digest of the opening user message. The same key names the conversation in the
  facts below and in the sticky table.

Facts are emitted once per attempt (`server/group-facts.ts`: `trying`, `served`,
`exhausted`), never per chunk. `services/ai-sources/group-route-state.ts` keeps
only what a person would notice — a switch, a model that began serving, nothing
left to try — and pushes it to clients as `ai-sources:group-route`.

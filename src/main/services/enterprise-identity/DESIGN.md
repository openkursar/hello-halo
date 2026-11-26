# Organization sign-in

`product.json` may declare `enterpriseIdentity` with a localized `name`, a
provider module path relative to `product.json`, and `toolCredentials`. Without
that block there is no provider load, state subscription, resume listener or
credential work.

The provider must implement version 2 of
`src/shared/interfaces/enterprise-identity-provider.ts`. It owns restoration,
sign-in, renewal and the session itself. The host owns a display-only projection
in catalog order: `loading`, `unavailable`, `restoring`, `signed-out`, or `active`
with ready, expired and missing capabilities. It starts loading on demand, not
at launch. Reading the cached projection does not activate the provider. A
transient load error is retried on the next state request or sign-in; a contract
version mismatch is unavailable until restart. The host validates provider
snapshots at runtime. Invalid snapshots, including a settled capability without
an opaque subject, invalidate pending issuance, withdraw existing credentials
and project `unavailable`. System resume rechecks local expiry and coalesces
provider verification; a network failure does not sign the user out.

The provider returns a sign-in URL and flow ID. The host opens the URL in a
sandboxed, temporary desktop window restricted to the initial HTTPS or loopback
HTTP origin, using Electron's default system proxy. One attempt deadline covers
provider activation, `beginSignIn` and the window. Snapshot changes do not end the
window. Repeated requests join the attempt and focus its window. Sign-out, device
unbinding, user close and timeout invalidate the attempt and close its window;
any late flow ID is cancelled, and a late outcome does not settle the attempt.
A locally completed sign-out cannot be undone by an old flow's provider events.
URL, flow ID, subject and credentials stay out of renderer state.

Each build-owned credential binding declares a tool ID, capability, audience,
environment variable and optional non-secret static variables. The CLI launcher's
credential preload reads `<userData>/enterprise-identity/<audience>.json` only
at tool start. It has the same `{ token, expiresAt }` format, written atomically
with restrictive local file permissions. A credential expires no later than its
capability. One unreferenced timer drives expiry and renewal. Transient renewal
failure keeps any unexpired token; retries back off by 30 seconds, 2 minutes and
5 minutes. Provider changes and explicit verification reset the retry budget.

Withdrawal invalidates pending issuance and atomically replaces the affected
slot with an expired tombstone or unlinks it. A subject change blocks all new
issuance until every old slot is withdrawn, even if display names match. Failed
withdrawal is reported and does not permit replacement issuance; an already
running launcher can still read the old value until withdrawal or its own expiry
if the filesystem rejects both operations. Sign-out and device unbinding
withdraw local slots before contacting the provider. Quit withdraws synchronously;
configured startup clears or detaches leftovers before allowing issuance.

`state`, `sign-in`, `sign-out` and `retry` use typed IPC. Retry attempts pending
withdrawal or resumes the interrupted sign-out, re-reads a cached provider or
activates a temporarily unavailable one, and resets issuance backoff. A permanent
contract mismatch does not offer activation retry. Unconfirmed withdrawal is
reported separately from issuance failure and marks affected tools as potentially
usable.

Only state is readable over HTTP. The feature flag travels in the desktop
preload or the existing remote config bootstrap response. Configured clients
subscribe to changes; remote clients reconcile once per authenticated socket.

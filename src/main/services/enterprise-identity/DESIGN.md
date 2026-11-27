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

The provider returns a sign-in URL and flow ID, and may list further HTTPS
origins its page can take the window to, such as an identity provider's consent
page, so no step leaves Halo for the system browser. The host opens the URL in a
sandboxed, temporary desktop window restricted to those origins (exact origins
only; frames stay on the origin of the page holding them), using Electron's
default system proxy. One attempt deadline covers
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

A provider may also return browser cookies (`browserCookies()`) that sign the
person in to the organization's web pages. `browser-cookies.ts` writes them into
the built-in browser's shared session while the sign-in is active and a
capability is ready, always HttpOnly and SameSite=Lax, expiring with the cookie
and never later than 30 days; it asks again before the earliest expires or when
the person or the ready capabilities change, retries with the same backoff, and
validates the whole batch (host or parent domain, cookie-token name and value,
at most 16). Sign-out, an unavailable provider and quit remove only what Halo
wrote; pages the person signed in to keep their own sessions. A record outside
the credential directory names what was written (never values), the domains
and a salted digest of the person: the next start removes leftovers first, and
when a different person signs in, every cookie of those domains is cleared
before the new cookies are written, so no one inherits the previous person's
page sessions. Builds without the method do no browser work at all.

Only state is readable over HTTP. The feature flag travels in the desktop
preload or the existing remote config bootstrap response. Configured clients
subscribe to changes; remote clients reconcile once per authenticated socket.

`modelAccounts` names AI source types whose accounts come with the sign-in.
Login lists receive those providers marked `organizationSignIn` and offer the
sign-in in their place. In Settings the sign-in sits among the AI model
accounts: a login option while signed out, then one card that also presents
the account marked `managedBy: 'organization'`. The composer shows one
indicator for the sign-in and the selected model's quota. The host does not
yet obtain such an account itself. An account declared with `directSignIn` is
passed to `beginSignIn` as an alternative; when the person picks it, the
attempt ends with `{ alternative }` (only an id the host offered), which is not
an organization sign-in. The renderer's sign-in store then runs that account's
own login in Halo's login window and reloads settings, as one in-flight run
shared by every caller.

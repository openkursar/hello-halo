# Enterprise identity

## Purpose and boundary

A build may let the user sign in with a company identity so that command-line
tools it ships, or installs from its enterprise catalog, can reach internal
services. This module owns that sign-in on the client:

- the sign-in flow (start, wait for the user's approval, cancel, expiry);
- the session's lifetime (sign-out, session expiry, resuming it after launch);
- short-lived per-audience tool credentials derived from the session, and
  handing them to bound tools' processes only.

It does not:

- talk to any identity service itself. A build-supplied **provider** does; the
  contract is `src/shared/interfaces/enterprise-identity-provider.ts`;
- keep the provider's proof or ticket. The provider holds it; this module only
  asks for a credential for a named audience;
- give the model, the prompt, the session environment or tool arguments any
  credential;
- change model accounts (`ai-sources`) or the store account
  (`product.json` `identityProvider`). It is unrelated to both.

## Configuration

`product.json`:

```json
"enterpriseIdentity": {
  "provider": "./path/to/provider.js",
  "toolCredentials": [
    { "toolId": "npm.gitbeaker-cli", "capability": "intranet", "audience": "code-host",
      "env": "GITBEAKER_TOKEN", "staticEnv": { "GITBEAKER_HOST": "https://git.example" } }
  ]
}
```

Omitted → the state is `unavailable`, Settings shows no section, and the CLI
tool store gets no bindings. The provider path follows the `authProviders`
rule (relative to product.json). The module is imported on first use and its
first `get…Provider()` export is called.

A binding names a tool, the session capability it needs, the audience to ask
the provider for, the variable the tool reads, and fixed non-secret variables
(usually the server address). Bindings come from the build only; a package
cannot ask for one.

## Flow

1. Settings asks for the state (loads the provider) and lists its methods.
2. `beginLogin(method)` → provider returns `flowId`, expiry and what the user
   acts on, by the method's kind: `qr` → QR text (required), shown as a code;
   `browser` → an http(s) approval page, which the dialog opens in the default
   browser (with "open again" and "copy link"); a browser attempt may omit the
   page when nothing is left to approve. Any other answer is refused. One
   attempt at a time; a new one cancels the old.
3. The dialog calls `pollLogin(flowId)` in a loop. Each call waits at most
   `pollWaitMs` (25 s), asking the provider every `pollIntervalMs` (1.5 s), and
   answers at once on the first `scanned` so the screen can say "confirm on
   your phone". The code's own expiry is enforced here even if the provider
   keeps answering `pending`.
4. `confirmed` → the session (account, capabilities, expiry decided by the
   service) is kept **in memory**; for every audience whose binding's
   capability the session has, the provider issues a credential.
5. Closing the dialog cancels the attempt; nothing polls in the background.

## Resuming after launch

`<userData>/enterprise-identity-session.json` = `{ methodId, account }`, file
0600, written like a credential. It names the method and account of the last
sign-in the user did not end, never a proof or credential. Every confirmed
session writes it; sign-out removes it; session expiry keeps it.

At start, a configured build that finds the file calls the provider's optional
`restore(methodId)` in the background. A returned session is handled like a
confirmed one (credentials issued); `null` removes the file; `renewal-required`
shows the account as `expired`; a throw (service unreachable) is retried on a
later state request after `restoreRetryMs` (5 min). A state request waits at
most `restoreWaitMs` (3 s) for a restore under way; sign-in and sign-out wait
for it to finish. A result that arrives after the session or attempt changed is
dropped. An unreadable file, or one naming a method the provider no longer
offers, is removed. Providers without `restore` behave as before.

## Credentials on disk

`<userData>/enterprise-identity/<audience>.json` = `{ token, expiresAt }`,
directory 0700, file 0600, written to a temp name and renamed. `expiresAt` is
capped at the session's end. A credential that ends before the session is
renewed `refreshMarginMs` (60 s, at most half its life) before it ends.

The CLI tool store gives each bound tool's launcher a second preload
(`credential-<n>.cjs`, see cli-tools/DESIGN.md). On every start of the tool
it removes any inherited value of the variable, sets the fixed variables,
and reads the file; the variable is set only when the file holds a token whose
`expiresAt` is still ahead. The launcher, the view and TOOLS.md contain the
file path, never the token. Sign-in and sign-out therefore change files only;
no view is rebuilt and a running task picks up the change on its next call.

Withdrawal: sign-out removes the directory, then asks the provider to end the
session; session expiry removes the directory, keeps the account for display
as `expired`, and tells the provider; app quit removes it synchronously; app
start removes leftover credential files (only a restored session issues new
ones). A
generation counter drops a credential that arrives after the session changed.
A refused credential sets `lastError: 'credential-failed'` and leaves the tool
without one.

## Transport

`enterprise-identity:{state,begin,poll,cancel,sign-out}` over IPC, the same
under `/api/enterprise-identity/*` for remote mode; all `internal`, none is in
the AI's API manual. No call carries a proof, ticket or credential.

## Cost

Nothing at startup beyond recording paths. Only in a configured build: an
async removal of leftovers and, when the session file exists, loading the
provider and one background `restore`. Otherwise the provider loads when
Settings first asks.
Polling happens only while the dialog is open. Timers exist only while signed
in (one for the session end, one per renewing credential) and are `unref`ed.

## Known limits

- The credential file is on disk while signed in. Anything running as the user
  — including an AI shell command — can read it; the protection is that it is
  short-lived, audience-bound and never placed in the model's context.
- A bound tool's own child processes inherit the variable.
- Revocation at the service takes effect when the service rejects the token;
  the client learns of it only through the tool's error.
- Without a provider `restore`, or once the service no longer honours the
  authorization this computer holds, an app start needs a new scan.
- Bindings are build configuration only; catalog-delivered bindings are not
  supported yet.
- Two method kinds exist, `qr` and `browser`; the provider decides the actual
  protocol behind either.

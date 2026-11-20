# Enterprise identity

## Purpose and boundary

A build may let the user sign in with a company identity so that command-line
tools it ships, or installs from its enterprise catalog, can reach internal
services. This module owns that sign-in on the client:

- the QR flow (start, wait for scan and confirmation, cancel, code expiry);
- the session's lifetime (sign-out, session expiry);
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
2. `beginLogin(method)` → provider returns `flowId`, QR text and expiry. One
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
start removes leftovers (the session is never kept across launches). A
generation counter drops a credential that arrives after the session changed.
A refused credential sets `lastError: 'credential-failed'` and leaves the tool
without one.

## Transport

`enterprise-identity:{state,begin,poll,cancel,sign-out}` over IPC, the same
under `/api/enterprise-identity/*` for remote mode; all `internal`, none is in
the AI's API manual. No call carries a proof, ticket or credential.

## Cost

Nothing at startup beyond recording a path (and, only in a configured build,
an async removal of leftovers). The provider loads when Settings first asks.
Polling happens only while the dialog is open. Timers exist only while signed
in (one for the session end, one per renewing credential) and are `unref`ed.

## Known limits

- The credential file is on disk while signed in. Anything running as the user
  — including an AI shell command — can read it; the protection is that it is
  short-lived, audience-bound and never placed in the model's context.
- A bound tool's own child processes inherit the variable.
- Revocation at the service takes effect when the service rejects the token;
  the client learns of it only through the tool's error.
- The session is memory-only; every app start needs a new scan.
- Bindings are build configuration only; catalog-delivered bindings are not
  supported yet.
- Only QR methods exist; the provider decides the actual protocol.

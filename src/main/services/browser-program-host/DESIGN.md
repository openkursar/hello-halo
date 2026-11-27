# Browser program host

## Purpose and boundary

A program the AI runs in a session (through Bash or a terminal command) can
use that session's built-in browser: open and read pages, act on them, and
make requests that carry the browser's sign-in. It reaches the same browser
context as the session's AI Browser tools, so it can do exactly what those
tools can do, no more.

The wire protocol is the WebCLI host protocol v1, published with WeWorker's
WebCLI. Halo implements that existing open protocol rather than defining its
own, so any program that speaks it works. Nothing here names a site, a tool or
an organization; the variable names are the protocol's.

The module depends on `ai-browser`'s public surface (`BrowserContext`,
`browserContextOfServer`), `browser-view.service`, `browser-policy.service` and
`browser-host` (`withBrowserFrames`). `ai-browser` does not depend on it.

## Who gets it

`applyProgramHostEnvironment(env, mcpServers)` is called once the session's
MCP server set is final, right before the session starts
(`agent/session-manager.ts` `prepareCreationTools`, and `agent/dsh/options.ts`
for dsh, which builds its children's environment itself). It first removes
`WEBCLI_HOST_ENDPOINT` and `WEBCLI_HOST_TOKEN`, so a session never inherits
another one's or Halo's own. It sets them again only when the set includes an
AI Browser server, pointing at that server's browser context, together with
the state directories programs built for a host require (see "State"). A session
without the browser capability, because it was excluded, filtered by a policy
or never granted to a digital human, gets nothing. Each session gets the
variables when it is created; a session that is reused keeps the ones it has.

## Endpoint and credentials

- One loopback HTTP server (`127.0.0.1`, random port, path `/webcli/v1`). It
  starts the first time a session needs it, never at app launch, and is unref'd.
- Each browser context gets one 256-bit token, stable while the context lives,
  so rebuilt sessions keep working. A released or destroyed context's token is
  refused and dropped, and its running requests are aborted.
- A request must be `POST /webcli/v1` with `content-type: application/json`, a
  `Host` of exactly `127.0.0.1:<port>`, no `Origin` and no `Sec-Fetch-Site`
  (pages can reach loopback too; this refuses DNS rebinding and cross-site
  posts), and a known bearer token.

## Requests

- `browser` runs one browser command (`browser.ts`: open, state, click, fill,
  eval, extract, screenshot…) on pages the context owns or binds by name.
- `adapter.prepare` declares the scope of one Adapter call: hosts, page hosts,
  whether it writes and whether the person confirmed it. `adapter.fetch`,
  `adapter.helper` and `adapter.page` then run within it: background requests
  through the browser session (`fetch.ts`), helpers such as cookies, storage,
  downloads and file inputs (`helpers.ts`), and page scripts on a page the host
  opens for the Adapter (`page.ts`). Adapter code runs in the program, or in an
  isolated world of the page, never in the main process.
- A declared scope is a consistency check on the Adapter, not a security
  boundary: whoever holds the token can already drive the browser. The
  boundaries are the token, the conversation's browser context and the
  browser policy (`isUrlAllowedByPolicy`). Writes need a confirmed scope;
  redirects are never followed; responses are size-limited.

## One call at a time

The protocol names no call, and every program in a session shares the token.
So the host serves one request at a time per browser context and keeps one
Adapter call (its scope) per context:

- A request that arrives while another is running gets `HOST_BUSY`.
- A call is known by the connections that carry it. Programs speaking the
  protocol send one request after another on a keep-alive connection, and a
  program's connection closes when it exits.
- `adapter.prepare` replaces the current call only when none of its
  connections is still open; otherwise it gets `HOST_BUSY`. An Adapter request
  on a new connection continues the current call when no other connection of
  that call is open (the program reconnected after an idle close); otherwise it
  gets `HOST_BUSY`. A second program can therefore never run under the first
  one's scope.
- A program that disconnects (it finished, was interrupted or was killed)
  aborts its running request; navigation and page work stop.
- Every request has a 60 s ceiling; navigation and page scripts have their own
  shorter limits. Nothing is retried.

## What the person sees

Each request marks the conversation's browser as operated
(`beginToolCall`/`endToolCall`), as the AI's own browser tools do. Adapter
requests act on pages the host opens for them; afterwards the page the AI was
on is brought back, so the AI's next browser step acts where it left off.
`browser` commands drive pages as the program asks, like the AI's tools.

## State

`storage-cache.ts` keeps session-storage values an Adapter asked to cache,
encrypted with `foundation/crypto-envelope`, in
`<halo dir>/browser-program-host/session-storage.json`.

A WebCLI build for a host refuses to start unless the host also names its
state directories, so alongside the endpoint and token every lending session
gets `WEWORKER_USER_ADAPTERS_DIR` and `WEBCLI_ADAPTERS_DIR` (user Adapters),
`WEWORKER_ADAPTER_DATA_DIR` (Adapter data) and `WEBCLI_HOST_STATE_DIR`
(provider state), all under `<halo dir>/browser-program-host/programs/`,
created on first use with owner-only permissions. They are shared by every
session of this Halo and never point at a separately installed copy's
`~/.webcli`. A session without the browser gets none of them from the host.

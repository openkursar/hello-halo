# AI Browser — Controlling Halo's Embedded Browser

Last updated: 2026-09-03

Read this whenever a task needs real web interaction (search, form-fill, scraping, checking a
site), when the user asks why the AI "has no browser," or when a browser tool call is failing.
Architecture reference: `src/main/services/ai-browser/DESIGN.md` (read that file directly for
the full module map — this document only extracts what changes how you use the tools).

## Companion documents

| Document | Read it when |
|---|---|
| `ai-browser/scripting.md` | Writing or debugging a `browser_run` script — function signature, `params`, return value, path rules, timeout/retry behavior |

## 1. Concepts — three ways AI Browser gets used, each with different visibility

| Context | Code path | Tools available? | User sees it live? |
|---|---|---|---|
| Main chat | `services/agent/toolsets/registry.ts` (id `ai-browser`), singleton `BrowserContext` | Only if the "Web Control" toggle is on for that conversation | **Yes** — active-view/gone events broadcast to the renderer (`ai-browser/events.ts`), showing the "AI is operating this browser" banner and a "View live feed" button the user can click to open a live Canvas panel, and take over at any time |
| Digital human conversational chat (`app-chat.ts`) | `resolvePermission(app, 'ai-browser')`, **scoped** `BrowserContext` | Yes, unless the app's "AI Browser" permission was explicitly turned off | **No live feed exists for this path.** Scoped contexts hold no BrowserWindow reference and never emit view-lifecycle events (`DESIGN.md` "View Lifecycle Events": "Only the singleton (non-scoped) emits; scoped automation contexts stay silent") — confirmed independently: nothing in `src/renderer/components/apps/` references the live-view event bus or "View live feed". **Do not tell a user to click "View live feed" for a digital human's own chat or a scheduled run — that UI does not exist there.** |
| Scheduled automation run (`apps/runtime/execute.ts`) | Same `resolvePermission` gate, scoped context | Same as above | Same as above — silent by design |

These are genuinely different mechanisms, not the same toggle in two places (matches, and
verifies, the human manual's Q6 — "Web Control" and a digital human's "AI Browser" switch are
independent and don't affect each other):

- **Main chat "Web Control"** (`t('Web Control')` / 网页控制, input-area toggle) is a per-
  conversation **toolset** toggle. The AI can never turn this on itself mid-turn — CC's tool set
  is frozen for the whole turn (`src/main/services/agent/toolsets/DESIGN.md` §2). If the toggle is off and the task needs
  a browser, the AI should call `request_toolset` (a separate always-available meta-tool, not
  part of this MCP server) so the user sees a highlighted "Tools" menu — then stop and wait; do
  not silently try to browse without it, and do not ask the user to type something instead of
  flipping the switch.
- **A digital human's "AI Browser" permission** (`AppCapabilitiesSection.tsx`, `t('AI Browser')`)
  is an app-level permission, default **ON** like all built-in capabilities (only an explicit
  user deny turns it off — `src/main/services/agent/toolsets/DESIGN.md` §6, matches `create-digital-human/SKILL.md` §5).
  There is no in-conversation request mechanism for this path — if it's off, the app's own
  Settings tab is the only place to turn it on.

## 2. Turning it on (what to tell the user)

- Main chat: click the 🌐 **Web Control** button in the toolbar under the message input. Blue/
  highlighted = on. Default is on for a brand-new conversation (`FIRST_RUN_DEFAULT_TOOLSETS`
  seeds `['ai-browser']`, `src/main/services/agent/toolsets/DESIGN.md` §4b); after the user's first manual toggle in any
  conversation, their last choice is remembered for new conversations too (`config.lastToolsets`).
- Digital human: open the app → **Settings** tab → **AI Browser** toggle
  (`AppCapabilitiesSection.tsx:126-133`). If the app's spec itself expects browser access but the
  permission is off, the settings UI shows an amber warning — point the user there rather than
  guessing why browsing silently doesn't happen.

## 3. Core workflow (the actual system-prompt text shipped to every session)

Verbatim from `src/main/services/ai-browser/index.ts:41-63` (`AI_BROWSER_SYSTEM_PROMPT`):

1. `browser_navigate` — open a URL; the first page is created automatically.
2. `browser_snapshot` — see what's on the page (returns element UIDs).
3. Use UIDs to interact: `browser_click`, `browser_fill`, `browser_hover`, `browser_press_key`.
4. `browser_snapshot` again — verify the result, get fresh UIDs.
5. Repeat 3–4 until done.

UIDs are invalidated by any page-changing action — never reuse a UID from a stale snapshot.
`browser_evaluate` is the escape hatch for anything the dedicated tools can't do (scrolling,
viewport resize, direct `fetch()` calls, DOM queries). `browser_run` (see
`ai-browser/scripting.md`) is for **repeatable, tested** scripts, not one-off exploration.

## 4. Login state — how it's actually shared, and what "Browser Login" really does

### The sharing mechanism

- **Every AI-driven browser view in the entire app — main chat, every digital human's
  conversational chat, every automation run, across every space — plus the standalone login
  window, share exactly one Electron session partition: the literal string `persist:browser`.**
  This is not per-space, per-app, or per-conversation; it's a single hardcoded constant used
  everywhere a browser surface is created (`src/main/ipc/browser.ts:516`,
  `src/main/services/browser-view.service.ts:290`). A login done from any digital human, in any
  space, is immediately visible to every other digital human, automation run, and the main chat.
  Conversely, if some *other* automation navigates away from or logs out of a site, that affects
  everyone else's next visit too — there is no isolation between tasks.
- The `persist:` prefix means the session is written to disk and survives app restarts (standard
  Electron behavior for that prefix) — a login done today is still there tomorrow, until the site
  itself expires the session or the underlying storage is otherwise cleared.
- This partition is entirely local to the machine running Halo. A login done on one computer is
  not available on another Halo install — "my automation lost its login" after moving to a new
  machine/VM/VDI image is expected, not a bug, and the fix is simply to log in again there.

### Declaring and triggering a login

- A digital human declares required sites via the App Spec's `browser_login: [{ url, label }]`
  array (`src/main/apps/spec/schema.ts:339-344`, `488`). The Settings tab and the conversational
  chat header both render a **dismissible amber notice** per entry
  (`src/renderer/components/apps/LoginNoticeBar.tsx`) with an "Open to log in" button that opens
  the standalone login window at that URL — into the same shared `persist:browser` partition, so
  anything logged into there is immediately usable by the app's own automated runs.
- **Halo never verifies the user actually logged in.** `LoginNoticeBar` is "pure presentational"
  (its own doc comment, line 10) — dismissing it is a manual acknowledgment, not a check against
  real cookie/session state. There is no clear-cookies/reset-session action anywhere in the
  browser IPC or view-service code either — nothing routinely invalidates this partition.
- **Never ask the AI to enter a password.** The pattern is always: the human logs in through the
  standalone window (or the live Canvas, for main chat — see §1's visibility table for why a
  digital human's own run has no equivalent live window to log in through directly), then either
  dismisses the notice or tells the AI "I'm logged in, continue." `create-digital-human/SKILL.md`
  §4 already documents the spec side of this — this file only adds the actual sharing mechanism.

### When the session won't be there (diagnosis)

- **The site itself expired/invalidated the session** (its own timeout, a security policy, a
  logout elsewhere) — this is the ordinary case and the only fix is: reopen the URL (via the
  notice, Settings tab, or by navigating there) and log in again. Halo has no way to detect this
  in advance; it only surfaces as the automated run failing to reach a logged-in page.
- **A device-mode switch changed the User-Agent and the site tied its session to the original
  UA.** `browser_navigate`/`browser_tab`'s `device: "h5"` param (and the equivalent UI toggle in
  the live Canvas) doesn't just resize the viewport — it calls `setUserAgent()` with a different
  UA string and reloads (`browser-view.service.ts:1073-1104`, `setDeviceMode`). Some sites bind a
  session/cookie to the UA that first created it and reject or re-challenge a request from a
  different one — this exact failure mode is why the standalone login window deliberately copies
  the main browsing UA rather than using Electron's default (`ipc/browser.ts:520-522`, referencing
  a real prior bug: "sites that gate auth by UA otherwise reject the login request"). If a
  previously-working login starts failing right after a device-mode switch, suspect this before
  assuming the session expired normally — log in again in the **same** device mode the automation
  will actually run in.
- **The site is blocked by browser policy** (§6), which looks superficially like "can't access the
  site" too but has nothing to do with login — check whether the failure is a Halo "Access
  Restricted" page (policy) versus the target site's own login/error page (session) before
  assuming either cause.
- **h5 vs pc is a full separate `BrowserView`, not a toggle on the existing one** — switching
  device mode when the active page isn't already in that mode opens a **new page**
  (`tools/navigation.ts`: "Mobile mode opens a new page when the active page is not already in
  mobile mode"). Cookies still carry over (same partition), but any in-memory page state
  (a filled-but-unsubmitted form, JS app state) does not — that's normal navigation behavior, not
  a session problem.

## 5. Multimodal / vision requirement

Page-screenshot understanding requires the current model's resolved `vision` capability to be
`true` (see `ai-model-setup/index.md` §5 for how that's resolved — preset → pattern → default,
overridable per model). When vision is `false`, AI Browser **still works** — the AI reads the
accessibility-tree snapshot (`browser_snapshot`, DOM/ARIA structure) instead of an actual
screenshot. Don't tell the user browsing is unavailable on a text-only model; only screenshot-
based visual verification (`browser_screenshot`) degrades, and even then the tool still returns
an image, it just won't be usefully interpreted by a non-vision model.

## 6. Network access policy — "Access Restricted" pages

`src/main/services/browser-policy.service.ts` is the single source of truth. In the open-source
default build there is no `browserPolicy` in `product.json`, so `isUrlAllowedByPolicy()` always
returns true (unrestricted) — every navigation is allowed and the homepage for new tabs is
`https://www.bing.com` (`getDefaultBrowserHomepage()`). A deployment **may** ship an `allowlist`
or `blocklist` policy (`browserPolicy.mode`), optionally with `userExtensible: true` letting the
user widen (never narrow) the allowlist from the browser settings UI. If the user reports a red
"Access Restricted" lock-icon page, that is this policy blocking the host — the AI cannot bypass
it; only a user with an editable allowlist (or an admin who controls `product.json`) can. Do not
guess at what's on any particular deployment's allowlist — read it via the running app's browser
settings if you need to know, never assume the open-source default's "everything allowed"
applies.

## 7. Verification — how to know a browser action actually worked

There is no separate "did it work" tool call — verification is the workflow itself:
- After every state-changing action (`browser_click`, `browser_fill`, `browser_navigate`, etc.),
  take a fresh `browser_snapshot` and check the page actually reflects the intended change before
  proceeding — a stale mental model of the page is the single most common cause of wrong clicks.
- For data-extraction tasks, the tool's returned content **is** the verification — if
  `browser_snapshot`/`browser_evaluate` returns empty or unexpected structure, the selector or
  page state assumption is wrong, not a transient failure to retry blindly.
- `browser_inspect(target:"network")` and `target:"console"` are the two ways to diagnose "the
  page looks right but the data isn't there" — check for failed XHR/fetch requests or JS errors
  before assuming a DOM-selector problem.

## 8. Do NOT ask / do NOT tell the user

- **Do not ask the user to enable "developer mode" or similar** to use AI Browser — there is no
  such setting; it's either the Web Control toggle (main chat) or the AI Browser permission
  (digital human).
- **Do not tell the user to click "View live feed" for a digital human chat or scheduled run**
  — confirmed in §1, that UI only exists for the main-chat singleton context.
- **Do not ask the user which browser engine or profile to use.** There is exactly one embedded
  Chromium instance with one shared session partition (`persist:browser`); there is no per-task
  browser-profile concept.
- **Do not try to enable a toolset mid-turn, and do not ask the user to type a workaround
  instead of flipping the switch.** Call `request_toolset` and stop — see §1.
- **Do not promise Halo will detect an expired login and re-prompt automatically.** It won't
  (§4) — recovery is always a manual re-login.
- **Do not tell a user on a non-vision model that browsing itself is unavailable.** Only
  screenshot interpretation degrades (§5); DOM-based operation still works fully.
- **Do not assume any particular `browserPolicy` (allowlist/blocklist) is in effect** — the
  open-source default has none; a given deployment's policy is not something to guess at (§6).

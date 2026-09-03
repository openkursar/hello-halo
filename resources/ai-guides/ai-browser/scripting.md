# browser_run — Writing Production Browser Automation Scripts

Read this whenever you need `browser_run`: a task that will be repeated (a skill, a recurring
digital-human run), or a script whose logic is too long/complex to comfortably inline as a
`browser_evaluate` one-liner. Source of truth: `src/main/services/ai-browser/tools/script.ts`.

## 1. Concept — `browser_run` vs `browser_evaluate`, and how they relate

Both tools ultimately call the exact same underlying method,
`BrowserContext.evaluateScript()` (`src/main/services/ai-browser/context.ts:1279-1305`), which
sends a Chrome DevTools Protocol `Runtime.evaluate` command with `returnByValue: true,
awaitPromise: true` to the live page. The only real differences:

| | `browser_evaluate` | `browser_run` |
|---|---|---|
| Source | Inline string in the tool call | A `.js` file read from disk |
| Argument passing | `args: [{uid}]` — resolves **live DOM elements** from the latest snapshot and passes them positionally | `params: {...}` — a plain JSON object, `JSON.stringify`'d and spliced into the expression text (`context.ts:1283`) — **cannot** carry a snapshot `uid` or any live reference, only data |
| Intended use | One-off exploration, edge cases dedicated tools can't handle | Repeatable, tested scripts — skills, recurring automation |

**This means: use `browser_evaluate` to prototype.** Since both paths run identical code, get the
script body working as an inline `browser_evaluate` call first (fast iterate/fail loop, no file
I/O), then save the working body into a `.js` file for `browser_run` once it's correct. Don't
write a script file blind and debug it through `browser_run`'s slower read-file-execute-report
cycle.

### When to reach for `browser_run` instead of the interaction tools or `browser_evaluate`

The default workflow is still `browser_snapshot` → `browser_click`/`browser_fill`/... →
`browser_snapshot` (`ai-browser/index.md` §3) — that stays the right tool for a single,
one-time interaction, because it gives the model a fresh accessibility snapshot to reason about
after every step. Reach for a script instead when:

- **The same multi-step sequence will run again** — a skill, a recurring digital-human task, or
  anything you can already tell you (or another turn) will need to repeat verbatim. A `.js` file
  under `.claude/skills/<name>/` is the reusable artifact; a chain of individual tool calls is
  not.
- **The logic needs real control flow** — loops over an unknown number of DOM elements,
  conditional branching on page content, retry-until-condition — that's awkward to express as a
  sequence of discrete `browser_click`/`browser_fill` calls but natural as JS.
- **You need to read+compute+return structured data in one round trip** (e.g. scrape a table,
  compute an aggregate) rather than snapshotting the DOM and doing the extraction/analysis in the
  agent's own reasoning — a script does the extraction inside the page context in one call.

Prefer the interaction tools (not a script) when the task is genuinely a single navigate-click-
fill-submit flow done once — writing and whitelisting a file for that is more overhead than the
tools it would replace, and you lose the re-snapshot-after-every-step safety net.

## 2. Required file format

```js
async (params) => {
  const items = document.querySelectorAll(params.selector)
  return Array.from(items).map(el => el.innerText)
}
```

- Exactly one top-level expression: a single arrow function, `async` by convention (the tool
  description requires it; the underlying CDP call does `awaitPromise: true` either way, so a
  synchronous return also resolves, but write `async` — that's the documented contract).
- The tool wraps your file's content as `(<your content>)(<JSON.stringify(params)>)` before
  sending it (`context.ts:1283-1286`) — do **not** self-invoke or add an IIFE wrapper yourself,
  and do not end the file with anything after the closing `}` of the function (no trailing
  comments). A single trailing `;` is fine — it's stripped automatically
  (`script.ts:120-123`, guards against `(script;)(args)` becoming a `SyntaxError`, a "common AI-
  generation mistake" per the code comment).
- `params` is always exactly one object argument (`{}` if the tool call omits `params`) — there
  is no way to receive multiple positional arguments the way `browser_evaluate`'s `args` array
  allows.
- The script runs in the page's own JS context (real DOM, `window`, `fetch`, `localStorage`) —
  **not** Node.js. No `require()`, `import`, `fs`, `path`, or `Buffer` (same environment as
  `browser_evaluate`, documented on that tool).

## 3. Return value

- Must be JSON-serializable (`returnByValue: true` on the CDP call does a structured clone).
  A DOM node, function, or `undefined` value serializes to `{}` — extract the fields you need
  into a plain object/array before returning, don't return an element handle.
- The tool result text wraps whatever you return in a fenced ` ```json ` block after JSON-
  stringifying it (`script.ts:146-150`); a non-object return (string/number/boolean) is coerced
  with `String(result)` instead.
- A thrown error (or a rejected promise, since the call awaits) surfaces as the CDP
  `exceptionDetails.exception.description` and is returned as a tool error:
  `Script execution failed: <message>` (`script.ts:151-153`, `context.ts:1298-1302`).

## 4. Call parameters

```
{ file: "/absolute/or/relative/path.js", params?: {...}, timeout?: number }
```

- **`file`** — must end in `.js` (checked literally; anything else is rejected before it's even
  read). Relative paths resolve against `ctx.workDir` — the current space's working directory,
  the same value passed at MCP-server-creation time for both the main-chat toolset and a digital
  human's scoped context alike (`script.ts:90` comment, `toolsets/types.ts` `workDir: string` is
  required on the scope). Absolute paths are used as-is.
- **Path whitelist** — the resolved absolute path must be inside one of exactly two places, or
  the call is rejected before the file is even opened (`script.ts:100-110`):
  1. A `.claude/skills/` directory rooted at `$HOME` **or** at any ancestor of `workDir`
     (`isUnderSkillsDir`, `script.ts:28-43` — this specifically blocks a path like
     `/tmp/.claude/skills/x.js` from qualifying just because it contains the marker string; the
     directory *containing* `.claude/skills/` must actually be `$HOME` or an ancestor of
     `workDir`).
  2. `workDir` itself (or a subdirectory of it).
  A script anywhere else — e.g. an arbitrary path outside both — fails with `Path not allowed`.
- **`timeout`** — milliseconds, clamped to `[1000, 120000]`, default `60000`
  (`BROWSER_RUN_DEFAULT_TIMEOUT` / `BROWSER_RUN_MAX_TIMEOUT`, `script.ts:16-18, 133-136`). This
  timeout only governs how long the **tool call** waits — it races the CDP call against a
  `setTimeout` (`withTimeout`, `tools/helpers.ts:30-38`) but sends no cancellation to the page.
  If your script is genuinely hung (e.g. an unresolved `fetch`, an infinite loop) the timeout
  makes the tool return an error, but whatever is still running in the page keeps running; a
  page left in that state may need `browser_navigate` (a fresh load) before further tools behave
  normally.

## 5. Debugging workflow

1. Iterate the logic as `browser_evaluate` with the same body (see §1) until it returns exactly
   what you expect against a live, already-navigated page.
2. Move the working body into a `.js` file under the space's working directory or a
   `.claude/skills/<name>/` folder, wrapped as `async (params) => { ... }`.
3. Call `browser_run` with a small, known-safe `params` object first; check the returned JSON
   shape matches what step 1 produced.
4. If it fails at this stage but step 1 worked, the most likely causes are file-format mistakes
   (§2) — trailing content after `}`, missing `async`, or a `params.x` reference that doesn't
   match the keys you're actually passing — not a browser/page problem, since the execution
   engine is identical to what you already validated.
5. On a timeout specifically: don't just retry blindly with a longer `timeout` — first re-verify
   the same logic still completes promptly via `browser_evaluate` on the current page state; the
   page may have changed (redirected, a modal appeared) since you wrote the script.
6. **When the script "fails" but the reported error doesn't explain why** (a `fetch()` inside the
   script rejected, an element your script expects was never there, a network response the page
   depended on never arrived), use `browser_inspect` — it's the only way to see past the script's
   own thrown message into what actually happened on the page:
   - `browser_inspect(target: "console")` — surfaces JS errors/warnings the page itself logged
     (a framework error, an uncaught rejection elsewhere on the page) that your script's own
     `try`/`catch` never sees because they didn't happen inside your script's call stack.
   - `browser_inspect(target: "network")`, optionally filtered by `resourceTypes: ["fetch",
     "xhr"]` — shows whether the request your script depended on (or triggered) actually went
     out, what status it got back, and its response body via the per-request detail call
     (`{ target: "network", id }`). This is the fast path for "my script's `fetch()` returned
     something unexpected" instead of adding `console.log` statements and re-running.
   Run `browser_inspect` **immediately** after the failed `browser_run`/`browser_evaluate` call,
   before any further navigation — it only reflects the current page's history, and a subsequent
   `browser_navigate` resets it.

## 6. Common mistakes worth naming

- **Treating `params` as if it were `browser_evaluate`'s `args`.** You cannot pass a snapshot
  `uid` through `params` and expect a live element — `params` is inert JSON. If a script needs to
  target a specific element found via `browser_snapshot`, express that as a selector/text string
  in `params` and re-locate it with `document.querySelector`/`querySelectorAll` inside the
  script, not as an element reference.
- **Forgetting the file must be `async`.** The tool's own contract requires it even though the
  CDP layer would technically tolerate a sync function — don't rely on that leniency, it's not
  part of the documented interface and could change.
- **Assuming a timeout aborts in-page work.** It doesn't (§4) — plan scripts to have their own
  reasonable internal timeouts (e.g. on a `fetch`) rather than relying on the tool's outer clamp
  to stop a runaway request.
- **Writing the script somewhere outside the whitelist** (e.g. a scratch path under `/tmp`) —
  it will be rejected outright, not merely warned about. Put reusable scripts under
  `.claude/skills/<skill-name>/` if they belong to a skill, or under the space's working
  directory otherwise.

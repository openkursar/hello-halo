# Worked Examples

The browser-automation examples below are condensed from real, currently-installed builtin apps
(an internal-system approval-workflow agent and `resources/builtin-apps/meeting-room-booker/spec.yaml`)
— not invented. Use their structure, not their literal content, for any new browser-automation
digital human. The approval-workflow app's real name and target system are internal and not
reproduced here; it's referred to below as `internal-approval-agent`.

## 1. Minimal WeCom-reachable assistant (no subscriptions)

Exactly what Halo itself auto-creates after a WeCom bot scan-authorization
(`src/main/apps/runtime/im-channels/wecom-bot-default-spec.ts:52-68`, `botIdPrefix` is the first 8
chars of the new bot's ID, substituted in so multiple scan-auth sessions get distinguishable
names):

```json
{
  "spec_version": "1",
  "name": "WeCom Assistant a1b2c3d4",
  "version": "1.0",
  "author": "Halo",
  "description": "Auto-created WeCom Intelligent Bot assistant. Edit the system prompt anytime in the app detail page.",
  "type": "automation",
  "system_prompt": "You are a helpful assistant. Keep replies concise and clear. Reply in the same language as the user's message."
}
```

No `subscriptions`, no `config_schema`, no `permissions` needed just to be reachable — the
IM binding happens afterward in Settings (`create-digital-human/im-triggers.md`). Extend `system_prompt` for the
actual task; add `subscriptions` only if it should *also* run on a schedule independent of
being messaged.

## 2. Minimal scheduled report

```json
{
  "name": "HN Daily",
  "description": "Delivers a Hacker News top-stories digest every morning at 08:00",
  "type": "automation",
  "system_prompt": "You are an HN digest assistant. On each trigger: 1) Open https://news.ycombinator.com and retrieve today's Top 10 stories. 2) Write a concise 2-3 sentence summary for each. 3) Call notify_channel to email the digest to the configured recipient (config.email).",
  "permissions": ["ai-browser"],
  "subscriptions": [{ "source": { "type": "schedule", "config": { "cron": "0 8 * * *" } } }],
  "config_schema": [{ "key": "email", "label": "Recipient Email", "type": "email", "required": true }]
}
```

No `output` field — as covered above, `output.notify` is schema-only and does nothing. The email
actually gets sent because `system_prompt` step 3 explicitly tells the agent to call the
`notify_channel` tool; that instruction is the only thing making delivery happen here.

## 3. Browser-automation digital human with an approval gate (structure pattern)

Adapted from the real `internal-approval-agent` (name genericized — see the note at the top of
this file). Reuse this shape whenever a digital human performs browser actions against an
internal system where mistakes are costly:

```yaml
permissions:
  - ai-browser
requires:
  mcps:
    - id: ai-browser                      # inert here — kept for parity with the real spec this
                                           # pattern is drawn from; ai-browser is actually granted
                                           # by `permissions: [ai-browser]` above, not this entry.
                                           # Only list a *user-installed* MCP server id here if this
                                           # app must have it on scheduled/triggered runs — see
                                           # create-digital-human/spec-reference.md's `requires` section.
  skills:
    - id: team/some-site-list-items       # a pre-built skill that fetches data via the site's API
    - id: team/some-site-do-action        # a pre-built skill that performs the action
config_schema:
  - key: auto_approve
    label: Enable autonomous action
    type: boolean
    default: false
    description: When off, only checks and reports — takes no action.
  - key: max_actions_per_run
    label: Max actions per run
    type: number
    default: 10
    description: Safety cap to prevent runaway automation.
memory_schema:
  processed_ids:
    type: array
    description: IDs already handled, to avoid repeats. Cap at ~2000.
  last_run_at:
    type: date
system_prompt: |
  You are a <role>. Follow these steps exactly — do not skip steps or improvise.

  ## Forbidden
  - Do not use browser_click/browser_fill on this system's pages for data operations —
    use browser_run to call the pre-built skill scripts only (they call the site's API
    reliably; clicking through a complex internal UI is fragile and not repeatable).
  - Do not take any action not explicitly authorized by config (auto_approve) or by an
    explicit, unambiguous user instruction in this turn.

  ## Steps
  1. Establish a browser session against the target site (browser_navigate to
     https://internal-system.example.com + browser_wait_for a known landmark; if it fails,
     stop and report "not logged in / unreachable").
  2. Call the list skill to fetch pending items:
     browser_run({ file: ".claude/skills/some-site-list-items/index.js",
                    params: { pageSize: 30, pageIndex: 1 } })
     - result.success === false → report the error and stop.
     - result.items is empty → report "nothing pending" and stop.
     - otherwise → continue to step 3.
  3. Classify each item; when auto_approve is off, everything is report-only.
  4. If auto_approve is on, for each matched item (up to max_actions_per_run):
     browser_run({ file: ".claude/skills/some-site-do-action/index.js",
                    params: { itemId: <item.id>, action: "approve" or "reject", memo: "<reason>" } })
     Record result.success and result.error (if any) for the report; keep going on failure,
     don't abort the whole run over one failed item.
  5. Update memory (processed_ids, last_run_at, stats).
  6. Produce a Markdown report: overview counts, what was auto-handled, what failed and why,
     what needs human attention.
escalation:
  enabled: true
  timeout_hours: 24
browser_login:
  - url: https://internal-system.example.com
    label: Internal System
```

No `output` block — `output.notify.system`/`output.notify.channels`/`output.format` are all
schema-only and the runtime never reads any of them (see `create-digital-human/spec-reference.md`'s
`output` section). If this app should also produce a desktop toast, that's a per-app user
override the user sets afterward in Settings, not something this spec can configure.

### The skill scripts these `browser_run` calls actually run

`requires.skills` installs each skill's files under `.claude/skills/<name>/` in the space's
working directory (`src/main/apps/skill-discovery.ts`: `<workDir>/.claude/skills/<name>/
SKILL.md`) — the trailing segment of the skill id becomes the directory name (the real
`internal-approval-agent` spec declares a namespaced skill id and calls it via an `index.js`
in that skill's directory; this example follows the same `index.js` convention).
Every script here must satisfy the constraints in `ai-browser/scripting.md`: a single
`async (params) => {...}` arrow function, a JSON-serializable return value, and — since
`browser_run`'s own timeout only stops the *tool call* from waiting, not anything still running
on the page (`ai-browser/scripting.md` §4) — its own internal timeout on any `fetch()`.

`.claude/skills/some-site-list-items/index.js`:

```js
async (params) => {
  const pageSize = params.pageSize ?? 20
  const pageIndex = params.pageIndex ?? 1

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)

  try {
    // credentials: 'include' sends the page's own cookies — this is what makes fetch()
    // authenticated without the script ever touching a password. It works because
    // browser_run executes inside the already-navigated, already-logged-in page (step 1).
    const res = await fetch(`/api/todo/list?pageSize=${pageSize}&pageIndex=${pageIndex}`, {
      credentials: 'include',
      signal: controller.signal
    })
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` }

    const data = await res.json()
    // Return only plain data — never a DOM node, never the raw Response object.
    return {
      success: true,
      items: (data.items || []).map(item => ({
        id: item.id,
        title: item.title,
        applicant: item.applicant,
        createdAt: item.createdAt
      }))
    }
  } catch (err) {
    return { success: false, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) }
  } finally {
    clearTimeout(timeoutId)
  }
}
```

`.claude/skills/some-site-do-action/index.js`:

```js
async (params) => {
  const { itemId, action, memo } = params
  if (!itemId || !action) return { success: false, error: 'itemId and action are required' }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10000)

  try {
    const res = await fetch(`/api/todo/${itemId}/${action}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memo: memo || '' }),
      signal: controller.signal
    })
    if (!res.ok) return { success: false, error: `HTTP ${res.status}` }
    return { success: true, itemId, action }
  } catch (err) {
    return { success: false, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) }
  } finally {
    clearTimeout(timeoutId)
  }
}
```

Note what these scripts do **not** do, on purpose: no `uid` from a `browser_snapshot` anywhere.
`browser_run`'s `params` is inert JSON, `JSON.stringify`'d into the call
(`ai-browser/scripting.md` §2) — it can never carry a live element reference the way
`browser_evaluate`'s `args` array can. A skill that needs to act on something the page
*rendered* rather than an ID you already have would have to `document.querySelector` for it
inside the script itself, not pass a snapshot uid through `params`.

Key lessons this pattern encodes:
- **Prefer scripted `browser_run` calls over ad-hoc `browser_click`/`browser_fill`** when a
  reliable skill script exists for the target site — more repeatable, less likely to break on
  minor UI changes. Fall back to interactive AI Browser only when no such skill exists yet.
  This is a reliability preference from real production apps, not a hard platform rule — do
  not present it to the user as a limitation of Halo itself.
- **Gate destructive/consequential actions behind an explicit config toggle** (`auto_approve`)
  defaulting to off/report-only, plus a `max_actions_per_run` safety cap.
  See `create-digital-human/interview-checklist.md`.
- **`memory_schema` for dedup** — every recurring automation that "processes items" needs a
  processed-IDs list, or it will repeat work every run.
- **`browser_login` instead of any credential field** — this app assumes the user is already
  authenticated in their own Halo browser for the target system.
- **If this app depended on a real, user-installed MCP server** (not a built-in like
  `ai-browser`), that server's id would need to be in `requires.mcps` for the scheduled run to
  see it — the field is a real least-privilege allowlist for autonomous runs, only inert for
  built-in capabilities. See `create-digital-human/spec-reference.md`.

## 4. Config-heavy scheduled automation (many user-specific values)

Adapted from `meeting-room-booker` — shows how granular `config_schema` should get when a
task has several independent user preferences (times, type, priority order, target day):

```yaml
config_schema:
  - key: meeting_time_start
    label: Start time
    type: string          # "string", not "text" — short single-line values
    default: "16:00"
  - key: meeting_time_end
    label: End time
    type: string
    default: "19:00"
  - key: room_type
    label: Room type
    type: select
    options:
      - { label: Medium, value: medium }
      - { label: Small, value: small }
  - key: floor_priority
    label: Floor priority (comma-separated, highest first)
    type: string
    default: "20,19,21"
  - key: target_weekday
    label: Target weekday
    type: select
    options:
      - { label: Monday, value: "1" }
      - { label: Tuesday, value: "2" }
```

Don't collapse several independent preferences into one free-text field the AI has to parse
loosely — model each as its own typed `config_schema` entry, exactly as above.

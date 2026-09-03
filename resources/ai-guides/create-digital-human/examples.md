# Worked Examples

The browser-automation examples below are condensed from real, currently-installed builtin
apps (`resources/builtin-apps/weoa-approval-agent/spec.yaml`,
`resources/builtin-apps/meeting-room-booker/spec.yaml`) — not invented. Use their structure,
not their literal content, for any new browser-automation digital human.

## 1. Minimal WeCom-reachable assistant (no subscriptions)

What Halo itself auto-creates after a WeCom bot scan-authorization
(`src/main/apps/runtime/im-channels/wecom-bot-default-spec.ts`):

```json
{
  "name": "WeCom Assistant",
  "description": "General-purpose WeCom assistant.",
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
  "system_prompt": "You are an HN digest assistant. On each trigger: 1) Open https://news.ycombinator.com and retrieve today's Top 10 stories. 2) Write a concise 2-3 sentence summary for each. 3) Send an email notification.",
  "permissions": ["ai-browser"],
  "subscriptions": [{ "source": { "type": "schedule", "config": { "cron": "0 8 * * *" } } }],
  "config_schema": [{ "key": "email", "label": "Recipient Email", "type": "email", "required": true }],
  "output": { "notify": { "channels": ["email"] } }
}
```

## 3. Browser-automation digital human with an approval gate (structure pattern)

Adapted from the real `weoa-approval-agent`. Reuse this shape whenever a digital human
performs browser actions against an internal system where mistakes are costly:

```yaml
permissions:
  - ai-browser
requires:
  mcps:
    - id: ai-browser
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
  1. Establish a browser session against the target site (browser_new_page + wait for a
     known landmark; if it fails, stop and report "not logged in / unreachable").
  2. Call the list skill via browser_run to fetch pending items.
  3. Classify each item; when auto_approve is off, everything is report-only.
  4. If auto_approve is on, act on matched items via browser_run (respecting
     max_actions_per_run), recording each outcome.
  5. Update memory (processed_ids, last_run_at, stats).
  6. Produce a Markdown report: overview counts, what was auto-handled, what failed and why,
     what needs human attention.
escalation:
  enabled: true
  timeout_hours: 24
browser_login:
  - url: https://internal-system.example.com
    label: Internal System
output:
  notify:
    system: true
  format: markdown
```

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

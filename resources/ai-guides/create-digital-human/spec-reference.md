# App Spec Field Reference (condensed, automation-focused)

The authoritative reference is `src/main/apps/spec/PROTOCOL.md` in the Halo repository, kept in
sync with the Zod schema (`src/main/apps/spec/schema.ts`) by repo policy. This page covers what
matters when authoring `type: automation` specs through `create_automation_app`, and flags what
the tool description omits.

## Top-level shape

```
name*, description*, system_prompt*        always required
type: "automation"                          forced by create_automation_app
subscriptions?                              omit entirely for IM-only / manual-only apps
config_schema?, requires?, filters?
memory_schema?, output?, escalation?
permissions?, browser_login?
version, author                             default to "1.0" / "Halo" when omitted
```

## `subscriptions[].source.type` — status of each

| type | Works? | Notes |
|---|---|---|
| `schedule` | Yes | `every: "30m"` (duration `\d+[smhd]`) or `cron: "0 8 * * *"` (5-field). Mutually exclusive; at least one required. |
| `file` | Yes | `pattern` (glob against relative path) and/or `path` (absolute dir, substring match). Both omitted = every file change. |
| `webhook` | Yes | Mounted at `/hooks/{path}`; `secret` enables HMAC-SHA256 verification. JSON only, ≤256KB. |
| `webpage` | **No producer** | Schema-only. Use `schedule` + AI Browser polling instead. |
| `rss` | **No producer** | Schema-only. Use `schedule` + AI Browser polling instead. |
| `custom` | Free-form | `config` is unvalidated; only meaningful with a custom event source that actually emits matching events. Don't offer speculatively. |
| `wecom` | **No producer** | Schema-only. Real WeCom delivery is binding-based — see `create-digital-human/im-triggers.md`. Never use. |

`frequency: { default, min?, max? }` gives the UI a user-adjustable slider within bounds (only
meaningful for `schedule`). `config_key` wires a `config_schema` value into the trigger (e.g. a
URL); the key must exist or validation fails.

## `config_schema[]` — input types

| type | Control | Use for |
|---|---|---|
| `url` | URL input | A link the automation targets |
| `text` | Multi-line textarea | Long-form content |
| `string` | Single-line input | Short values: names, comma-separated lists, `HH:mm` times |
| `number` | Number input | Counts, thresholds, safety caps |
| `select` | Dropdown (requires `options: [{label, value}]`) | Fixed choice set |
| `boolean` | Toggle | On/off switches |
| `email` | Email input | Recipient addresses |

There is no credential type, by design. Use `browser_login` for login-gated sites.

## `permissions[]`

| id | Grants | Default |
|---|---|---|
| `ai-browser` | AI Browser web automation | ON |
| `ai-terminal` | Shell commands / interactive terminals | ON where the platform supports terminals |
| `email` | Email and calendar tools | ON, but tools load only once an email channel is configured |
| `im-push` | `notify_bot` proactive IM push | ON, but tools load only once a pushable contact exists |

Resolution order (`resolvePermission`, `src/shared/apps/app-types.ts`): explicit user deny →
explicit user grant → declared in `spec.permissions` → default `true`. **A spec can only add
capability, never remove it**; only a user opt-out in the UI disables one. Web search, memory,
and OCR are always on and not permission-gated.

## `output`

```json
"output": {
  "notify": { "system": true, "channels": ["email"] },
  "format": "Lowest price now: {price}"
}
```

- `system` — desktop toast; sent by default whenever `notify` exists unless explicitly `false`.
- `channels` — `email` / `wecom` / `dingtalk` / `feishu` / `webhook`. Credentials are configured
  once, globally, in Settings → Notification Channels; never per app, never in `config_schema`.
  Delivered only when the run does not end in `error`.
- `format` — informational only today; no runtime interpolation.
- Separately, during a run the agent may call `notify_channel` (external channel) or
  `notify_bot` (IM, needs `im-push`) for immediate pushes. `output.notify` is the end-of-run
  summary; those tools are ad hoc.

## `escalation`

```json
"escalation": { "enabled": true, "timeout_hours": 24 }
```

`enabled` defaults to `true`: the agent may pause and ask the user (status → `waiting_user`),
resuming on reply. `timeout_hours` defaults to 24; past that the run closes as `error` with a
desktop notification. Disable only when the task must always resolve autonomously. Ask the user
explicitly whenever the task performs irreversible actions.

## `memory_schema`

Descriptive guidance for the agent's own `memory.md` (no runtime validation). Use it whenever
the app must remember across runs: processed-ID lists for dedup, running counters, last-run
timestamps, consecutive-failure counts. Stored at
`{space}/.halo/apps/{appId}/memory/memory.md`, read and written by the agent each run.

## `filters`

Zero-LLM-cost pre-filtering for `file` / `webhook` events before a run starts (AND across all
rules). Not useful for `schedule` triggers — put that logic in `system_prompt`. Operators:
`eq, neq, contains, matches, gt, lt, gte, lte`.

## `requires`

```json
"requires": {
  "mcps": [{ "id": "ai-browser", "reason": "..." }],
  "skills": [{ "id": "team/some-skill", "reason": "..." }]
}
```

`requires.mcps` is mostly documentation (`ai-browser` is injected by default anyway), but real
production apps declare both it and `permissions: ["ai-browser"]`. `requires.skills` matters:
those skills are installed right after the app is created, and **a failed skill install rolls
the entire app creation back**.

## `browser_login`

```json
"browser_login": [{ "url": "https://internal.example.com", "label": "Internal System" }]
```

Declares sites the user must be logged into in their own Halo browser before the automation can
work. The correct alternative to ever asking for credentials.

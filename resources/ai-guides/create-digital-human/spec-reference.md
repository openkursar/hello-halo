# App Spec Field Reference (condensed, automation-focused)

The source of truth is the Zod schema `src/main/apps/spec/schema.ts` in the Halo repository.
`src/main/apps/spec/PROTOCOL.md` describes it in prose but has drifted from it; when the two
disagree, the schema (and this page) wins. This page covers what matters when authoring
`type: automation` specs through `create_automation_app`, and flags what the tool description
omits.

## Top-level shape

```
name*, description*, system_prompt*        always required
type: "automation"                          forced by create_automation_app
subscriptions?                              omit entirely for IM-only / manual-only apps
config_schema?, requires?, filters?
memory_schema?, escalation?                 escalation: only timeout_hours has an effect
permissions?, browser_login?
display_name?, recommended_model?
output?                                     schema-only, never read — don't write it
version, author                             default to "1.0" / "Halo" when omitted
```

## `subscriptions[].source.type` — status of each

| type | Works? | Notes |
|---|---|---|
| `schedule` | Yes | `every: "30m"` (duration `\d+[smhd]`) or `cron: "0 8 * * *"` — 5 fields, or 6 with a leading seconds field, validated by croner when the spec is saved (`schema.ts:44-60`). At least one is required; set only one — if both are present `every` wins and `cron` is ignored (`runtime/service.ts:1066-1085`). `workday_calendar: true` runs only on mainland China working days (holidays and make-up workdays included); the schedule must then fire every day, not `1-5`. |
| `file` | Yes | `pattern` (glob against the path relative to the workspace where the change happened) and/or `path` (absolute dir, substring match). The runtime adds no workspace filter (`event-filter-mapping.ts`, `runtime/service.ts:238-256`): changes in every workspace Halo watches (open in the app, or held by another file trigger) reach every file trigger, and `pattern` alone matches the same relative path in each of them. Always set `path` to a folder inside the app's own workspace. |
| `webhook` | Yes | Mounted at `/hooks/{path}`; `secret` enables HMAC-SHA256 verification. JSON only, ≤256KB. |
| `webpage` | **No producer** | Schema-only. Use `schedule` + AI Browser polling instead. |
| `rss` | **No producer** | Schema-only. Use `schedule` + AI Browser polling instead. |
| `custom` | **No producer** | `config` is unvalidated, and no built-in event source emits custom events (only the file watcher and webhook sources are registered, `runtime/index.ts:317,342`). Never use. |
| `wecom` | **No producer** | Schema-only. Real WeCom delivery is binding-based — see `create-digital-human/im-triggers.md`. Never use. |

`frequency: { default, min?, max? }` has no effect on scheduling: no code enforces `min`/`max`,
and `default` is only a fallback label in the app header (`AutomationHeader.tsx`). To change when
it runs, change `every`/`cron`. `config_key` must name an existing `config_schema` key or
validation fails (`schema.ts`, the `superRefine`), but nothing reads it afterwards — it does not
wire a value into the trigger. Don't write either.

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
| `halo-api-ref` | **Operate Halo** — Halo's own API through `halo_api_ref`: spaces, digital humans, knowledge bases, settings | **OFF** |
| `conversation-collab` | **Conversation Collaboration** — read and message the other conversations of its space, other digital humans included, with their authority | **OFF** |

Resolution order (`resolvePermission`, `src/shared/apps/app-types.ts:564-573`): explicit user
deny → explicit user grant → declared in `spec.permissions` → the default (`true` for the first
four, `false` for the last two). **A spec can only add capability, never remove it**; only a user
opt-out in the UI disables one. Declaring an OFF-by-default permission turns it on at install, so
add `halo-api-ref` or `conversation-collab` only when the task truly needs it, and tell the user.
Web search, memory, and OCR are always on and not permission-gated.

## `output`

**`output.notify` is schema-only — the runtime never reads `spec.output` at all** (repo-wide
`grep -rn "spec.output|output?.notify" src/main/apps/runtime` is zero hits). Do not put
`"output": { "notify": {...} }` in a spec and tell the user "this will send you a desktop
toast" or "this will email you" — configured this way, it silently never fires. This is the same
category as `subscriptions[].source.type: webpage`/`rss`/`wecom` above: defined in the Zod schema,
never consumed at runtime.

The real mechanisms, both entirely outside the App Spec:

- **Desktop toast** is controlled by a per-app **user override**, not a spec field —
  `app.userOverrides.notificationLevel` (`'none' | 'important' | 'all'`, default `'important'`),
  set by the user in the app's own Settings panel (**Messages & Notifications** › **System
  Notifications**, `AppConfigPanel.tsx`), read by the runtime at
  `src/main/apps/runtime/service.ts:801-804` and `report-tool.ts:357-362`. Nothing in
  `create_automation_app` can set this at creation time; if the user wants toasts, point them at
  that panel afterward.
- **External channel delivery is entirely AI-driven at runtime**, not spec-configured — during a
  run the agent decides whether to call `notify_channel` (email/wecom/dingtalk/feishu/webhook,
  credentials configured once globally in Settings → Message Channels) or `notify_bot` (IM, needs
  `permissions: ["im-push"]`). Both `service.ts:800` and `report-tool.ts:369` say this outright in
  comments: *"External channel notifications are now AI-driven via notify_channel / notify_bot
  tools."* There is no `output.notify.channels` list that pre-declares which channels a run will
  push to — that decision is made by the model, in `system_prompt`, at run time. If a task must
  reliably notify externally, say so explicitly in `system_prompt` ("call `notify_channel` with
  X when Y happens") rather than relying on a spec field that does nothing.
- `output.format` is dead for the same reason — the runtime never reads any part of `spec.output`,
  so it isn't interpolated or used to shape a reply either. Don't set it expecting any effect.

Don't write an `output` block into a spec at all; it has no effect of any kind.

## `escalation`

```json
"escalation": { "timeout_hours": 24 }
```

The agent can always pause and ask the user (a `report_to_user` escalation; status →
`waiting_user`), resuming on reply. **`enabled` is schema-only** — nothing reads it, so `false`
does not stop the agent from asking and does not make it autonomous; autonomy comes from
`system_prompt` and its config (`interview-checklist.md`, item 6). Don't write it.

`timeout_hours` is the only field with an effect: a question asked by this app expires that many
hours after it is asked, and the run then ends as `error` ("Decision deadline expired without an
answer", `runtime/store.ts:502-505`, `runtime/service.ts:1037-1054`). **There is no default for
new installs** — without `timeout_hours` a question waits until answered (only apps installed
before the change keep their old 24 h, `runtime/migrations.ts:163`). Set it when a stale answer
would be worse than none. Ask the user explicitly whenever the task performs irreversible
actions.

## `memory_schema`

Descriptive guidance for the agent's own `memory.md` (no runtime validation). Use it whenever
the app must remember across runs: processed-ID lists for dedup, running counters, last-run
timestamps, consecutive-failure counts. Stored at
`{space}/.halo/apps/{appId}/memory.md` for a digital human installed in a space (a global install
uses `{haloDir}/apps/{appId}/`; `resolveWorkDir()`, `src/main/apps/manager/service.ts:290-301`,
and `src/main/platform/memory/paths.ts:58-80`), read and written by the agent each run. The
sibling `memory/` directory (no `.md`) is the **archive** for run summaries and compaction
snapshots, not the live file — don't add an extra `memory/` segment when referencing the main
file.

## `filters`

**Schema-only.** The schema accepts `filters[] { field, op, value }` (operators `eq, neq,
contains, matches, gt, lt, gte, lte`), but the runtime never reads `spec.filters`: the event
router only applies the rules it derives from each trigger's own config (webhook `path`, file
`pattern`/`path`, `event-filter-mapping.ts`). A spec's `filters` drop nothing. Put the condition
in `system_prompt` ("if the order total is under 100, stop and report nothing") instead, and
don't promise the user a zero-cost pre-filter.

## `requires`

```json
"requires": {
  "mcps": [{ "id": "some-installed-mcp-server", "reason": "..." }],
  "skills": [{ "id": "team/some-skill", "reason": "..." }]
}
```

`requires.mcps` is a **real least-privilege gate for this app's autonomous runs — not
documentation.** Its effect depends entirely on what `id` refers to:

- **Built-in capabilities** (`ai-browser`, `ai-terminal`, `halo-email`, and the always-on
  `halo-report`/`halo-notify`/`web-search`/`ocr`) are injected based on
  `permissions[]` and other conditions (`resolvePermission()`), in *both* `execute.ts` (scheduled/
  webhook/file-triggered runs) and `app-chat.ts` (chatting with the digital human directly) —
  `requires.mcps` has **zero effect** on them either way. Listing `ai-browser` here (as a real
  bundled browser-automation app does, in its own `spec.yaml` — see
  `create-digital-human/examples.md` §3) is harmless but inert; declare
  `permissions: ["ai-browser"]` instead, which is what actually grants it.
- **User-installed MCP server apps** (installed from the App Store or added manually — real rows
  in the apps database, scoped globally or per-space) behave *differently by run mode*, and this
  is the part that actually matters:
  - **Scheduled / webhook / file-triggered runs** (`execute.ts` → `getMcpServersForRequires`):
    only servers explicitly listed in `requires.mcps` are injected — an **allowlist**. An
    installed-and-active server the space has is silently absent from the run if it isn't
    declared here, even though the same digital human's interactive chat has it.
  - **Chatting with the digital human directly** (`app-chat.ts` → `getDbMcpServers`): gets *all*
    effective MCP servers for the space by default; `requires.mcps` only matters here as a
    **denylist** — an entry with `enabled: false` excludes that specific server from chat too.
  - Practical consequence: if a digital human needs a specific installed MCP server to work when
    it runs on its own initiative (not just when you're chatting with it), that server's id
    **must** be declared in `requires.mcps`, or the autonomous run silently has fewer tools than
    a live chat with the same app would suggest.
  - The reverse also holds: a declared server (not `enabled: false`) that is **not installed,
    turned off, waiting for sign-in or failing stops the run before it starts** — no model call;
    the Work activity entry reads "Did not run: … unavailable" and names the server
    (`MissingConnectionsError`, `runtime/execute.ts:320-323`, `runtime/errors.ts:102-122`). Only
    declare servers the run truly needs, and tell the user to install or turn them on (or switch
    the entry off) in the digital human's **Tools & Resources** (工具与资源). In chat, a missing
    server is simply left out.

`requires.skills` matters unconditionally: those skills are installed right after the app is
created, and **a failed skill install rolls the entire app creation back**.

## `browser_login`

```json
"browser_login": [{ "url": "https://internal.example.com", "label": "Internal System" }]
```

Declares sites the user must be logged into in their own Halo browser before the automation can
work. The correct alternative to ever asking for credentials.

## Field table (generated)

Every field the schema accepts for `type: automation`, with what it actually does. Generated from
the app's schema for each release; when a row and the prose above disagree, the row wins.

<!-- generated:spec-fields automation agent -->
Generated from the schema of Halo 3.0.4.

| Field | Type | Req | Default / values | Effect |
|---|---|---|---|---|
| `spec_version` | `string` |  | = `"1"` | Version of the spec format. Leave it out; Halo fills in `"1"`. |
| `name` | `string` non-empty | yes | — | The name people see. For a skill it is also the folder name and the slash command, so a non-ASCII skill name is turned into an ASCII command name and the original is kept in `display_name`. |
| `display_name` | `string` |  | — | Name to show when `name` is not presentable, such as a skill named in Chinese. A matching `i18n` entry wins over it. |
| `version` | `string` version | yes | — | Your version of the package, such as `1.0.0`. A Store update must carry a higher version. |
| `author` | `string` non-empty | yes | — | Who made it. When published, it becomes the namespace of the Store address, `<author>/<name>`. Optional for skills. |
| `description` | `string` non-empty | yes | — | One or two sentences on what it does, shown in lists and the Store. |
| `icon` | `string` |  | — | An emoji or an image URL. Anything else falls back to the type icon; a Digital Human without an icon gets a generated avatar. |
| `permissions` | `string[]` |  | — | Capabilities to turn on at install: `ai-browser`, `ai-terminal`, `email`, `im-push` (on by default anyway), `halo-api-ref` (Operate Halo) and `conversation-collab` (Conversation Collaboration), both off by default. A spec can only add a capability; the user can still turn any of them off. |
| `requires` | `object` |  | — | MCP servers and skills it depends on. |
| `requires.mcps` | `object[]` |  | — | MCP servers it uses. Runs get only the servers listed here, and a run doesn't start while one of them is not installed, turned off, waiting for sign-in or failing. A chat gets every server of its workspace and the global ones, except those marked `enabled: false`. |
| `requires.mcps[].id` | `string` non-empty | yes | — | Id of an installed MCP server. |
| `requires.mcps[].reason` | `string` |  | — | Why it needs the server, shown next to the dependency. |
| `requires.mcps[].bundled` | `boolean` |  | — | SCHEMA-ONLY, no effect. Meant to mark an MCP server shipped inside the package. |
| `requires.mcps[].enabled` | `boolean` |  | — | `false` keeps the declaration but stops this Digital Human from using the server, in runs and in chat. The server itself stays on for everyone else. |
| `requires.skills` | `(string \| object)[]` |  | — | Skills to install together with it, as ids or objects. Every skill in its workspace or global scope is available to it anyway; this list only decides what gets installed. |
| `requires.skills[].id` | `string` non-empty | yes | — | Skill id. |
| `requires.skills[].reason` | `string` |  | — | Why it needs the skill. |
| `requires.skills[].bundled` | `boolean` |  | — | `true` when the skill ships inside the package under `skills/<id>/` rather than coming from the Store. |
| `requires.skills[].files` | `string[]` |  | — | For a bundled skill, its files relative to `skills/<id>/`, such as `SKILL.md` and `index.js`. |
| `config_schema` | `object[]` |  | — | The settings form the user fills in at install and can change later. Every run and chat hands the Digital Human the current values by `key`, with defaults filled in. |
| `config_schema[].key` | `string` non-empty | yes | — | Unique key of the setting. |
| `config_schema[].label` | `string` non-empty | yes | — | Label shown on the form. |
| `config_schema[].type` | `enum` | yes | `url`, `text`, `string`, `number`, `select`, `boolean`, `email` | Input control. `text` is multi-line, `string` single-line. There is no password or secret type, because the values are passed to the AI as plain text: for sites that need a login, use `browser_login`. |
| `config_schema[].description` | `string` |  | — | Help text under the field. |
| `config_schema[].required` | `boolean` |  | — | Marks the field as required on the form. |
| `config_schema[].default` | `any` |  | — | Value filled in until the user changes it. |
| `config_schema[].placeholder` | `string` |  | — | Hint shown in an empty field. |
| `config_schema[].options` | `object[]` |  | — | Choices of a `select` field, at least one. |
| `config_schema[].options[].label` | `string` non-empty | yes | — | Text of the choice. |
| `config_schema[].options[].value` | `string \| number \| boolean` | yes | — | Value stored when it is chosen. |
| `store` | `object` |  | — | Store listing details, used when the package is published or installed from a store. |
| `store.slug` | `string` |  | — | Store address of the package. Publishing sets it to `<author>/<name>` for you. |
| `store.category` | `string` |  | — | Store category it is listed under. |
| `store.tags` | `string[]` |  | = `[]` | Tags that help people find it in the Store. |
| `store.locale` | `string` |  | — | Main language of the package, as a language tag such as `zh-CN`. |
| `store.min_app_version` | `string` |  | — | Oldest Halo version it is meant for. The Store shows it; Halo does not block older versions. |
| `store.license` | `string` |  | — | License, as an SPDX identifier such as `MIT`. Kept with the package. |
| `store.homepage` | `string` url |  | — | Project homepage. Kept with the package. |
| `store.repository` | `string` url |  | — | Source repository. Kept with the package. |
| `i18n` | `map<string, object>` |  | — | Translations of the name, description, settings form and login labels, keyed by language tag such as `en` or `zh-CN`. |
| `i18n.<locale>.name` | `string` |  | — | Translated name. |
| `i18n.<locale>.description` | `string` |  | — | Translated description. |
| `i18n.<locale>.config_schema` | `map<string, object>` |  | — | Translations of settings fields, keyed by the field `key`. |
| `i18n.<locale>.config_schema.<key>.label` | `string` |  | — | Translated label. |
| `i18n.<locale>.config_schema.<key>.description` | `string` |  | — | Translated help text. |
| `i18n.<locale>.config_schema.<key>.placeholder` | `string` |  | — | Translated placeholder. |
| `i18n.<locale>.config_schema.<key>.options` | `map<string, string>` |  | — | Translated choice labels, keyed by the choice value. |
| `i18n.<locale>.browser_login` | `map<string, object>` |  | — | Translated login labels, keyed by the `browser_login` URL. |
| `i18n.<locale>.browser_login.<key>.label` | `string` |  | — | Translated label. |
| `type` | `literal` | yes | `automation` | Kind of package: `automation` (a Digital Human), `mcp`, `skill`, or `extension` (reserved). |
| `system_prompt` | `string` non-empty | yes | — | The Digital Human's instructions: its role, its steps, what it must never do and when to ask. Everything it does on its own follows from this text. |
| `subscriptions` | `object[]` |  | — | When it runs on its own. Leave it out for a Digital Human that only answers chats and messages from bots. |
| `subscriptions[].id` | `string` |  | — | Id of this trigger, unique in the spec. Without one, triggers are numbered `0`, `1`, … in order. |
| `subscriptions[].source` | `object` | yes | — | What starts a run. |
| `subscriptions[].source.type` | `enum` | yes | `schedule`, `file`, `webhook`, `webpage`, `rss`, `custom`, `wecom` | `schedule`, `file` and `webhook` start runs. `webpage`, `rss`, `custom` and `wecom` are accepted but nothing produces their events. Messages to a bot reach a Digital Human through its bot binding, not through a trigger. |
| `subscriptions[].source.config` (schedule) | `object` | yes | — | When to run: `every` or `cron`. |
| `subscriptions[].source.config.every` (schedule) | `string` duration |  | — | Interval such as `30m`, `2h` or `1d` (units `s`, `m`, `h`, `d`). If both `every` and `cron` are set, `every` wins. |
| `subscriptions[].source.config.cron` (schedule) | `string` cron |  | — | Cron expression with 5 fields, or 6 with seconds first, such as `0 9 * * 1-5`. It is checked when the spec is saved. |
| `subscriptions[].source.config.workday_calendar` (schedule) | `boolean` |  | — | `true` runs only on mainland China working days, including make-up workdays, and skips public holidays. Use it with a schedule that fires every day, not `1-5`. |
| `subscriptions[].source.config` (file) | `object` | yes | — | Which file changes start a run. |
| `subscriptions[].source.config.pattern` (file) | `string` |  | — | Glob matched against the changed file's path inside its own workspace, such as `inbox/*.csv`. It matches the same path in every workspace Halo watches, not only this one. |
| `subscriptions[].source.config.path` (file) | `string` |  | — | Folder whose files count, matched as part of the absolute path. Halo does not limit a file trigger to the Digital Human's own workspace: changes in any workspace it watches (those open in the app and those of other file triggers) count. Set `path` to a folder inside this workspace to keep the trigger there. |
| `subscriptions[].source.config` (webhook) | `object` | yes | — | An HTTP endpoint at `/hooks/<path>` that other systems post JSON events to. |
| `subscriptions[].source.config.path` (webhook) | `string` |  | — | Path after `/hooks/`. Use lower case and a path no other Digital Human uses. |
| `subscriptions[].source.config.secret` (webhook) | `string` |  | — | Shared secret for the HMAC-SHA256 signature every request must carry. Without it, anyone who can reach Halo can start the Digital Human. |
| `subscriptions[].source.config` (webpage) | `object` | yes | — | NO PRODUCER, never fires. Meant to watch a web page for changes. To check a page, use a `schedule` and let the Digital Human open it in the AI Browser. |
| `subscriptions[].source.config.watch` (webpage) | `string` |  | — | NO PRODUCER, never fires. What to watch on the page. |
| `subscriptions[].source.config.selector` (webpage) | `string` |  | — | NO PRODUCER, never fires. CSS selector to focus on. |
| `subscriptions[].source.config.url` (webpage) | `string` |  | — | NO PRODUCER, never fires. Page URL. |
| `subscriptions[].source.config` (rss) | `object` | yes | — | NO PRODUCER, never fires. Meant to follow an RSS feed. Use a `schedule` that reads the feed instead. |
| `subscriptions[].source.config.url` (rss) | `string` |  | — | NO PRODUCER, never fires. Feed URL. |
| `subscriptions[].source.config` (custom) | `map<string, any>` | yes | — | NO PRODUCER, never fires. Free-form settings for a custom event source. Halo has none built in. |
| `subscriptions[].source.config` (wecom) | `object` | yes | — | NO PRODUCER, never fires. Meant for WeCom messages. To have a Digital Human answer a WeCom bot, bind the bot to it in Settings › Message Channels. |
| `subscriptions[].source.config.chatId` (wecom) | `string` |  | — | NO PRODUCER, never fires. Chat to listen to. |
| `subscriptions[].frequency` | `object` |  | — | Meant as the range of intervals a user may pick. Halo does not enforce it. |
| `subscriptions[].frequency.default` | `string` duration | yes | — | Suggested interval. It does not change when runs happen: set the schedule's `every` or `cron` for that. |
| `subscriptions[].frequency.min` | `string` duration |  | — | SCHEMA-ONLY, no effect. Meant as the shortest interval a user may pick. |
| `subscriptions[].frequency.max` | `string` duration |  | — | SCHEMA-ONLY, no effect. Meant as the longest interval a user may pick. |
| `subscriptions[].config_key` | `string` |  | — | SCHEMA-ONLY, no effect. Meant to feed a setting into the trigger. It must name an existing `config_schema` key, or the spec is rejected, but the value is never used. |
| `filters` | `object[]` |  | — | SCHEMA-ONLY, no effect. Meant as rules that drop events before a run starts. Put such conditions in the system prompt instead. |
| `filters[].field` | `string` non-empty | yes | — | SCHEMA-ONLY, no effect. Event field to test. |
| `filters[].op` | `enum` | yes | `eq`, `neq`, `contains`, `matches`, `gt`, `lt`, `gte`, `lte` | SCHEMA-ONLY, no effect. Comparison. |
| `filters[].value` | `any` | yes | — | SCHEMA-ONLY, no effect. Value to compare with. |
| `memory_schema` | `map<string, object>` |  | — | What the Digital Human should keep in its memory file between runs, such as processed ids or a last-run time. It guides the AI; nothing checks it. |
| `memory_schema.<field>.type` | `string` non-empty | yes | — | Kind of value, as a hint such as `string`, `number`, `date` or `array`. |
| `memory_schema.<field>.description` | `string` |  | — | What the entry holds and how to update it. |
| `output` | `object` |  | — | SCHEMA-ONLY, no effect. Meant to configure notifications and output format. Ask for notifications in the system prompt instead: the Digital Human sends them through the notification channels set up in Settings. |
| `output.notify` | `object` |  | — | SCHEMA-ONLY, no effect. Notification settings. |
| `output.notify.system` | `boolean` |  | — | SCHEMA-ONLY, no effect. Desktop notifications. The user sets them per Digital Human under Messages & Notifications › System Notifications. |
| `output.notify.channels` | `enum[]` |  | `email`, `wecom`, `dingtalk`, `feishu`, `webhook` | SCHEMA-ONLY, no effect. Notification channels. |
| `output.format` | `string` |  | — | SCHEMA-ONLY, no effect. Output format. |
| `escalation` | `object` |  | — | How long its questions wait for an answer. The Digital Human can always stop and ask. |
| `escalation.enabled` | `boolean` |  | — | SCHEMA-ONLY, no effect. `false` does not stop it from asking, and `true` changes nothing. How far it may act alone comes from the system prompt. |
| `escalation.timeout_hours` | `number` |  | > 0 | Hours a question waits before it expires; the run then ends as failed. Without it, a question waits until someone answers. |
| `recommended_model` | `string` |  | — | Model to suggest. Shown as a hint where the user picks the model; it does not switch the model. |
| `browser_login` | `object[]` |  | — | Websites the user must be signed in to in the AI Browser before it can work. Halo asks the user to sign in; the Digital Human never sees the password. |
| `browser_login[].url` | `string` url | yes | — | Sign-in page. |
| `browser_login[].label` | `string` non-empty | yes | — | Name of the site, shown to the user. |
<!-- /generated:spec-fields -->

# Halo App Spec Protocol — Complete Field Reference

> **Authoritative source**: This document is derived directly from `src/main/apps/spec/schema.ts` (Zod schema) and is fully consistent with the runtime.
> This document must be updated in sync with every change to `schema.ts`.
>
> Audience: internal developers, product managers, external contributors.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Top-level Fields](#2-top-level-fields)
3. [subscriptions — Trigger Sources](#3-subscriptions--trigger-sources)
4. [config_schema — User Configuration](#4-config_schema--user-configuration)
5. [requires — Dependency Declaration](#5-requires--dependency-declaration)
6. [filters — Pre-execution Event Filtering](#6-filters--pre-execution-event-filtering)
7. [memory_schema — AI Memory Structure](#7-memory_schema--ai-memory-structure)
8. [output — Output and Notifications](#8-output--output-and-notifications)
9. [escalation — Human Escalation](#9-escalation--human-escalation)
10. [mcp_server — MCP Server (type=mcp only)](#10-mcp_server--mcp-server-typemcp-only)
11. [store — Store Metadata](#11-store--store-metadata)
12. [i18n — Localization Overrides](#12-i18n--localization-overrides)
13. [permissions — Permission Declaration](#13-permissions--permission-declaration)
14. [Type Constraints Summary](#14-type-constraints-summary)
15. [Field Aliases (Backward Compatibility)](#15-field-aliases-backward-compatibility)
16. [Complete Examples](#16-complete-examples)

---

## 1. Overview

Each App is described by a YAML file (`spec.yaml`). It is parsed by `parseAndValidateAppSpec()` and
becomes an `AppSpec` object. The Zod schema is the single source of truth; all TypeScript types are
derived via `z.infer<>`.

### App Types

| `type` value | Description | Requires `system_prompt` | Requires `mcp_server` | Can have `subscriptions` |
|---|---|---|---|---|
| `automation` | A digital human that runs automatically in the background | ✅ | ✗ | ✅ (optional — apps with no subscriptions are IM/manual-only) |
| `skill` | A capability invoked on demand by the user | ✅ | ✗ | ✗ |
| `mcp` | Wraps an MCP server | ✗ | ✅ | ✗ |
| `extension` | Extension / theme | ✗ | ✗ | ✗ |

---

## 2. Top-level Fields

```yaml
spec_version: "1"          # optional, defaults to "1"
name: "Price Hunter"
version: "1.0.0"
author: "alice"
description: "Monitors product prices and notifies when the target price is reached"
type: automation
icon: "shopping"           # optional
system_prompt: |           # required for automation/skill
  You are a price-monitoring agent ...
```

| Field | Type | Required | Description |
|---|---|---|---|
| `spec_version` | `string` | No | Defaults to `"1"`. Incremented on breaking changes. |
| `name` | `string` (non-empty) | **Yes** | Display name of the App. Duplicate names within the same Space are rejected. |
| `version` | `string` (non-empty) | **Yes** | Semantic version, loosely validated — e.g. `"1.0"`, `"1.0.0"`, `"0.1-beta"`. |
| `author` | `string` (non-empty) | **Yes** | Author name or organization. |
| `description` | `string` (non-empty) | **Yes** | A single sentence describing what the App does. |
| `type` | `"automation" \| "skill" \| "mcp" \| "extension"` | **Yes** | Determines runtime behavior; see table above. |
| `icon` | `string` | No | Icon identifier (e.g. `"shopping"`, `"news"`) or an image URL. |
| `system_prompt` | `string` | **Required** when `type=automation` or `type=skill` | The core instruction for the AI — the "soul" of the digital human. Injected into the system prompt on every run. |
| `subscriptions` | `SubscriptionDef[]` | Optional when `type=automation` | List of trigger sources; see Section 3. Allowed only for `automation`. When omitted, the app operates in IM/manual-trigger-only mode. |
| `config_schema` | `InputDef[]` | No | Configuration fields presented to the user at install time; see Section 4. |
| `requires` | `Requires` | No | Declares MCP and Skill dependencies; see Section 5. |
| `filters` | `FilterRule[]` | No | Pre-execution event filter rules; see Section 6. |
| `memory_schema` | `Record<string, MemoryField>` | No | AI memory file structure declaration. Allowed only for `automation`; see Section 7. |
| `output` | `OutputConfig` | No | Notification configuration after a run completes; see Section 8. |
| `escalation` | `EscalationConfig` | No | Human escalation configuration; see Section 9. |
| `mcp_server` | `McpServerConfig` | **Required** when `type=mcp` | MCP server startup configuration. Allowed only for `mcp`; see Section 10. |
| `permissions` | `string[]` | No | Permission declaration; see Section 13. |
| `recommended_model` | `string` | No | Model recommended by the author (informational only — not used at runtime). |
| `store` | `StoreMetadata` | No | Store/registry distribution metadata; see Section 11. |
| `i18n` | `Record<string, I18nLocaleBlock>` | No | Locale-specific display text overrides for `name`, `description`, and `config_schema` labels. Keys are BCP 47 locale tags. See Section 12. |

---

## 3. `subscriptions` — Trigger Sources

`subscriptions` is an array of `SubscriptionDef` objects, each defining when the App should be
triggered. **Allowed only when `type=automation`** — other types will fail validation if this field
is present.

### 3.1 SubscriptionDef Structure

```yaml
subscriptions:
  - id: "price-check"          # optional, unique within the spec
    source:                    # required
      type: schedule           # see 3.2
      config:
        every: "30m"
    frequency:                 # optional
      default: "30m"
      min: "10m"
      max: "6h"
    config_key: "product_url"  # optional, references a key in config_schema
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | No | Unique within the spec. When omitted, the runtime auto-generates `sub-0`, `sub-1`, etc. Used by `userOverrides.frequency[id]` to let users override the schedule. |
| `source` | `SubscriptionSource` | **Yes** | Trigger source — a discriminated union; see 3.2. |
| `frequency` | `FrequencyDef` | No | User-adjustable frequency range. When set, the UI displays a frequency slider constrained to this range. |
| `config_key` | `string` | No | References a `config_schema` field key. The user-supplied value is passed as dynamic input to this trigger source (e.g. a URL). Must match an existing key in `config_schema`, otherwise validation fails. |

### 3.2 Source Types

`source` is a discriminated union resolved by `source.type`.

#### `schedule` — Timer Trigger

```yaml
source:
  type: schedule
  config:
    every: "1h"        # interval trigger — mutually exclusive with cron (at least one required)
    cron: "0 8 * * *"  # cron expression — mutually exclusive with every
```

| config field | Type | Description |
|---|---|---|
| `every` | duration string | Interval duration. Format: `digits + s/m/h/d`, e.g. `"30m"`, `"2h"`, `"1d"`, `"10s"`. Mutually exclusive with `cron`; at least one must be present. |
| `cron` | string (≥5 chars) | Standard 5-field cron expression, e.g. `"0 8 * * *"` (daily at 08:00). Mutually exclusive with `every`. |

> **Runtime behavior**: `every` creates a fixed-interval scheduled task; `cron` creates a cron-based
> scheduled task. Users can override the `every` value via `userOverrides.frequency[subscriptionId]`.

---

#### `file` — File Change Trigger

```yaml
source:
  type: file
  config:
    pattern: "src/**/*.ts"       # glob pattern, optional
    path: "/home/user/project"   # directory to watch, optional
```

| config field | Type | Description |
|---|---|---|
| `pattern` | string | Glob pattern matched against the relative path of the changed file. E.g. `"src/**/*.ts"` matches all TypeScript files. |
| `path` | string | Absolute path of the directory to watch. Triggers when `payload.filePath` contains this string. |

> **Runtime behavior**: File system changes (created/changed/deleted) are produced by
> `FileWatcherSource` as `file.*` events. `pattern` matches against `payload.relativePath` (glob
> match); `path` matches against `payload.filePath` (substring match). When both fields are omitted,
> all file changes trigger the App.

---

#### `webhook` — Webhook Trigger

```yaml
source:
  type: webhook
  config:
    path: "github-pr"         # mounted at /hooks/github-pr, optional
    secret: "my-secret-key"   # HMAC-SHA256 verification secret, optional
```

| config field | Type | Description |
|---|---|---|
| `path` | string | Webhook path, mounted under `/hooks/{path}`. Triggers on POST requests to this path. When omitted, all paths are accepted. |
| `secret` | string | HMAC-SHA256 signing secret. When provided, the `x-hub-signature-256` or `x-webhook-signature` request header is verified. Returns 401 if verification fails. |

> **Runtime behavior**: `WebhookSource` registers a `POST /hooks/*` route on the Express server and
> produces `webhook.received` events. `path` matches against `payload.path` (exact match).

---

#### `webpage` — Web Page Content Change Trigger

```yaml
source:
  type: webpage
  config:
    watch: "price-element"   # description of what to watch, optional
    selector: ".price"       # CSS selector, optional
    url: "https://..."       # target URL, optional — usually provided via config_key
```

| config field | Type | Description |
|---|---|---|
| `watch` | string | Description of what to monitor, e.g. `"price-element"`, `"full-page"`. |
| `selector` | string | CSS selector to focus on a specific part of the page. |
| `url` | string | Target page URL. Prefer referencing a user-supplied URL via `config_key` rather than hardcoding it here. |

> **Current implementation status**: The `webpage` source type is fully defined at the schema level
> and the runtime registers a listener for `webpage.changed` events. **The event producer
> (WebPageSource) is a V2 planned feature and is not yet implemented.** Use AI Browser with a
> `schedule` polling subscription as an equivalent alternative.

---

#### `rss` — RSS Feed Trigger

```yaml
source:
  type: rss
  config:
    url: "https://news.ycombinator.com/rss"  # RSS feed URL, optional
```

| config field | Type | Description |
|---|---|---|
| `url` | string | URL of the RSS feed. |

> **Current implementation status**: The `rss` source type is defined at the schema level and the
> runtime registers a listener for `rss.updated` events. **The event producer (RssSource) is a V2
> planned feature and is not yet implemented.** Use AI Browser with a `schedule` subscription to
> poll the RSS URL as an equivalent alternative.

---

#### `custom` — Custom Trigger

```yaml
source:
  type: custom
  config:
    provider: "my-provider"
    key: "any-value"
```

`config` is a free-form `Record<string, unknown>`. No field-level validation is performed — the
custom event source is responsible for interpreting the config.

---

### 3.3 `frequency` — Frequency Range

```yaml
frequency:
  default: "30m"   # required
  min: "10m"       # optional — user cannot set an interval shorter than this
  max: "6h"        # optional — user cannot set an interval longer than this
```

All fields are duration strings: `digits + s/m/h/d` (e.g. `"10s"`, `"30m"`, `"2h"`, `"1d"`).

| Field | Type | Required | Description |
|---|---|---|---|
| `default` | duration string | **Yes** | Default execution frequency. |
| `min` | duration string | No | Lower bound on user-configurable interval. |
| `max` | duration string | No | Upper bound on user-configurable interval. |

---

## 4. `config_schema` — User Configuration

The configuration form presented to the user when installing the App. At runtime, the values
supplied by the user are stored as `userConfig` and injected into the AI's initial message on every
run.

```yaml
config_schema:
  - key: product_url
    label: "Product URL"
    type: url
    required: true
    placeholder: "https://www.amazon.com/dp/..."
    description: "Enter the product page URL"

  - key: target_price
    label: "Target Price"
    type: number
    required: true
    default: 999

  - key: notify_format
    label: "Notification Format"
    type: select
    options:
      - label: "Brief"
        value: brief
      - label: "Detailed"
        value: detailed
```

Fields of each `config_schema` entry:

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | `string` (non-empty) | **Yes** | Unique identifier. `userConfig[key]` stores the user-supplied value. Can be referenced by `subscriptions[].config_key`. |
| `label` | `string` (non-empty) | **Yes** | Field label displayed in the UI. |
| `type` | `InputType` (see below) | **Yes** | Field type, determines the UI control. |
| `description` | `string` | No | Help text displayed below the field. |
| `required` | `boolean` | No | Defaults to `false`. When `true`, the user must fill in this field to complete installation. |
| `default` | `any` | No | Default value, pre-filled into the control. |
| `placeholder` | `string` | No | Input placeholder text. |
| `options` | `SelectOption[]` | **Required** when `type=select` | Dropdown option list. Ignored when `type` is not `select`. |

### InputType Enum

| Value | UI Control | Description |
|---|---|---|
| `url` | URL input | Basic URL format validation applied. |
| `text` | Multi-line textarea | Suitable for long-form text. |
| `string` | Single-line text input | General-purpose string. |
| `number` | Number input | Numeric value. |
| `select` | Dropdown select | Must be used with `options`. |
| `boolean` | Toggle / checkbox | Boolean value. |
| `email` | Email input | Basic email format validation applied. |

### SelectOption Structure

```yaml
options:
  - label: "Brief"      # display text, non-empty string
    value: brief        # stored value — string | number | boolean
```

---

## 5. `requires` — Dependency Declaration

Declares the external capabilities required by the App at runtime. Displayed to the user at install
time; the runtime uses this to decide which MCP servers to inject.

```yaml
requires:
  mcps:
    - id: ai-browser
      reason: "Used for web interaction and data extraction"
    - id: postgres-mcp
      bundled: true
  skills:
    - price-analysis                   # shorthand form
    - id: data-cleaner                 # object form
      reason: "Data normalization"
      bundled: true
```

### MCP Dependencies (`requires.mcps`)

Each element is a `McpDependency`:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (non-empty) | **Yes** | MCP server identifier, e.g. `"ai-browser"`, `"postgres-mcp"`. |
| `reason` | `string` | No | Human-readable explanation of why this MCP is needed. Shown to the user at install time. |
| `bundled` | `boolean` | No | Whether this MCP is provided as a bundled package (V2 feature). |

> **Note**: `ai-browser` is a built-in MCP. When declared, the runtime automatically injects AI
> Browser tools. Even without an explicit declaration, it is injected by default (`resolvePermission`
> uses `defaultValue=true`). Use `permissions` to explicitly opt out.

### Skill Dependencies (`requires.skills`)

Each element is a `SkillDependency`, accepted in two forms:

```yaml
skills:
  - price-analysis            # shorthand: skill name as a plain string
  - id: data-cleaner          # object form
    reason: "Data normalization"
    bundled: true
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | `string` (non-empty) | **Yes** (object form) | Skill identifier. |
| `reason` | `string` | No | Explanation of why this skill is needed. |
| `bundled` | `boolean` | No | Whether the skill files are co-located inside the package's `skills/{id}/` directory. When `true`, the runtime fetches files directly from the package instead of querying the store. |
| `files` | `string[]` | No (required when `bundled: true`) | Relative file paths within the `skills/{id}/` directory. Supports nested paths (e.g. `lib/utils.js`). Used by the adapter to download files via static URLs at install time. |

---

## 6. `filters` — Pre-execution Event Filtering

Zero-LLM-cost rule evaluation performed before the AI runs. Events that do not satisfy all rules are
discarded without starting an AI run.

```yaml
filters:
  - field: price_change_percent
    op: gt
    value: 5
  - field: payload.extension
    op: eq
    value: ".ts"
```

Fields of each rule:

| Field | Type | Required | Description |
|---|---|---|---|
| `field` | `string` (non-empty) | **Yes** | Field path on the event object. Supports dot notation and array indices, e.g. `"payload.price"`, `"payload.items[0].name"`. |
| `op` | `FilterOp` (see below) | **Yes** | Comparison operator. |
| `value` | `any` | **Yes** | Comparison value; type depends on `op`. |

### FilterOp Enum

All rules are combined with **AND logic** — the event is accepted only when all rules pass.

| `op` value | Meaning | `value` type |
|---|---|---|
| `eq` | Strict equality (`===`) | any |
| `neq` | Strict inequality (`!==`) | any |
| `contains` | String contains substring, or array contains element | `string` (substring) or any (array element) |
| `matches` | String matches regex (`new RegExp(value).test(field)`) | `string` (regular expression) |
| `gt` | Numeric greater than | `number` |
| `lt` | Numeric less than | `number` |
| `gte` | Numeric greater than or equal | `number` |
| `lte` | Numeric less than or equal | `number` |

> **Note**: `filters` are primarily applied on the event-triggered path (file / webhook /
> event-bus). For `schedule`-triggered Apps, encoding filter logic in `system_prompt` is more
> appropriate.

---

## 7. `memory_schema` — AI Memory Structure

Declares the data structure the AI should persist in its `memory.md` file. This is guidance for the
AI — not strict schema validation — used by the AI to determine the structure and content of the
memory file.

**Allowed only when `type=automation`.**

```yaml
memory_schema:
  price_history:
    type: array
    description: "Historical price records (with timestamps)"
  last_low_date:
    type: date
    description: "Date of the last detected price low"
  purchase_decision:
    type: string
    description: "Buy / wait decision and rationale"
```

`memory_schema` is a `Record<string, MemoryField>`. The key is the field name; the value is:

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | `string` (non-empty) | **Yes** | Data type description, e.g. `"string"`, `"number"`, `"array"`, `"date"`, `"boolean"`, `"object"`. Purely descriptive — no runtime validation is performed. |
| `description` | `string` | No | Field description to help the AI understand the field's purpose. |

> **Runtime behavior**: The memory file is stored at `{space.path}/.halo/apps/{appId}/memory/memory.md`.
> The AI reads this file before each run and writes a summary after the run.

---

## 8. `output` — Output and Notifications

Controls the notification behavior after a run completes.

```yaml
output:
  notify:
    system: true                              # desktop system notification
    channels:                                # external notification channels
      - email
      - wecom
  format: "Current lowest price: {price} — {trend}"  # output format template (informational)
```

### `output.notify`

| Field | Type | Description |
|---|---|---|
| `system` | `boolean` | Whether to send a system desktop notification. Default behavior: sent when a `notify` object is present and `system` is not explicitly `false`. Set to `false` to suppress desktop notifications. |
| `channels` | `NotificationChannelType[]` | List of external notification channels to push to (see below). Channel credentials are configured by the user in **Settings > Notification Channels** and are not stored in the spec. |

### NotificationChannelType Enum

| Value | Channel |
|---|---|
| `email` | Email |
| `wecom` | WeCom (Enterprise WeChat) |
| `dingtalk` | DingTalk |
| `feishu` | Feishu (Lark) |
| `webhook` | Generic HTTP Webhook |

> **Runtime behavior**: `output.notify` is only sent when the run result is not `error`.
> The content is taken from the `summary` field of the most recent `run_complete` activity entry.
> The AI can also call `mcp__halo-notify__send_notification` during a run to send immediate
> notifications.

### `output.format`

```yaml
output:
  format: "Current lowest price: {price} — {trend_analysis}"
```

A format template string. Currently informational (displayed in the UI) — no interpolation is
performed at runtime.

---

## 9. `escalation` — Human Escalation

Controls the App's behavior when the AI encounters a situation that requires a human decision.

```yaml
escalation:
  enabled: true      # whether the AI may pause and ask the user; defaults to true
  timeout_hours: 48  # hours before an unanswered escalation times out; defaults to 24
```

| Field | Type | Description |
|---|---|---|
| `enabled` | `boolean` | Defaults to `true`. When enabled, the AI may pause execution to ask the user a question and resume once they respond. Set to `false` to disable escalation (the AI must make decisions autonomously). |
| `timeout_hours` | `number` (positive) | If the user does not respond within this many hours, the escalation is automatically closed and the App status switches to `error`. Defaults to 24 hours. |

> **App status flow**:
> - AI raises an escalation → App status: `waiting_user`
> - User responds → follow-up run continues
> - Timeout with no response → App status: `error`, desktop notification pushed

---

## 10. `mcp_server` — MCP Server (type=mcp only)

Defines how to start an MCP server process. The format is fully compatible with the `mcpServers`
configuration of the Claude Code SDK.

**Allowed only when `type=mcp`** — other types will fail validation if this field is present.

```yaml
type: mcp
mcp_server:
  command: npx
  args:
    - "-y"
    - "@modelcontextprotocol/server-postgres"
  env:
    DATABASE_URL: "{{config.database_url}}"
  cwd: "/optional/working/dir"
```

| Field | Type | Required | Description |
|---|---|---|---|
| `command` | `string` (non-empty) | **Yes** | Command to start the MCP server, e.g. `"npx"`, `"python"`, `"node"`. |
| `args` | `string[]` | No | Command-line argument list. |
| `env` | `Record<string, string>` | No | Environment variables. Values may use `{{config.key}}` to reference user configuration (template interpolation is handled at runtime). |
| `cwd` | `string` | No | Process working directory (absolute path). |

---

## 11. `store` — Store Metadata

Used for distributing and discovering Apps via the App Store registry. Local Apps do not need to
populate this field.

```yaml
store:
  slug: "price-hunter"              # URL-safe unique identifier
  category: shopping                # category
  tags: ["price", "amazon", "alert"]
  locale: en-US                     # primary language (BCP 47)
  min_app_version: "0.5.0"         # minimum required client version
  license: MIT                      # SPDX license identifier
  homepage: "https://..."
  repository: "https://..."
  registry_id: official             # set automatically at install time — do not set manually
```

| Field | Type | Required | Description |
|---|---|---|---|
| `slug` | `string` | No | URL-safe identifier. Format: lowercase letters, digits, internal hyphens — e.g. `"price-hunter"`. Must match the bundle directory name. |
| `category` | `string` | No | Category. Recommended values: `shopping`, `news`, `content`, `dev-tools`, `productivity`, `data`, `social`, `other`. |
| `tags` | `string[]` | No | Free-form tags for search/discovery. Defaults to `[]`. |
| `locale` | `string` | No | BCP 47 language tag, e.g. `"en-US"`, `"zh-CN"`. |
| `min_app_version` | `string` | No | Minimum Halo client version required to run this App. |
| `license` | `string` | No | SPDX license identifier, e.g. `"MIT"`, `"Apache-2.0"`. |
| `homepage` | `string` (URL) | No | Product homepage URL. |
| `repository` | `string` (URL) | No | Source repository URL. |
| `registry_id` | `string` | No | Source registry ID. Automatically written by the registry service at install time — spec authors should not set this manually. |

---

## 12. `i18n` — Localization Overrides

Provides locale-specific overrides for display text shown in the App Store and installation forms.
The canonical (top-level) `name`, `description`, and `config_schema` labels are the authoritative
source (always written in English). The `i18n` block lets authors supply translations without
duplicating the full spec.

**Only display text is translated.** `system_prompt`, `store` metadata, subscription config,
and all runtime behavior are never overridden by `i18n`.

```yaml
i18n:
  zh-CN:
    name: 京东价格猎手
    description: 监控京东商品页面的价格变动，在价格达到目标值或出现新低时发送通知，并避免重复提醒。
    config_schema:
      product_url:
        label: 商品链接
        description: 京东商品详情页链接
        placeholder: "https://item.jd.com/..."
      target_price:
        label: 目标价格
        description: 价格降至此值或以下时触发通知
      output_language:
        label: 输出语言
        options:
          en-US: 英文
          zh-CN: 中文
```

### `I18nLocaleBlock` Structure

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | No | Translated display name. Falls back to canonical `name` when absent. |
| `description` | `string` | No | Translated description. Falls back to canonical `description` when absent. |
| `config_schema` | `Record<string, I18nConfigFieldOverride>` | No | Keyed by `config_schema[].key`. Only fields that need translation need to be listed. |

### `I18nConfigFieldOverride` Structure

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | `string` | No | Translated field label. Falls back to canonical `label`. |
| `description` | `string` | No | Translated help text. Falls back to canonical `description`. |
| `placeholder` | `string` | No | Translated placeholder text. Falls back to canonical `placeholder`. |
| `options` | `Record<string, string>` | No | Map of option `value` (as string) → translated label. Only explicitly listed values are overridden; others fall back to canonical option labels. |

### Locale Resolution (Runtime)

Halo resolves display text using this priority order:

1. **Exact locale match** — e.g. `i18n["zh-CN"]` for a user with locale `zh-CN`
2. **Language-prefix match** — e.g. `i18n["zh-CN"]` also applied for `zh-TW` when no `zh-TW`
   block exists and `zh-CN` is the only `zh-*` block
3. **Canonical fallback** — the top-level `name` / `description` / `config_schema` labels (English)

> **Note**: The `i18n` block only applies to the store UI and install form. The agent's output
> language is controlled separately via `config_schema` (e.g. an `output_language` select field
> whose value is injected into the `system_prompt` context at runtime).

---

## 13. `permissions` — Permission Declaration

Declares the runtime permissions required by the App.

```yaml
permissions:
  - ai-browser
  - notification.send
```

`permissions` is a `string[]` of permission identifiers. Currently known permissions:

| Permission identifier | Description |
|---|---|
| `ai-browser` | Allows the App to use AI Browser (web automation capability) at runtime. Default behavior: enabled for all automation Apps; users can revoke it from the UI. |

> **Permission resolution priority** (`resolvePermission` function):
> 1. Permission is in `app.permissions.denied` → **Denied**
> 2. Permission is in `app.permissions.granted` → **Allowed**
> 3. Permission is declared in `spec.permissions` → **Allowed**
> 4. None of the above → uses `defaultValue` (`ai-browser` defaults to `true`)
>
> Users can manually grant or revoke permissions after installation via the UI
> (stored in `InstalledApp.permissions.granted` / `InstalledApp.permissions.denied`).

---

## 14. Type Constraints Summary

### Duration String Format

All duration fields (`subscriptions[].source.config.every`, `frequency.*`) must match:

```
^\d+[smhd]$
```

Valid examples: `"10s"`, `"30m"`, `"2h"`, `"1d"`, `"24h"`, `"7d"`

Invalid examples: `"1hour"`, `"30 minutes"`, `"1.5h"`, `"1w"`

### Cron Expression

The `cron` field must be at least 5 characters. Full parsing is handled by the scheduler module.

Standard 5-field format: `minute hour day month weekday`

Examples: `"0 8 * * *"` (daily at 08:00), `"*/30 * * * *"` (every 30 minutes), `"0 9 * * 1-5"` (weekdays at 09:00)

### Store Slug Format

```
^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$
```

- Only lowercase letters, digits, and hyphens
- Cannot begin or end with a hyphen
- Valid: `"price-hunter"`, `"hn-daily"`, `"pr-reviewer"`
- Invalid: `"-bad"`, `"bad-"`, `"BadSlug"`, `"my_app"`

---

## 15. Field Aliases (Backward Compatibility)

The parser normalizes these automatically. New specs should use the canonical names.

| Old field name (alias) | Normalized to | Notes |
|---|---|---|
| `inputs` | `config_schema` | Top-level field alias |
| `required_mcps` | `requires.mcps` | Top-level alias; accepts string array or object array |
| `required_skills` | `requires.skills` | Top-level alias |
| `requires.mcp` | `requires.mcps` | Alias inside `requires` (singular → plural) |
| `requires.skill` | `requires.skills` | Alias inside `requires` (singular → plural) |
| `subscriptions[].input` | `subscriptions[].config_key` | Per-subscription entry alias |
| subscription shorthand form | `subscription.source.{type,config}` | See below |

**Subscription shorthand** (`type` at the entry top level):

```yaml
# Shorthand (accepted)
subscriptions:
  - type: schedule
    config:
      every: "1h"

# Equivalent canonical form
subscriptions:
  - source:
      type: schedule
      config:
        every: "1h"
```

---

## 16. Complete Examples

### Example 1: Full automation App (Price Hunter)

```yaml
spec_version: "1"
name: "Price Hunter"
version: "1.0.0"
author: "alice"
description: "Monitors product prices and sends a notification when the target price is reached"
type: automation
icon: "shopping"

system_prompt: |
  You are a professional price-comparison agent.
  Check all price variants (official, third-party, coupons, membership) and compare against
  the 30-day price trend to determine whether the current price is at a low point.
  Flag when a price drop meets the user's threshold.

requires:
  mcps:
    - id: ai-browser
      reason: "Required for web interaction and price scraping"

subscriptions:
  - id: price-check
    source:
      type: webpage
      config:
        watch: "price-element"
    frequency:
      default: "30m"
      min: "10m"
      max: "6h"
    config_key: product_url

filters:
  - field: price_change_percent
    op: gt
    value: 5

memory_schema:
  price_history:
    type: array
    description: "Historical price records (with timestamps)"
  last_low_date:
    type: date
    description: "Date of the last detected price low"
  purchase_decision:
    type: string
    description: "Buy / wait decision and rationale"

config_schema:
  - key: product_url
    label: "Product URL"
    type: url
    required: true
    placeholder: "https://www.amazon.com/dp/..."
  - key: target_price
    label: "Target Price"
    type: number
    required: true
    description: "Notify when the price drops below this value"

output:
  notify:
    system: true
    channels:
      - email
  format: "Current lowest price: {price} — {trend_analysis}"

permissions:
  - ai-browser

escalation:
  enabled: true
  timeout_hours: 24

store:
  slug: "price-hunter"
  category: shopping
  tags: ["price", "shopping", "alert"]
  locale: en-US
  min_app_version: "0.5.0"
  license: MIT
```

---

### Example 2: Minimal automation (HN Daily, cron trigger)

```yaml
name: "HN Daily"
version: "1.0"
author: "alice"
description: "Delivers a Hacker News top-stories digest every morning at 08:00"
type: automation

system_prompt: |
  You are an HN digest assistant. On each trigger:
  1. Open https://news.ycombinator.com and retrieve today's Top 10 stories
  2. Write a concise summary for each (2–3 sentences)
  3. Send an email notification

subscriptions:
  - source:
      type: schedule
      config:
        cron: "0 8 * * *"

config_schema:
  - key: email
    label: "Recipient Email"
    type: email
    required: true

output:
  notify:
    channels:
      - email
```

---

### Example 3: MCP App (PostgreSQL)

```yaml
name: "PostgreSQL MCP"
version: "0.3.1"
author: "community"
description: "Provides AI with PostgreSQL database access"
type: mcp

mcp_server:
  command: npx
  args:
    - "-y"
    - "@modelcontextprotocol/server-postgres"
  env:
    DATABASE_URL: "{{config.database_url}}"

config_schema:
  - key: database_url
    label: "Database Connection URL"
    type: url
    required: true
    placeholder: "postgresql://user:pass@localhost/db"

store:
  slug: "postgres-mcp"
  category: data
  tags: ["database", "postgresql", "sql"]
  locale: en-US
  license: MIT
```

---

### Example 4: Skill App (Code Reviewer)

```yaml
name: "Code Reviewer"
version: "2.1.0"
author: "halo-official"
description: "Code review skill with security and performance analysis"
type: skill
icon: "code-review"

system_prompt: |
  You are a senior code reviewer focused on:
  - Security vulnerabilities
  - Performance bottlenecks
  - Code style and maintainability
  Provide thorough, actionable feedback.

requires:
  mcps:
    - id: git-mcp
      reason: "Access git history and diffs"

config_schema:
  - key: language
    label: "Primary Language"
    type: select
    options:
      - label: TypeScript
        value: typescript
      - label: Python
        value: python
      - label: Go
        value: go

permissions:
  - filesystem.read

output:
  format: "Review of {file}: {summary}"
```

---

## Update Policy

This document must be kept in sync with the following files:

- `src/main/apps/spec/schema.ts` — Zod schema (**single source of truth**)
- `src/shared/apps/spec-types.ts` — shared TypeScript types
- `src/main/apps/spec/parse.ts` — alias and shorthand normalization rules

**Whenever a field is added, modified, or removed in `schema.ts`, the corresponding section of this document must be updated.**

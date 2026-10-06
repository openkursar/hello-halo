# apps/spec Design Decisions

> Module: `src/main/apps/spec/`
> Author: spec module engineer
> Date: 2026-02-21
> Status: Implementation ready

---

## 1. Module Responsibility

Pure parsing and validation of App YAML specs. No business logic, no Electron/Node
API dependencies in the type layer. Two consumers:

- **Main process** (`apps/manager`, `apps/runtime`): Uses `parseAppSpec()` and
  `validateAppSpec()` with full Zod validation.
- **Renderer process**: Imports pure TypeScript types from `src/shared/apps/spec-types.ts`
  for UI rendering.

## 2. Key Design Decisions

### 2.1 Zod-first: `z.infer<>` derives types

**Decision**: Define Zod schemas as the single source of truth. TypeScript types are
derived via `z.infer<typeof schema>`. The shared types file re-exports the inferred types.

**Rationale**:
- Eliminates type/validation drift -- impossible for the TS type and the runtime check
  to disagree.
- Zod provides excellent error messages out of the box with `.parse()`.
- Adding new fields is a single edit in the Zod schema; the TS type updates automatically.

### 2.2 `requires` object vs flat `required_mcps` / `required_skills`

**Decision**: Use a nested `requires` object:
```yaml
requires:
  mcps:
    - id: ai-browser
      reason: "Used for web page interaction"
  skills:
    - price-analysis
```

**Rationale**: The architecture doc used `required_mcps` and `required_skills` as flat
top-level fields. However:
- A `requires` namespace groups related dependency declarations and is more extensible
  (future: `requires.permissions`, `requires.platform`).
- It follows a common namespaced dependency pattern (`requires.*`) and leaves
  room for future keys.
- Cleaner YAML structure -- dependency info lives under one key.

Both `requires.mcps` and the flat `required_mcps` will be accepted during parsing for
backward compatibility -- the flat form is normalized into the `requires` form.

### 2.3 `config_schema` vs `inputs`

**Decision**: Use `config_schema` as the canonical field name. Accept `inputs` as an alias
during parsing (normalize to `config_schema`).

**Rationale**: The architecture doc used `config_schema`, the product direction doc used
`inputs`. `config_schema` is more precise -- it describes a schema for user configuration,
not raw inputs. Aliasing `inputs` ensures YAML written against earlier drafts still works.

### 2.4 `memory_schema` stays separate from `config_schema`

**Decision**: Keep them separate.

**Rationale**:
- `config_schema` is user-facing: filled at install time, rendered in settings UI.
- `memory_schema` is AI-facing: describes what the app's memory file should track.
  Users never fill this in directly -- the AI writes to it.
- Merging them would conflate two very different audiences and lifecycles.

### 2.5 Subscription `source.config` -- typed per source type

**Decision**: Use a discriminated union on `source.type` with type-specific config fields,
plus a generic `Record<string, unknown>` escape hatch.

```typescript
// schedule source; workday_calendar: only on mainland China working days
// (apps/runtime DESIGN §2.26), so the schedule itself fires every day
{ type: 'schedule', config: { every?: string; cron?: string; workday_calendar?: boolean } }
// webpage source
{ type: 'webpage', config: { watch?: string; selector?: string; ... } }
```

**Rationale**: A fully open `Record<string, unknown>` provides no validation or
autocompletion. Typed configs for known source types give:
- Better error messages ("schedule source requires `every` or `cron`").
- IDE autocompletion for YAML authors.
- Runtime safety for `apps/runtime` when translating subscriptions to scheduler jobs.

The `custom` source type retains `Record<string, unknown>` for extensibility.

### 2.6 Filter design -- structured rules, not string DSL

**Decision**: Filters are an array of `FilterRule` objects, not freeform strings.

```yaml
filters:
  - field: price_change_percent
    op: gt
    value: 5
```

**Rationale**: The product doc example used string filters (`"price_change_percent > 5%"`).
This requires a parser and is error-prone. Structured rules:
- Can be validated by Zod at install time.
- Can be executed by `event` with a simple field-path + operator evaluator.
- No custom DSL parser needed.
- Non-technical users would be using a GUI form anyway, which naturally maps to structured
  objects.

For the YAML "shorthand" filter syntax (`"field op value"` as a string), we can add a
parser in V2 that normalizes strings to `FilterRule` objects. V1 only accepts structured.

### 2.7 `spec_version` backward compatibility

**Decision**: `spec_version` defaults to `"1"` if omitted. Validation schema is selected
by `spec_version`. New fields added in future versions are optional -- a v1 spec remains
valid when parsed by a v2 parser.

**Rationale**: Additive changes (new optional fields) never break old specs. If a breaking
change is needed, bump `spec_version` and the parser can dispatch to the right schema.

### 2.8 `type=mcp` compatibility with Claude Code MCP server format

**Decision**: `type=mcp` specs include a `mcp_server` field that holds the standard Claude
Code MCP server config (command, args, env). This allows Halo to pass the config directly
to the Claude Code SDK's `mcpServers` option.

```yaml
type: mcp
mcp_server:
  command: npx
  args: ["-y", "@modelcontextprotocol/server-postgres"]
  env:
    DATABASE_URL: "{{config.database_url}}"
```

### 2.9 Output field kept simple

**Decision**: `output` is an optional object with `notify` (boolean) and `format` (string
template). This matches the architecture doc exactly. No need to over-engineer.

### 2.10 Permissions as string array

**Decision**: `permissions` is `string[]` with a known set of permission constants defined
as a TypeScript union. Unknown permissions are allowed (forward compatibility) but
validated against known values with warnings.

## 3. File Structure

```
src/main/apps/spec/
  index.ts          -- Public API: initAppSpec(), parseAppSpec(), validateAppSpec()
  schema.ts         -- Zod schemas (single source of truth)
  parse.ts          -- YAML parsing + normalization
  validate.ts       -- Validation logic (wraps Zod)
  errors.ts         -- Custom error types
  DESIGN.md         -- This file

src/shared/apps/
  spec-types.ts     -- Re-exported TypeScript types (z.infer<> derived, no Node API)
```

## 4. Dependencies

- `zod` (already in package.json)
- `yaml` (needs to be added -- pure JS YAML parser, zero native deps)

## 5. Exported API

```typescript
// Main exports from src/main/apps/spec/index.ts
export function initAppSpec(): void                          // No-op for V1, exists for bootstrap contract
export function parseAppSpec(yamlString: string): unknown     // YAML -> JS object (may throw on invalid YAML)
export function validateAppSpec(parsed: unknown): AppSpec     // Zod validation (throws on invalid spec)
export function parseAndValidateAppSpec(yaml: string): AppSpec // Convenience: parse + validate

// Type re-exports
export type { AppSpec, AppType, SubscriptionDef, ... } from './schema'
```

## 6. Test Plan

- Valid spec parsing: "e-commerce low price hunter" full YAML example from architecture doc
- Each app type minimal valid spec (mcp, skill, automation, extension)
- Missing required fields produce clear Zod errors
- Type-specific validation (automation requires system_prompt, mcp requires mcp_server)
- Backward compatibility: `inputs` alias, `required_mcps` flat form
- Filter rule validation
- Subscription source config validation per type
- Invalid YAML string handling

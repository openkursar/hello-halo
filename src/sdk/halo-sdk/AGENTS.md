# Halo SDK development

Halo SDK is a general-purpose Agent runtime and the npm package
`@hello-halo/agent-sdk`. Halo is one host, not a dependency. Keep the package
independently buildable, testable and packable; public npm publication is a
separate authorized action.

Repository-wide architecture, security and human-authorization rules still apply.
SDK-only work follows this entry instead of the desktop UI, IPC and renderer i18n
guides. Read only the affected module docs below. Paths here are SDK-relative.

Rust in `crates/halo-core/src/` is the only execution implementation. Node-API,
JavaScript callbacks, public types and Worker integration live in `bindings/node/`.
The SDK root owns the Cargo workspace and pinned `rust-toolchain.toml`.

## Boundaries

- No imports from Halo application code, Electron, or the host's shared types,
  configuration and storage. Hosts supply policy and capabilities through public
  contracts; generic execution behavior belongs in the SDK.
- Hosts consume the entries declared in `package.json`, not internal source files.
  The engine-independent collaboration entry must not import the SDK model loop.
- Keep modules cohesive and dependencies explicit. Surface public-contract or
  module-boundary changes before implementation; do not hide them in a refactor.
- Model instructions and tool feedback are English runtime contracts, not desktop
  UI strings. Do not introduce the host's translation runtime into the SDK.

## Read by concern

| Work | Read first |
|---|---|
| Harness: prompts, loop, context, tools, budgets, retries | [DESIGN.md](DESIGN.md), [core execution](crates/halo-core/src/core/DESIGN.md); inspect the affected Rust modules and Harness catalogs under `crates/halo-core/src/` |
| History, persistence and resume | [journal contract](crates/halo-core/src/core/TRANSCRIPT.md) |
| Worker execution and lifecycle | [Worker design](bindings/node/worker/DESIGN.md) |
| Collaboration and delivery | [collaboration design](bindings/node/collaboration/DESIGN.md) |
| Skills | [skill resolution](crates/halo-core/src/skills/DESIGN.md) |
| Optional search | [search design](bindings/node/search/DESIGN.md), [search validation](bindings/node/search/VALIDATION.md) |
| Checks, simulation, performance and package evidence | [TESTING.md](TESTING.md) |
| Halo adapter or application outcome | Repository `src/main/services/agent/DESIGN.md` and `.agents/skills/acceptance-testing/SKILL.md`; verify both sides |

## Harness contract

The model sees only its input. Everything the runtime places there — system
prompt, tool definitions, tool results, errors, reminders, summaries — is the
Harness, and each piece steers the next decision. Write each one as a note to a
capable colleague who cannot see anything else.

Every model-facing text is:

- **True.** The model cannot check the note against the world; an inaccurate
  line becomes a wrong action. Never present partial, truncated, or skipped work
  as complete.
- **Dense.** Each sentence changes what the model does. Cut restatement,
  emphasis, and advice it would follow anyway.
- **General.** State the principle and its reason, not a rule for one scenario;
  narrow rules misfire elsewhere and crowd out judgment. When only one case needs
  help, improve that tool's feedback instead of adding prompt text.
- **Readable.** Plain sentences a person understands on first reading. The model
  is a reader, not a parser: a reason lets it handle cases the wording did not
  foresee.

Standing guidance (system prompt, tool definitions):

- State permissions, protocol, safety, and truthful reporting as exact
  requirements. State everything else as judgment with its reason.
- Say each thing once, where it is used: tool-specific guidance in the tool
  definition, cross-task guidance in the system prompt.

Runtime feedback (tool results, errors, reminders):

- Report three things separately: how the execution ended, whether the output
  shown is complete, and where the rest can be obtained.
- Never replay an operation to recover its output; running it again is the
  agent's decision.
- Loaded instructions and tool definitions are capabilities, not log previews:
  deliver them whole or say what is missing.
- Offer recovery only within the same permission and privacy boundaries.

Changing the Harness:

- Prefer established behavior and the smallest complete fix.
- Prove the promised behavior with deterministic evidence. A smaller result or a
  passing unit test does not show that task quality improved.
- When experience cannot tell how the model will behave under the change, run a
  real-model baseline/candidate comparison ([TESTING.md](TESTING.md)).

## Design and review

Read [REVIEW.md](REVIEW.md) before SDK design or code review. It defines the
SDK-specific criteria for Harness task quality, cache/cost, runtime performance,
safety and package contracts. Use the shared single/team review workflows and
[TESTING.md](TESTING.md) for verification; do not maintain a parallel checklist.

## Delivery

Use `code-commit` only when the human requests a commit. Review the actual SDK
working tree and follow [TESTING.md](TESTING.md). Cross-boundary changes need SDK
and host integration evidence.

Do not commit generated output, credentials, private diagnostics or internal
working notes. Keep public docs aligned with implementation and name unverified
coverage explicitly. Package changes do not authorize publishing or a repository
migration.

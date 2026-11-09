# Halo SDK development

Halo SDK is a general-purpose Agent runtime and the npm package
`@hello-halo/agent-sdk`. Halo is one host, not a dependency. Keep the package
independently buildable, testable and packable; public npm publication is a
separate authorized action.

Repository-wide architecture, security and human-authorization rules still apply.
SDK-only work follows this entry instead of the desktop UI, IPC and renderer i18n
guides. Read only the affected module docs below. Paths here are SDK-relative.

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
| Harness: prompts, loop, context, tools, budgets, retries | [core/DESIGN.md](core/DESIGN.md); inspect `prompt/sections.ts`, `prompt/summary.ts` and `llm/cache-breakpoints.ts` when affected |
| History, persistence and resume | [core/TRANSCRIPT.md](core/TRANSCRIPT.md) |
| Worker execution and lifecycle | [worker/DESIGN.md](worker/DESIGN.md) |
| Collaboration and delivery | [collaboration/DESIGN.md](collaboration/DESIGN.md) |
| Skills | [skills/DESIGN.md](skills/DESIGN.md) |
| Optional search | [search/DESIGN.md](search/DESIGN.md), [search/VALIDATION.md](search/VALIDATION.md) |
| Checks, simulation, performance and package evidence | [TESTING.md](TESTING.md) |
| Halo adapter or application outcome | Repository `src/main/services/agent/DESIGN.md` and `.agents/skills/acceptance-testing/SKILL.md`; verify both sides |

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

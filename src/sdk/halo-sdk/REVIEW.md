# SDK code review

Read [AGENTS.md](AGENTS.md) and the affected module designs first. These criteria
supplement the shared `code-review` and `code-review-one` workflows; they do not
replace their authorization, review organization or finding classification.
Use [TESTING.md](TESTING.md) for verification commands and evidence requirements.

## Regression protection

- Preserve existing features and observable behavior. Only an authorized product
  goal or evidence-backed bug fix may justify an intentional change; existing
  approval rules still apply. State the intended difference and keep unrelated
  behavior unchanged.
- Refactoring, optimization and cleanup do not justify feature loss or behavior
  changes. Check affected consumers and existing scenarios, not only the new path.
- Verify both preserved behavior and the intended change through [TESTING.md](TESTING.md).
  Update old expectations only when the authorized contract changed; do not
  delete, skip or weaken regression checks merely to make a change pass.

## Harness and task quality

The Harness is core product behavior: instructions, context, tool feedback and
recovery determine whether the model finishes the right task. Review outcomes,
not only types or wording. Preserve tuned behavior unless the authorized change
requires otherwise; explain any quality, context or cost trade-off.

- Follow the task through instructions, model requests, tool execution and
  completion. Goals, latest corrections, evidence and unresolved work must survive
  context changes, compaction and resume.
- Check skill selection, useful tool results and completion criteria. Failures,
  truncation or missing evidence must not become an unsupported success claim.

## Cache and money

- Check stable request prefixes, tool definitions, cache markers and intended
  invalidation. Avoid putting volatile state ahead of reusable content; cache
  stability must not preserve stale instructions or omit new input.
- Trace usage through ordinary calls, retries and summaries. Returned usage must
  reach accounting exactly once, including partial responses where supplied.
- Local token/cost estimates and synthetic usage are not provider billing or
  measured cache savings. Assess both request growth and extra model calls.

## Runtime performance

- Check cold/warm readiness, first-request latency, event-loop delay, CPU, memory,
  concurrent sessions and resource release. Include unused-feature overhead and
  growth with history, tool output and long-lived sessions.
- Check repeated scans, serialization, retained buffers and background work on
  affected paths. Deferring work or moving it to a Worker does not remove its cost.
- Apply repository `.agents/skills/product-principles/SKILL.md` §1 before accepting
  added costs. Compare equivalent workloads and correctness; code inspection is
  not runtime evidence, and one timing sample is not a release threshold.

## Safety and lifecycle

- Trace permission inheritance and isolation through tools, callbacks, Workers and
  collaboration. Cancellation, timeout and close must release owned work without
  reporting incomplete work as successful.
- Follow retry and recovery paths: completed side effects must not be replayed.
  Check pending input, checkpoints and terminal state across interruption/resume.

## Architecture and package contracts

- Check module responsibilities, placement, public surfaces and dependency
  direction, including reverse imports. Follow [AGENTS.md](AGENTS.md) boundaries;
  no Halo application or Electron dependency belongs in the SDK.
- Review affected consumers for API/type compatibility, Worker contracts and
  standalone package use. A host build does not prove the npm package works;
  inspect exports, declarations, bundled dependencies and notices when affected.

## Evidence

Select checks through [TESTING.md](TESTING.md). Reuse existing fixtures and scripted
providers with real SDK loop, tools, history and callbacks; do not mock away the
behavior under review. Cover affected success, failure and recovery paths, and
inspect assertions of requests, effects, checkpoints and terminal state rather
than only pass counts or a canned final answer. Do not weaken checks to raise a score.

Keep deterministic behavior, local performance and real-model/cost evidence
separate. Scripted models cannot establish real model choices, actual cache hits
or billed savings. Report the reviewed source/build, evidence and unverified
coverage; historical reports and skipped checks are not current passing evidence.

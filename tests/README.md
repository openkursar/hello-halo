# Halo test suite

Halo uses complementary verification layers. The behavioral acceptance catalog
connects user-visible promises to these layers without replacing their runners.
Start at [acceptance/README.md](acceptance/README.md) to browse the product scope,
select a module and understand what a result actually proves.

| Layer | Location | Purpose | Entry |
|---|---|---|---|
| Package and resource checks | `check/` | Binary, platform, signing and shipped-runtime prerequisites | `npm run test:check` and the related `test:check:*` scripts |
| Unit and in-process integration | `unit/` | Domain behavior, architecture guards, protocol/state failures and selected renderer logic | `npm run test:unit -- <test-path>` |
| UI and application acceptance | `e2e/` | Real Electron UI, scripted-model application journeys, browser integration and optional live tests | `npm run test:e2e -- --project=<project>` |
| Digital-team cluster regression | `decentralized/` | Real isolated nodes, persistence, HTTP/WS, failures and selected model turns | `npm run test:team -- <suite>` |
| Performance and resource regression | `perf/` | Named workloads with build, fixture and measurement evidence | `npm run test:perf` and `test:perf:release` |
| Product behavior catalog | `acceptance/` | User stories, applicability, executable bindings, selection and evidence reports | `npm run acceptance -- <command>` |

`npm test` runs the configured package/resource checks and unit suite. It does
**not** run all Electron, cluster, performance or paid live-model tests. The
Playwright configuration contains both ordinary application projects and specialist
performance projects, so use an explicit project or an acceptance plan when the
intended scope is narrower than everything.

## Common workflows

```bash
# Inspect the catalog without starting Electron or calling a model.
npm run acceptance -- validate
npm run acceptance -- report --locale zh

# Focused unit verification.
npm run test:unit -- tests/unit/apps/manager/manager.test.ts

# Build once before application or cluster execution.
npm run acceptance -- build
npm run test:e2e:smoke
npm run acceptance -- plan --profile regression --module workspaces --module chat
npm run acceptance -- run --plan tests/acceptance/output/plan.json

# See tests/decentralized/README.md before selecting a cluster suite.
npm run test:team -- single --protocol-only
```

The `fast` acceptance profile is a bounded set of registered user journeys. The
`regression` profile includes applicable deterministic module scenarios and keeps
missing automation visible. Live models and external systems have separate opt-in
profiles and prerequisites. A skipped test, absent credential, missing platform or
undiscovered binding is not successful acceptance.

Never run heavy Electron, cluster and performance suites concurrently on the same
host: resource contention can create timeout-shaped false failures. Use disposable
profiles, local deterministic services and explicit fixture data. Real model tests
must use approved test credentials and bounded spend, not whichever production
account happens to be installed on the developer's machine.

## Add tests where their responsibility belongs

- Domain and architecture checks belong under the corresponding `unit/` module.
- Actual desktop interactions belong in `e2e/specs/` with reusable fixtures.
- Multi-process office consistency stays in `decentralized/`; an HTTP-driven
  cluster result does not also prove that the UI presented it correctly.
- Named performance workloads stay under `perf/`; preserve build and fixture
  identity and the exact measured duration.
- The associated user story and scenario live in `acceptance/catalog/`. Existing
  tests declare stable scenario IDs in executable metadata. Discovery generates
  the manifest; there is no separate hand-edited list of test bindings.

For application tests, state which boundary was substituted. A seeded initial
profile can support a real application journey. Replacing application IPC handlers
limits evidence to UI behavior. Replacing only the model endpoint can still test
real application orchestration, tools and persistence without paid model calls.

## CI and specialist acceptance

[The current CI workflow](../.github/workflows/ci-test.yml) runs the changed-file
precommit gate on pull requests and configured pushes. It is not a complete
cross-platform nightly UI regression. The acceptance CI template and operational
checks live in [acceptance/ci/](acceptance/ci/); deploying its dedicated runners and
graphical sessions is a separate operation.

Paid model acceptance requires the explicit broker configuration and budget
described in [the acceptance guide](acceptance/README.md). [Cluster regression](decentralized/README.md) and
[performance measurement](perf/docs/README.md) also have distinct prerequisites.
Their historical reports are evidence for those recorded runs, not current passing
results for a changed build or behavior catalog.

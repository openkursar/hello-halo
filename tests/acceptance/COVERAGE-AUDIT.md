# Acceptance coverage audit

Inventory recorded on 2026-10-27. This is a source review and binding audit, not a test execution report. Counts describe this initial catalog snapshot and may change as stories and bindings evolve; use the generated catalog and discovery manifest for current totals.

## Inventory boundary

This catalog follows the product behavior on its own source branch. Application-wide engine selection requires restart; keeping a temporary collaboration retains the same team. Independently saved-team configuration, person-specific engine overrides, engine handoff and vendor model-offer/withdrawal presentation are not asserted here. Those behaviors must enter with the product changes that implement them, together with their matching scenarios.

The inventory follows actual top-level renderer navigation, settings groups, digital-human and team workbenches, source/design contracts and existing test assertions. It includes background work that becomes visible through tasks, notifications, commands, remote access, installation and recovery. A source filename by itself was not counted as a user capability.

This snapshot contains 28 modules, 83 stories, 329 scenarios and 394 required scenario/variant combinations before host-platform selection. 160 scenarios declare an executable binding, 168 remain planned and 1 identifies a human action. These are implementation classifications, not passed results.

Story basis: 35 documented, 45 observed and 3 proposed. Historical documented/observed behavior is usable as a regression baseline without asking the owner to approve every old story. No human approval is manufactured by this inventory.

| Module | Stories | Scenarios | Variant combinations | Automated scenarios | Human-action scenarios |
|---|---:|---:|---:|---:|---:|
| assistant-tools | 4 | 9 | 13 | 0 | 0 |
| automation | 4 | 12 | 13 | 2 | 0 |
| browser | 3 | 51 | 54 | 43 | 0 |
| capabilities | 3 | 10 | 10 | 3 | 0 |
| changes | 3 | 22 | 22 | 17 | 0 |
| channels | 3 | 15 | 19 | 4 | 1 |
| chat | 5 | 15 | 15 | 9 | 0 |
| conversations | 2 | 16 | 21 | 13 | 0 |
| files | 3 | 10 | 20 | 3 | 0 |
| goals | 1 | 2 | 2 | 0 | 0 |
| knowledge | 2 | 6 | 13 | 0 | 0 |
| lifecycle | 4 | 13 | 13 | 1 | 0 |
| marketplace | 3 | 7 | 7 | 0 | 0 |
| memory | 3 | 5 | 5 | 0 | 0 |
| models | 3 | 7 | 7 | 0 | 0 |
| notifications | 2 | 7 | 7 | 3 | 0 |
| offices | 3 | 8 | 9 | 1 | 0 |
| people | 4 | 16 | 17 | 13 | 0 |
| permissions | 3 | 8 | 8 | 0 | 0 |
| quality | 3 | 7 | 29 | 0 | 0 |
| references | 2 | 5 | 5 | 3 | 0 |
| remote | 3 | 10 | 12 | 5 | 0 |
| search | 2 | 5 | 5 | 3 | 0 |
| settings | 4 | 10 | 13 | 2 | 0 |
| startup | 2 | 10 | 10 | 6 | 0 |
| teams | 3 | 24 | 25 | 18 | 0 |
| terminal | 3 | 8 | 8 | 2 | 0 |
| workspaces | 3 | 11 | 12 | 9 | 0 |

## What the current evidence does not establish

- Most deterministic bindings presently concentrate on application chat/file journeys and existing browser, team-workbench, directory, references and changes-view regressions. Unbound/planned knowledge, memory, search, installation, permission and live external journeys remain explicit obligations; nearby unit tests do not convert them into UI acceptance.
- Browser-module fixtures compile real production modules into a dedicated Electron host. Their records are `integration`; no complete user-chat or actual model path is inferred. Team-workbench and several chat-rendering fixtures replace IPC or inject stream events and are `ui`.
- The live-model reply and timer cases have explicit live classification. The executor must keep them blocked until the bounded model broker is operational; credential-based skips remain skipped results.
- The cluster tier already has extensive scenarios and useful automation-boundary documents. Its existing driver output has not been silently imported as current acceptance results. Its catalog cases need the matching executor adapter and current-run evidence.
- The existing performance tier has measured workloads and gates. Its historical reports are not reused as passing evidence for this catalog or a different build, and shortened soaks do not satisfy full-duration scenarios.
- Windows command behavior requires an actual Windows host. The optional interactive terminal is explicitly disabled on Linux by `src/main/services/ai-terminal/available.ts`; Linux shell-tool work is a different capability. Desktop viewport emulation does not certify native Android/iOS clients.
- The sole manual classification is third-party account-holder consent on their trusted device. Missing machines, service accounts, signing material, packages and automation adapters remain environment/implementation gaps, not permanent manual exclusions.

## Product decisions

Decided:

- **memory.guest-privacy**: a reply to a guest may use the shared memory, with host guidance telling the assistant not to reveal the owner's private details. This is model guidance, not an enforced data boundary.

Deferred, with the questions kept on their stories until someone decides:

- **permissions.guidance**: Should denied guest operations offer a permission request to the owner, or explain the limitation without opening an approval workflow?
- **terminal.python**: Should a Windows release provide an isolated Python runtime, or support Python only after a user-managed installation?

These questions identify actual product choices. Backups, fixture dimensions, test budgets and whether to rerun historical tests are not added as approval questions merely because the inventory did not previously describe them.

## Existing Playwright binding review

Only acceptance metadata was added to existing specs. An AST comparison against the source baseline verified that their test titles and callback bodies did not change. This preserves their existing assertions, skip logic and execution behavior; known weak assertions are described below rather than strengthened silently in a metadata change.

Counts below are source test declarations. A parameterized declaration can register multiple concrete tests; the generated runner manifest is authoritative for actual test and variant identities. Newly authored `acceptance-*.spec.ts` journeys are separate from this legacy inventory.

| Existing spec | Bound declarations | Unbound declarations |
|---|---:|---:|
| [apps.spec.ts](../e2e/specs/apps.spec.ts) | 0 | 7 |
| [automation-run.spec.ts](../e2e/specs/automation-run.spec.ts) | 0 | 4 |
| [browser-carrier-packaged.spec.ts](../e2e/specs/browser-carrier-packaged.spec.ts) | 2 | 0 |
| [browser-carrier-server.spec.ts](../e2e/specs/browser-carrier-server.spec.ts) | 1 | 0 |
| [browser-view-frame.spec.ts](../e2e/specs/browser-view-frame.spec.ts) | 22 | 0 |
| [browser-view-reveal.spec.ts](../e2e/specs/browser-view-reveal.spec.ts) | 22 | 1 |
| [changes-view.spec.ts](../e2e/specs/changes-view.spec.ts) | 17 | 3 |
| [chat.spec.ts](../e2e/specs/chat.spec.ts) | 3 | 6 |
| [cli-tools-packaged.spec.ts](../e2e/specs/cli-tools-packaged.spec.ts) | 1 | 0 |
| [codex-mcp.spec.ts](../e2e/specs/codex-mcp.spec.ts) | 0 | 1 |
| [digital-human-chat.spec.ts](../e2e/specs/digital-human-chat.spec.ts) | 8 | 1 |
| [digital-human-lifecycle.spec.ts](../e2e/specs/digital-human-lifecycle.spec.ts) | 1 | 9 |
| [navigation.spec.ts](../e2e/specs/navigation.spec.ts) | 3 | 4 |
| [people-capabilities.spec.ts](../e2e/specs/people-capabilities.spec.ts) | 2 | 0 |
| [people-settings.spec.ts](../e2e/specs/people-settings.spec.ts) | 9 | 2 |
| [people-tasks.spec.ts](../e2e/specs/people-tasks.spec.ts) | 1 | 0 |
| [people-upgrade.spec.ts](../e2e/specs/people-upgrade.spec.ts) | 3 | 0 |
| [references.spec.ts](../e2e/specs/references.spec.ts) | 3 | 0 |
| [remote.spec.ts](../e2e/specs/remote.spec.ts) | 2 | 4 |
| [settings.spec.ts](../e2e/specs/settings.spec.ts) | 4 | 3 |
| [skillhub-store.spec.ts](../e2e/specs/skillhub-store.spec.ts) | 0 | 5 |
| [smoke.spec.ts](../e2e/specs/smoke.spec.ts) | 1 | 10 |
| [spaces.spec.ts](../e2e/specs/spaces.spec.ts) | 6 | 0 |
| [team-collab.spec.ts](../e2e/specs/team-collab.spec.ts) | 1 | 0 |
| [team-render.spec.ts](../e2e/specs/team-render.spec.ts) | 17 | 6 |
| [token-usage-popup.spec.ts](../e2e/specs/token-usage-popup.spec.ts) | 1 | 0 |
| [transcript-scroll.spec.ts](../e2e/specs/transcript-scroll.spec.ts) | 3 | 0 |

## Why specific tests remain unbound

Unbound tests continue to exist in their original runner projects. They do not disappear from the repository or become failures merely because they do not claim a product scenario. This list is an audit snapshot, not a second editable binding registry.

### apps.spec.ts

- **renders with correct tab bar** — Shallow navigation, tab or empty-state smoke coverage. The registered startup/people/capability stories carry more specific interaction outcomes; this duplicate presence check does not certify resource installation or task execution.
- **capability library exposes skill and MCP categories** — Shallow navigation, tab or empty-state smoke coverage. The registered startup/people/capability stories carry more specific interaction outcomes; this duplicate presence check does not certify resource installation or task execution.
- **can open Store from Apps page** — Shallow navigation, tab or empty-state smoke coverage. The registered startup/people/capability stories carry more specific interaction outcomes; this duplicate presence check does not certify resource installation or task execution.
- **My Digital Humans shows empty state or app list** — Shallow navigation, tab or empty-state smoke coverage. The registered startup/people/capability stories carry more specific interaction outcomes; this duplicate presence check does not certify resource installation or task execution.
- **can navigate back from Apps page** — Shallow navigation, tab or empty-state smoke coverage. The registered startup/people/capability stories carry more specific interaction outcomes; this duplicate presence check does not certify resource installation or task execution.
- **settings button is accessible from Apps page** — Shallow navigation, tab or empty-state smoke coverage. The registered startup/people/capability stories carry more specific interaction outcomes; this duplicate presence check does not certify resource installation or task execution.
- **app store shows content** — Shallow navigation, tab or empty-state smoke coverage. The registered startup/people/capability stories carry more specific interaction outcomes; this duplicate presence check does not certify resource installation or task execution.

### automation-run.spec.ts

- **digital-humans view is reachable from the Studio/Apps card** — Reachability/empty-or-nonempty smoke assertion only; deterministic lifecycle fixtures and actual run outcomes are required for the corresponding acceptance story.
- **digital-humans view shows either an empty state or a run surface** — Reachability/empty-or-nonempty smoke assertion only; deterministic lifecycle fixtures and actual run outcomes are required for the corresponding acceptance story.
- **run-detail (View process) opens when a finished run exists** — Depends on incidental preexisting people and completed runs; a fresh profile skips it. Use a deterministic owned fixture before binding.
- **user can trigger a run, watch it live, and inject a supplement** — Uses the fresh unseeded application fixture, so absence of a person/Run control skips the path. Input clearing also does not prove the model received the supplement.

### browser-view-reveal.spec.ts

- **the clipboard fixture restores native custom formats and their original bytes** — Test-harness cleanup verification, not a product behavior. Keep it as an infrastructure guard.

### changes-view.spec.ts

- **keeps small diff editors mounted while scrolling** — Implementation-level editor mounting/loading-budget guard or duplicate menu entry. Keep it under the existing regression project; registered diff navigation/readability/operation scenarios state the independent user outcomes.
- **budgets unchanged context and long lines without prefetching the repository** — Implementation-level editor mounting/loading-budget guard or duplicate menu entry. Keep it under the existing regression project; registered diff navigation/readability/operation scenarios state the independent user outcomes.
- **opens from the header menu too** — Implementation-level editor mounting/loading-budget guard or duplicate menu entry. Keep it under the existing regression project; registered diff navigation/readability/operation scenarios state the independent user outcomes.

### chat.spec.ts

- **chat input is visible and functional** — Composer/button/indicator behavior is already exercised in stronger scripted journeys. This legacy case either unnecessarily requires live credentials or proves only an intermediate UI state.
- **send button exists and is functional** — Composer/button/indicator behavior is already exercised in stronger scripted journeys. This legacy case either unnecessarily requires live credentials or proves only an intermediate UI state.
- **displays thinking indicator during response** — Composer/button/indicator behavior is already exercised in stronger scripted journeys. This legacy case either unnecessarily requires live credentials or proves only an intermediate UI state.
- **input clears after sending message** — Composer/button/indicator behavior is already exercised in stronger scripted journeys. This legacy case either unnecessarily requires live credentials or proves only an intermediate UI state.
- **switch configured API source, select GLM-5.0, and chat** — Requires particular preexisting account/model inventory and only checks nonempty final text. It is not a portable test of per-conversation model routing.
- **handles empty message gracefully** — Composer/button/indicator behavior is already exercised in stronger scripted journeys. This legacy case either unnecessarily requires live credentials or proves only an intermediate UI state.

### codex-mcp.spec.ts

- **Codex turn invokes Halo built-in MCP tool web-search** — Its fixture discovers and copies an existing user Halo account. A dedicated credential source and bounded live execution must be established before unattended acceptance may select it.

### digital-human-chat.spec.ts

- **shows the terminal button of a live terminal call, and takes the compact layout beside a canvas** — Synthetic terminal-event button and compact-layout presentation guard; it does not open or execute a real terminal. Full terminal and canvas obligations remain separate.

### digital-human-lifecycle.spec.ts

- **the seeded app appears in My Digital Humans** — Checks a seeded row, schedule hint, Run control, breadcrumb or settings control only. Keep as a smoke guard rather than claiming successful execution or delivery.
- **opening it shows the schedule subscription it was seeded with** — Checks a seeded row, schedule hint, Run control, breadcrumb or settings control only. Keep as a smoke guard rather than claiming successful execution or delivery.
- **a "Run once" control is available for an idle active app** — Checks a seeded row, schedule hint, Run control, breadcrumb or settings control only. Keep as a smoke guard rather than claiming successful execution or delivery.
- **a manually triggered run reaches a live process view** — Checks a seeded row, schedule hint, Run control, breadcrumb or settings control only. Keep as a smoke guard rather than claiming successful execution or delivery.
- **the run completes and calling report_to_user reaches an ok/useful outcome** — Checks tool-name and run_complete text visibility, not the tool result, successful activity persistence or final run outcome.
- **a follow-up message after completion is a genuine second turn, not a repeat of the first** — The unscoped text=/42/ wait can match the user request containing 42. The assertion does not independently establish a second assistant response; retain the stronger planned follow-up scenario.
- **a completed run leaves a visible completion marker for the desktop-notification gate** — A completed activity badge is a proxy for the notification gate, not notification delivery evidence.
- **a completed run while the window is unfocused takes the OS Notification path, not the in-app toast** — Checks an OS notification log line. This does not prove a native notification was delivered, readable or opened by the recipient.
- **the notification level control is reachable under the app's Capabilities and settings tab** — Checks a seeded row, schedule hint, Run control, breadcrumb or settings control only. Keep as a smoke guard rather than claiming successful execution or delivery.

### navigation.spec.ts

- **settings is accessible from the navigation rail** — Duplicate entry-point or single-label visibility smoke check. More specific navigation/theme scenarios are already registered; this test stays available without increasing the behavioral coverage numerator.
- **can navigate to the Halo workspace and see chat** — Duplicate entry-point or single-label visibility smoke check. More specific navigation/theme scenarios are already registered; this test stays available without increasing the behavioral coverage numerator.
- **can navigate to Settings** — Duplicate entry-point or single-label visibility smoke check. More specific navigation/theme scenarios are already registered; this test stays available without increasing the behavioral coverage numerator.
- **can navigate back from Settings to the previous conversation view** — Duplicate entry-point or single-label visibility smoke check. More specific navigation/theme scenarios are already registered; this test stays available without increasing the behavioral coverage numerator.

### people-settings.spec.ts

- **the messages group hosts the bound-bot card that opens a bot’s session browser** — The seeded person has no bound bot; the assertion checks only the unbound placeholder and never opens a bot session browser.
- **the work activity tab opens on the compact run summary band** — A compact summary or internal navigation presentation guard. It does not independently prove new execution or decision outcomes beyond the registered person scenarios.

### remote.spec.ts

- **can navigate to settings and find remote access section** — Unbound pending a precise independently asserted product outcome; no passing coverage is inferred from its existence.
- **can enable LAN access and get local URL** — Unbound pending a precise independently asserted product outcome; no passing coverage is inferred from its existence.
- **can enable tunnel and get public URL** — Existing tunnel checks obtain a public URL and QR surface but do not verify authenticated reachability from an external client. The catalog retains a distinct external round-trip obligation.
- **can disable remote access** — Unbound pending a precise independently asserted product outcome; no passing coverage is inferred from its existence.

### settings.spec.ts

- **renders with the AI Model section** — Duplicate entry-point or single-label visibility smoke check. More specific navigation/theme scenarios are already registered; this test stays available without increasing the behavioral coverage numerator.
- **Appearance navigation brings its section into view** — Duplicate entry-point or single-label visibility smoke check. More specific navigation/theme scenarios are already registered; this test stays available without increasing the behavioral coverage numerator.
- **About navigation shows the app version** — Duplicate entry-point or single-label visibility smoke check. More specific navigation/theme scenarios are already registered; this test stays available without increasing the behavioral coverage numerator.

### skillhub-store.spec.ts

- **appears as an enabled registry in Settings** — Uses a live third-party catalog and broad text/content-presence checks (including body length), without a deterministic selected resource and asserted installation/filtering outcome.
- **App Store opens and loads content** — Uses a live third-party catalog and broad text/content-presence checks (including body length), without a deterministic selected resource and asserted installation/filtering outcome.
- **Skills type filter shows items from SkillHub** — Uses a live third-party catalog and broad text/content-presence checks (including body length), without a deterministic selected resource and asserted installation/filtering outcome.
- **install flow: clicking a store item shows detail or dialog** — Uses a live third-party catalog and broad text/content-presence checks (including body length), without a deterministic selected resource and asserted installation/filtering outcome.
- **SkillHub API is reachable from the app process** — External connectivity check can skip on provider failure; it does not establish the user-facing search/install contract.

### smoke.spec.ts

- **application launches successfully** — Low-level launch/container/dimensions or duplicate smoke coverage. It remains a useful smoke test but does not independently establish a complete user outcome; late console observation also cannot certify all startup errors.
- **main window opens** — Low-level launch/container/dimensions or duplicate smoke coverage. It remains a useful smoke test but does not independently establish a complete user outcome; late console observation also cannot certify all startup errors.
- **window has correct dimensions** — Low-level launch/container/dimensions or duplicate smoke coverage. It remains a useful smoke test but does not independently establish a complete user outcome; late console observation also cannot certify all startup errors.
- **renders main UI container** — Low-level launch/container/dimensions or duplicate smoke coverage. It remains a useful smoke test but does not independently establish a complete user outcome; late console observation also cannot certify all startup errors.
- **renders the loaded application shell** — Low-level launch/container/dimensions or duplicate smoke coverage. It remains a useful smoke test but does not independently establish a complete user outcome; late console observation also cannot certify all startup errors.
- **no console errors on startup** — Low-level launch/container/dimensions or duplicate smoke coverage. It remains a useful smoke test but does not independently establish a complete user outcome; late console observation also cannot certify all startup errors.
- **shows API setup on first launch** — The generic fixture may already be configured; this conditional smoke check is not a guaranteed fresh-profile setup journey.
- **settings button is accessible** — Low-level launch/container/dimensions or duplicate smoke coverage. It remains a useful smoke test but does not independently establish a complete user outcome; late console observation also cannot certify all startup errors.
- **can send message and receive AI response** — Low-level launch/container/dimensions or duplicate smoke coverage. It remains a useful smoke test but does not independently establish a complete user outcome; late console observation also cannot certify all startup errors.
- **can enable tunnel and get public URL** — Existing tunnel checks obtain a public URL and QR surface but do not verify authenticated reachability from an external client. The catalog retains a distinct external round-trip obligation.

### team-render.spec.ts

- **2.1 (proxy): Teams view renders with zero console/page errors over an observation window** — Empty-team shell, theme/language or selector presentation smoke coverage, or a narrower duplicate of the registered draft/scope journey. The broader cross-surface contract still requires its declared nonempty data and variants.
- **2.3: no horizontal overflow at mobile width (<640px)** — Empty-team shell, theme/language or selector presentation smoke coverage, or a narrower duplicate of the registered draft/scope journey. The broader cross-surface contract still requires its declared nonempty data and variants.
- **2.4: theme toggle keeps the Teams view alive in both themes** — Empty-team shell, theme/language or selector presentation smoke coverage, or a narrower duplicate of the registered draft/scope journey. The broader cross-surface contract still requires its declared nonempty data and variants.
- **2.5: switching to Chinese translates the tab and leaves no bare i18n keys** — Empty-team shell, theme/language or selector presentation smoke coverage, or a narrower duplicate of the registered draft/scope journey. The broader cross-surface contract still requires its declared nonempty data and variants.
- **avatar selection matches the composer and preserves per-member drafts** — Empty-team shell, theme/language or selector presentation smoke coverage, or a narrower duplicate of the registered draft/scope journey. The broader cross-surface contract still requires its declared nonempty data and variants.
- **one owned digital human has no redundant composer selector** — Empty-team shell, theme/language or selector presentation smoke coverage, or a narrower duplicate of the registered draft/scope journey. The broader cross-surface contract still requires its declared nonempty data and variants.

## Continuing the inventory

When a new UI entry or behavior appears, classify its user capability, extend the relevant story and declare its applicability before attaching evidence. Periodic exploration should revisit role changes, interrupted work, restarts, missing prerequisites and cross-feature journeys. A large number of bound UI checks must not conceal an untested end-to-end permission, platform or external-service boundary.

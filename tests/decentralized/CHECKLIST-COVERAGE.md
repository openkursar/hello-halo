# Production Checklist → Automation Coverage Map (honest layering)

> Item-by-item evaluation against
> `local_docs/features/数字团队/产品/投产测试清单.md` (1.1–7.5): can we achieve
> "100% complete" automation with real results using curl/HTTP + e2e in this
> sandbox environment?
> Conclusion up front: **most functional/consistency items can** (the new scripts
> in this directory + the existing `run-scenarios.mjs`); **a few items are
> inherently impossible to automate 100% in a single-machine sandbox** (real-machine
> render judged by eye, packaged-build signing/keychain/firewall UI dialogs, true
> dual physical-machine LAN). Those are flagged below with alternative verification
> — we never fake "green."

## Legend
- **A (automated, new this round / covered)**: HTTP/curl-driven, asserts real
  outcomes, script is re-runnable for regression.
- **A-existing**: already covered by `tests/decentralized/run-scenarios.mjs`
  (SCENARIOS.md); not redone here.
- **P (partially automated)**: core logic can be auto-verified, but some
  perception/environment facet the checklist requires (e.g. "the animation looks
  smooth to the eye") cannot be fully replaced by assertions.
- **M (manual, environment-limited)**: needs a real second machine / a real signed
  installer / OS-level UI (keychain, firewall dialogs) / long real soak — not doable
  in the sandbox; flagged with reason + alternative.

## 1. Single-machine team fundamentals

| # | Coverage | Script/reason |
|---|---|---|
| 1.1.1–1.1.5 | A | `checklist-single-machine.mjs` §1.1 |
| 1.2.1–1.2.7 | A (1.2.2 animation part is P, see below) | `checklist-single-machine.mjs` §1.2; the "pulse animation / edge flow" of 1.2.2 is render layer — this script only verifies backend state transitions (working→idle, task-card data), not pixel-level animation smoothness |
| 1.3.1–1.3.5 | A | `checklist-single-machine.mjs` §1.3 |
| 1.4.1–1.4.4 | A | `checklist-single-machine.mjs` §1.4 |
| 1.5.1–1.5.3 | A | `checklist-single-machine.mjs` §1.5 |
| 1.6.1–1.6.4 | A | `checklist-single-machine.mjs` §1.6 |
| 1.6.3 (IM backend) | P | The "data plane" of a team wired to an IM backend (`teamId` binding + dispatch-inbound routing) can be script-triggered and verified; real IM platform (WeCom) send/receive needs real credentials and external round-trip — the sandbox uses an internal loopback webhook to simulate, which is not equivalent to real IM UI acceptance |

## 2. UI & interaction (render layer)

| # | Coverage | Reason |
|---|---|---|
| 2.1–2.7 | **M** | This checklist section itself states "render layer, automated-test blind spot." Pixel-level animation smoothness, white screen, infinite re-render, theme residual color, leaked language keys, topology-animation overlap — these need human eyes or pixel diff, not curl-assertable. This round adds `tests/e2e/specs/team-render.spec.ts` (Playwright + real Electron renderer) covering **the subset where DOM/console assertions can replace the eye**: no console error, no horizontal overflow at `<640px` viewport (`scrollWidth<=clientWidth`), no raw-color residue in computed styles after theme toggle, no obvious i18n-key strings after language switch (e.g. a lowercase-with-`.` key pattern). **Conclusion**: this is "partially automatable", not "100%"; the implemented part is in the results report, the eye-only items are listed there as still needing a manual pass. |

## 3. Remote office · product main path

| # | Coverage | Script/reason |
|---|---|---|
| 3.1.1–3.1.4 | A-existing | SCENARIOS B1–B5 (invite/join/roster) |
| 3.1.5 | A-existing | SCENARIOS B7/B8 (office credential 403 / WS scope) |
| 3.2.1 | P | Backend consistency (epoch/roster/board sync) covered by SCENARIOS E1–E3; the **render-layer sync perception** in "both screens see the same picture simultaneously" is not curl-assertable, marked as needing one manual pass (once, not a regression item) |
| 3.2.2–3.2.6 | A-existing | SCENARIOS H1–H4 (four-way dispatch + remote Lead + post-seal peer chat) |
| 3.2.7–3.2.9 | A-existing | SCENARIOS G1/G3 (owner-served history + offline degradation) |
| 3.3.1–3.3.5 | A-existing | SCENARIOS I1–I5, K4, L1 |
| **true dual physical machine** | **M** | This sandbox has only one machine; `docs/decentralized-local-testing.md` §Limitations explicitly states same-machine multi-instance is not faithful to "true cross-machine networking" (no true partition/loss/clock skew). This is not a sandbox limitation we can solve here — it's an existing honest declaration; we don't reinvent a wheel to "fake" true dual-machine results. |

## 4. Upgrade compatibility & regression

| # | Coverage | Script/reason |
|---|---|---|
| 4.1 | A | `checklist-upgrade-migration.mjs`: construct an "old-version" data dir (no `activity_entries` v4 migration, team-related tables not migrated), boot with the current build, assert migration completes silently, `_migrations` records app_runtime=4, old data readable |
| 4.2–4.3 | A | Same script: a normal (non-team) automation digital-human scheduled task + in-chat report_to_user, assert activity entries persist, no FK errors |
| 4.4 | A | Same script: preseed a team "created before upgrade" in the old data dir, Run directly after upgrade, assert history is reviewable |
| 4.5 | A | Same script: the `pruneOldData` path — create an expired run then trigger cleanup, assert old runs deleted, chat entries intact |

## 5. Performance & resources

| # | Coverage | Reason |
|---|---|---|
| 5.1 | P | `checklist-perf.mjs` runs a **shortened** long run (duration configurable, defaults to a short demo window + notes on how to run the full 30 min), asserting no crash throughout, memory falls back after finishing, HTTP stays responsive; the true 30-min variant is written and runnable via `--long-run-minutes 30` but was not run for the full duration due to session time limits |
| 5.2 | A | 3 teams running in parallel, assert no deadlock, all complete |
| 5.3 | A | Construct a hundred-message transcript, assert history read returns within seconds |
| 5.4 | **M** (shortened to P) | The checklist asks for a "2-hour soak"; the script implements the same check logic (stable heartbeat / no reconnect storm / steady memory) but, limited by session length, only runs a shortened window (default configurable, `--soak-minutes` to run the full 2 hours). The true 2-hour result is left for you to run separately as needed |
| 5.5 | A | Assert the token-usage field exists and is in a reasonable order of magnitude (non-zero, non-astronomical) |

## 6. Packaged-build real-install testing

| # | Coverage | Reason |
|---|---|---|
| 6.1–6.5 | **M** | Needs a real code-signing certificate, macOS Gatekeeper/keychain authorization dialogs, real double-click launch, real firewall prompts — these are OS-level human interactions that cannot be faithfully simulated in a headless/CI sandbox (`docs/decentralized-local-testing.md` also introduced the "preseeded plaintext identity file" workaround precisely because the keychain dialog would hang a headless node). **No automation script exists for this section** — the single-instance-lock logic can be exercised elsewhere, but real `.dmg`/`.exe` install + first launch + dual machine must be executed manually per 6.1–6.5, results written back into the original table of `投产测试清单.md`. |

## 7. Data lifecycle & security

| # | Coverage | Script/reason |
|---|---|---|
| 7.1 | A | `checklist-data-lifecycle.mjs`: after deleting a team, assert team/epoch/board cleared, member digital-human proper (the app) retained |
| 7.2 | A | Wrong PIN → 401, office credential hitting the control plane → 403, assert response body/logs contain no sensitive plaintext |
| 7.3 | A | After uninstalling a digital human that was a team member, the team-detail endpoint degrades gracefully (no 500) |
| 7.4 | A | Scan log files with regex for common key/token/secret patterns, assert no plaintext hits |
| 7.5 | **M** | "Backup–restore to another machine" needs a real second physical machine; the sandbox approximates by "copy the data dir to another isolated dataDir + a fresh process" to verify same-machine recoverability semantics, as partial evidence — not true cross-machine acceptance |

---

## Conclusion

- **The part that can be 100% automated with real assertion results**: the vast
  majority of sections 1, 3 (functional/consistency plane), 4, and 7, plus the core
  logic of section 5 except the "2-hour / 30-min real soak." This part was fully
  implemented, really executed, results recorded, and every real bug found was fixed.
- **The part that cannot be 100% automated, honestly flagged as manual or a
  shortened substitute**: section 2 (render layer, eye judgment), section 6
  (packaged-build OS-level UI), true dual-physical-machine network fault injection,
  7.5 true cross-machine backup/restore, and the full-duration soaks of 5.1/5.4.
  These are not "lazy skipping" — the **nature of this class of verification means
  curl/headless e2e cannot replace a real machine and human eyes** — existing docs
  (`decentralized-local-testing.md` Limitations, and the checklist's own "render
  layer, automated-test blind spot" annotation) make the same honest declaration.
- Therefore the answer to "can 100% complete testing be implemented" is: **the
  functional and consistency layer can be 100% automated with real results; but the
  checklist explicitly includes OS-level / physical-multi-machine / human-perception
  items, and for those we can only provide "automated substitute verification +
  explicit flag that a manual pass is still needed" — there is no deceptive
  "all green."**

# Load-Bearing Architecture Laws

> The small set of invariants that keep the **global** structure from collapsing.
> They rank **above** every cosmetic convention (theme tokens, i18n, responsive):
> violating one is a crack in the foundation, not a scuff on a wall — stop, surface
> it, do not "fix it quietly and move on."
>
> Two things to hold while reading:
> 1. **Each law teaches judgment, not a checklist.** Wherever this repo enumerates
>    concrete instances elsewhere (which seams exist, which tiers exist), treat that
>    list as an example, not as the law. Lists go stale; judgment does not.
> 2. **Each law carries its own negative space** — when *not* to apply it, and the
>    cheaper alternative to try first. A law with only a positive face eventually
>    gets applied blindly and becomes its own anti-pattern.

## L1 — Public Surface Only (module encapsulation)

**Law.** A module is consumed only through its declared public surface (its `index`
barrel or exported contract). Importing another module's internal files is
forbidden — it silently promotes an implementation detail into a load-bearing
dependency, and that module can no longer be rebuilt without breaking its
consumers. This is the law that makes "any room may be demolished" true.

**Applies when** importing across a module boundary (same tier, or one tier down).

**Try first (cheaper than punching through):**
1. Need only a type → `import type` from the module's public types or `shared`.
2. What you need isn't exported → ask whether it *should* be part of the surface.
   If yes, export it deliberately (with a one-line contract comment). If no, you
   are reaching into an internal — stop and rethink.

**Not this law's job.** A cross-tier *upward runtime* need is L2, not this.

**Anti-example (do not imitate).** `ipc/app.ts` importing `getSpace` and
app-runtime internals from `space.service` — transport reaching into a service's
internals *and* doing orchestration.
**Positive example.** `apps/spec/index.ts` — an explicit surface with a "Does NOT"
contract (renderer-safe, no Electron/Node).

## L2 — Dependency-Inversion Seam (upward runtime need)

**Law.** When a lower tier needs an upper tier's *runtime behavior*, the only legal
resolution is: the lower tier declares an interface slot, and the upper tier
registers its implementation at bootstrap via a downward call. Never import
upward — not even a type-only shortcut — to satisfy a runtime need. Adding a seam
is itself an architectural act: make it explicit, never slip it in.

**Applies only when all hold.** (a) the need is a runtime behavior (a function to
call), not a type/constant; (b) the behavior genuinely belongs in the upper tier
(moving it down would be unnatural); (c) the call site cannot receive the
dependency as a parameter.

**Try first, in order — the seam is the last resort:**
1. A type/constant? → move it to `shared`.
2. Misplaced code? → move it to the correct tier. Don't invert a bad boundary; a
   seam only welds it in place.
3. A single local call site? → pass the dependency as a parameter. Explicit and
   testable beats hidden global state.
4. None of the above → then a seam.

**Cost to respect.** Every seam is hidden global state plus a bootstrap ordering
constraint. The more seams, the more fragile `bootstrap/extended.ts` becomes. Do
not breed them.

**Anti-example (do not imitate).** `foundation/config.service.ts` importing the
`AnalyticsConfig` *type* from `services` — it's a type, so the fix is to move it to
`shared/types`; not a seam, and not an upward import.
**Positive example.** `app-bridge`, `memory/sdk`, the daemon's
`setDaemonStealthInjector` — each a genuine upper-tier runtime behavior that cannot
be threaded in as a parameter.

## L3 — Classify Every Change First: Room or Wall

**Law.** Before writing, classify the change. Intra-module implementation (a *room*)
is free — refactor, rewrite, or delete at will. A structural change (a *wall*) must
be surfaced with a reason before proceeding — never slipped in unannounced.

**Structural = any of:** adding / moving / removing a tier or module boundary;
adding a seam; adding a cross-tier dependency edge; changing a module's public
surface / contract; changing dependency direction; introducing a new module that
many others will depend on.

**Applies to** every change.

**Why.** "Local may rot, global must not" holds only when the author knows when
they are touching the global. The point is to make that judgment explicit; it does
not forbid structural change — it forbids *silent* structural change.

## L4 — Reconcile Before You Extend

**Law.** Code is the only source of truth. Before extending or depending on a
module, check its actual imports / exports against what its DESIGN / ARCHITECTURE
claims. A mismatch is a fork: either fix the code or fix the doc — never build on a
stale claim.

**Applies when** entering a module you are about to change or depend on.

**Why.** No single context holds the whole building; the map will drift.
Reconciliation must be a reflex on entry, not a hope.

## L5 — Recognize De-Facto Load-Bearing Walls (fan-in awareness)

**Law.** A module depended on by many others, or spanning multiple tiers, has
become load-bearing in fact — however small or "ordinary" it began. Treat changes
to it as touching a wall (see L3), and be wary of any proposal to create a new
module that everything will depend on.

**Applies when** changing a high-fan-in module, or introducing a new
shared / global module.

**Walls already hardened (examples, not exhaustive), in two tiers:**

*Self-serve walls — read its DESIGN, surface a reason per L3, then proceed:*
- **`platform/store`** — the SQLite + migrations foundation; all persistence rides
  on it. Schema changes must carry a versioned migration.
- **`platform/event`** — the `Emitter` primitive; the entire "decentralized, no
  global bus" design rests on it.
- **`foundation/config`** — bedrock configuration depended on almost everywhere;
  `onApiConfigChange` cascades into agent-session teardown.
- **`apps/runtime`** — the orchestration boundary; the convergence point for
  automation. Do not push orchestration into transport.

*Human gate — nothing proceeds without an explicit human sign-off:*
- **`services/agent`** — the AI engine, the largest subsystem; nearly all AI
  behavior flows through it. **Changing it requires human confirmation first — not
  "read the DESIGN and proceed."** Reading `services/agent/DESIGN.md` (the
  engine-adapter contract, the per-turn frame contract) is the homework, but the
  go / no-go stays with a human. Treat it as the highest tier of wall.

**Why.** In a giant codebase the most dangerous walls are the undeclared ones —
they accreted dependents quietly. Notice the ground hardening before it cracks; for
the walls above that are already hard, treat them as walls from the first line.

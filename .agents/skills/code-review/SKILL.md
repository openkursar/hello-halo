---
name: code-review
description: Must be invoked when the user asks to commit review.
---

git status and reviews the current code. For SDK changes, read repository `src/sdk/halo-sdk/AGENTS.md` and `src/sdk/halo-sdk/REVIEW.md`; use `src/sdk/halo-sdk/TESTING.md` for verification. Inspect the SDK working tree explicitly while it remains nested; for host integration, verify both packages. Start 2-3 members separately（agent teams）, first review individually, then exchange opinions with each other and raise challenges until the members reach a consensus before returning a conclusion. Give every member reviewing SDK changes the same SDK guidance.
Each member is required to observe:
1. Whether it conforms to the halo-dev skill architecture, specifically: module/file structure (does the file belong to this module at all, does its directory placement match its responsibility boundary, should it be re-abstracted or split), naming (file, directory, export and symbol names follow the conventions of 2-3 sibling files), and dependency relationships (layer direction is respected, no cross-layer reach-through, no circular imports, no dependency introduced merely because it was convenient). When a change pairs two modules, verify BOTH directions — the diff advertises one, and the reverse import is where reach-through hides. Beyond conformance: whether the design is highly maintainable and modular, and whether it aligns with long-term architectural planning and code quality evolution.
2. Whether it affects existing functionality or causes regression issues.
3. Whether the new feature has obvious business defects or code bugs.
4. Performance and feature value: read and apply `product-principles` §1 even to small changes, across affected client scenarios. Check startup-to-usable, interaction/high-frequency paths and recurring/scaling costs. Hold approval for unapproved costs covered by that gate; report them as **needs owner decision**, with evidence/uncertainty, a cheaper alternative and a recommendation.
The above four points must be strictly communicated to all members.

A review finds problems; it must not change product intent. Communicate these rules to all members as strictly as the four points:
- Classify every finding as one of: **bug** (a user gets a wrong result), **regression** (something that worked no longer does), or **suggestion** (code quality, hardening, hypothetical future risk). Bugs/regressions and unresolved performance approvals under point 4 block approval; suggestions are listed separately and are never dispatched as fixes without the owner's approval.
- Code that looks odd is presumed to be a requirement until evidence shows it is a defect. A pinned value, a deliberate restriction, or a missing check may be the product's choice — ask, do not "fix".
- Every proposed fix must state whether user-visible behavior changes. A fix that changes what users see or do (including in fallback or rare paths) needs the owner's approval first; prefer the narrowest fix that removes the defect and leaves all other behavior identical.
- Unverified hypotheses (e.g. "this probably fails on Windows") are labeled as such and are not grounds for redesigning a flow that has already been tested.
- The final report groups findings into: must fix (bug/regression, fix leaves behavior unchanged) / needs owner decision (fix changes behavior) / suggestions. Write it for the owner per the human-comms skill: scenarios first, no code symbols.
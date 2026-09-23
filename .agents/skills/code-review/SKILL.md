---
name: code-review
description: Must be invoked when the user asks to commit review.
---

git status and reviews the current code. Start 2-3 members separately（agent teams）, first review individually, then exchange opinions with each other and raise challenges until the members reach a consensus before returning a conclusion.
Each member is required to observe:
1. Whether it conforms to the halo-dev skill architecture, specifically: module/file structure (does the file belong to this module at all, does its directory placement match its responsibility boundary, should it be re-abstracted or split), naming (file, directory, export and symbol names follow the conventions of 2-3 sibling files), and dependency relationships (layer direction is respected, no cross-layer reach-through, no circular imports, no dependency introduced merely because it was convenient). When a change pairs two modules, verify BOTH directions — the diff advertises one, and the reverse import is where reach-through hides. Beyond conformance: whether the design is highly maintainable and modular, and whether it aligns with long-term architectural planning and code quality evolution.
2. Whether it affects existing functionality or causes regression issues.
3. Whether the new feature has obvious business defects or code bugs.
4. Whether there are performance issues, covering both first-screen performance (initial render, resource/bundle size, code splitting and lazy loading) and runtime performance (unnecessary re-renders, large-list rendering, memory leaks, redundant computations and requests).
The above four points must be strictly communicated to all members.

A review finds problems; it must not change product intent. Communicate these rules to all members as strictly as the four points:
- Classify every finding as one of: **bug** (a user gets a wrong result), **regression** (something that worked no longer does), or **suggestion** (code quality, hardening, hypothetical future risk). Only bugs and regressions block release; suggestions are listed separately and are never dispatched as fixes without the owner's approval.
- Code that looks odd is presumed to be a requirement until evidence shows it is a defect. A pinned value, a deliberate restriction, or a missing check may be the product's choice — ask, do not "fix".
- Every proposed fix must state whether user-visible behavior changes. A fix that changes what users see or do (including in fallback or rare paths) needs the owner's approval first; prefer the narrowest fix that removes the defect and leaves all other behavior identical.
- Unverified hypotheses (e.g. "this probably fails on Windows") are labeled as such and are not grounds for redesigning a flow that has already been tested.
- The final report groups findings into: must fix (bug/regression, fix leaves behavior unchanged) / needs owner decision (fix changes behavior) / suggestions. Write it for the owner per the human-comms skill: scenarios first, no code symbols.
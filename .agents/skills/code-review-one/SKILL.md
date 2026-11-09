---
name: code-review-one
description: Called only when actively triggered by the user..
---
git status and reviews the current code. For SDK changes, read repository `src/sdk/halo-sdk/AGENTS.md` and `src/sdk/halo-sdk/REVIEW.md`; use `src/sdk/halo-sdk/TESTING.md` for verification. Inspect the SDK working tree explicitly while it remains nested; for host integration, verify both packages.
1. Whether it conforms to the halo-dev skill architecture, specifically: module/file structure (does the file belong to this module at all, does its directory placement match its responsibility boundary, should it be re-abstracted or split), naming (file, directory, export and symbol names follow the conventions of 2-3 sibling files), and dependency relationships (layer direction is respected, no cross-layer reach-through, no circular imports, no dependency introduced merely because it was convenient). Beyond conformance: whether the design is highly maintainable and modular, and whether it aligns with long-term architectural planning and code quality evolution.
2. Whether it affects existing functionality or causes regression issues.
3. Whether the new feature has obvious business defects or code bugs.
4. Performance and feature value: read and apply `product-principles` §1 even to small changes, across affected client scenarios. Check startup-to-usable, interaction/high-frequency paths and recurring/scaling costs. Hold approval for unapproved costs covered by that gate; report them as **needs owner decision**, with evidence/uncertainty, a cheaper alternative and a recommendation.
The above four points must be strictly communicated to all members.
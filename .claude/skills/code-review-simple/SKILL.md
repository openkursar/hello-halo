---
name: code-review-one
description: Called only when actively triggered by the user..
---
git status and reviews the current code. 
1. Whether it conforms to the halo-dev skill architecture, specifically: module/file structure (does the file belong to this module at all, does its directory placement match its responsibility boundary, should it be re-abstracted or split), naming (file, directory, export and symbol names follow the conventions of 2-3 sibling files), and dependency relationships (layer direction is respected, no cross-layer reach-through, no circular imports, no dependency introduced merely because it was convenient). Beyond conformance: whether the design is highly maintainable and modular, and whether it aligns with long-term architectural planning and code quality evolution.
2. Whether it affects existing functionality or causes regression issues.
3. Whether the new feature has obvious business defects or code bugs.
4. Whether there are performance issues, covering both first-screen performance (initial render, resource/bundle size, code splitting and lazy loading) and runtime performance (unnecessary re-renders, large-list rendering, memory leaks, redundant computations and requests).
The above four points must be strictly communicated to all members.
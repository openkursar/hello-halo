---
name: code-review
description: Must be invoked when the user asks to commit review.
---

git status and reviews the current code. Start 2-3 members separately（agent teams）, first review individually, then exchange opinions with each other and raise challenges until the members reach a consensus before returning a conclusion.
Each member is required to observe:
1. Whether it conforms to the halo-dev skill architecture, whether the design is highly maintainable and modular, and whether it aligns with long-term architectural planning and code quality evolution.
2. Whether it affects existing functionality or causes regression issues.
3. Whether the new feature has obvious business defects or code bugs.
The above three points must be strictly communicated to all members.
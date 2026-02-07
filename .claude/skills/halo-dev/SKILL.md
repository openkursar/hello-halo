---
name: Halo Development Context
description: Essential project context for AI developers working on Halo. Must read before writing any code.
---

# Halo Development Context

## Required Reading

**Before writing any code**, read these documents in order:

1. **CONTEXT.md** — Project vision, positioning, development principles, and code navigation
2. **ARCHITECTURE.md** — Directory structure, type system, IPC channels, module design, and data flow
3. **CHANGELOG.md** — Feature evolution history and key implementation details

Do not skip this step. These documents contain architectural decisions, conventions, and constraints that directly affect how code should be written.

All code changes must comply with the patterns, conventions, and structures described in **ARCHITECTURE.md**. This includes directory organization, IPC channel conventions, styling rules, state management patterns, and type definitions. If a change conflicts with the documented architecture, update the architecture document first with justification, then proceed.

## Keeping These Documents Updated

After completing a development task, evaluate whether these documents need updating. Apply the following rules:

**Update when** the change significantly affects how a developer understands the codebase:
- New module or service added to the architecture
- New IPC channel introduced
- Major refactoring that changes code organization
- New architectural pattern or convention established
- Core data type added or significantly changed

**Do not update** for changes that don't affect architectural understanding:
- Bug fixes
- Minor features within existing modules
- Styling or UI tweaks
- Performance optimizations that don't change structure
- Dependency updates
- Code cleanup or formatting

The threshold is: **would a new AI developer make wrong assumptions without this information?** If yes, update. If no, skip.

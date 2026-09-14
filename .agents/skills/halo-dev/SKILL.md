---
name: halo-dev
description: important!!! Must read and follow before writing or editing any code, and equally before planning, designing, or discussing architecture for this codebase (module placement, directory layout, IPC channels, theme, i18n) — decisions made while planning are what the later edit is bound by. Entry point to CONTEXT.md / ARCHITECTURE.md / quick.md. Covers architecture, conventions, quality standards, and responsive design requirements.
allowed-tools: Read, Write, Edit, Bash
user-invocable: true
---

# Halo Development Context v3

## Mandatory Entry (Read in Order)

0. `LAWS.md` — **Load-bearing architecture laws. Read first; they override every other rule in this skill.**
1. `CONTEXT.md` — Product vision, development principles (styling, responsive, security, i18n), and current state.
2. `ARCHITECTURE.md` — Directory structure, data types, IPC channels, theme system, CSS rules, responsive design, layout modes, multi-platform, local storage, tech stack.
3. `quick.md` — Hard development rules (with code examples), task-to-file routing, and checklists.

**Do not start implementation before reading these files.**

All code changes **must** comply with the patterns, conventions, and structures described in these documents. This includes:
- Responsive design (mobile-first, `sm:` breakpoint at 640px)
- Theme system (CSS variables only, no hardcoded colors)
- Tailwind-first styling (no unnecessary CSS files)
- IPC channel synchronization (preload + transport + API)
- i18n (`t('English text')` for all user-facing strings)
- Production logging

If a change conflicts with the documented architecture, update the architecture document first with justification, then proceed.

## Development Priority (Non-Negotiable)

- **Modularity, quality, and maintainability come first.**
- **Performance must not regress** (startup, runtime latency, memory).
- **Responsive design is mandatory** — every UI change must work at mobile width (< 640px).
- **No hardcoded colors** — use only CSS variable-based theme tokens.
- If a quick fix conflicts with architecture quality, choose the maintainable modular solution and request explicit user approval before proceeding.

## Fast Navigation Policy

After the mandatory entry docs:

- Jump directly to touched module `DESIGN.md`:
  - `src/main/apps/*/DESIGN.md`
  - `src/main/platform/*/DESIGN.md`
- For transport-level changes, inspect:
  - `src/main/ipc/`
  - `src/main/http/routes/index.ts`
  - `src/preload/index.ts`
  - `src/renderer/api/index.ts`
- For renderer changes, check:
  - Existing component structure in `src/renderer/components/`
  - Existing stores in `src/renderer/stores/`
  - Existing hooks in `src/renderer/hooks/`

## Source of Truth Priority

When docs and code differ:

1. Actual code in `src/**`
2. Module design docs (`src/main/apps/*/DESIGN.md`, `src/main/platform/*/DESIGN.md`)
3. `quick.md`, `ARCHITECTURE.md`, `CONTEXT.md`

## Keeping These Documents Updated

After completing a development task, evaluate whether these documents need updating. Apply the following rules:

**Update when** the change significantly affects how a developer understands the codebase:
- New module or service added to the architecture
- New IPC channel introduced
- Major refactoring that changes code organization
- New architectural pattern or convention established
- Core data type added or significantly changed
- New component directory or page added

**Do not update** for changes that don't affect architectural understanding:
- Bug fixes
- Minor features within existing modules
- Styling or UI tweaks
- Performance optimizations that don't change structure
- Dependency updates
- Code cleanup or formatting

The threshold is: **would a new AI developer make wrong assumptions without this information?** If yes, update. If no, skip.

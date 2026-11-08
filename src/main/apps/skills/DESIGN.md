# Skill management

This module owns the product's effective skill inventory, file-oriented personal
skill management and safe conversion of legacy installations. It consumes App
Manager's public contract and `services/skills`; transports forward requests only.
It does not create engine sessions or own digital-human execution.

## Sources and authority

Every skill is a file in the user's `.agents/skills` of its scope, with existing
`.claude/skills` and command-file compatibility; there is no Halo-private skill
folder. Only preferences and references are retained for discovered files, not
their instruction bodies. Store, bundled and built-in skill records keep their
package in App Manager and are written to the same folders, named by command
name, and never over a skill that already stands there. Their `spec.name` is a
command identity, not an ownership proof. Records found under the retired
private roots (`<Halo data>/skills`, `<space>/.halo/skills`) move into the shared
folder when their scope is read; an occupied destination leaves the skill working
where it is.

Installation metadata is an internal versioned `skill` entry in user overrides,
not a package field. It records the installed file path, customization state,
provenance and completed migration. Personal external-file preferences use a
small versioned per-file store in `services/skills`, shared with manager entry
points so workspaces sharing a project share availability. No watcher or
all-space disk scan is needed to maintain either.

## Public operations

The shared `skills` RPC contract provides scoped list/detail, import, save, enable,
move preview/move, copy, trash, export and legacy recovery. File mutations accept
opaque discovered IDs and optimistic revisions, resolve them against allowed
roots again, and never accept arbitrary write paths from a renderer. Per-scope
lists include global entries and disclose truncation and unreadable roots.

Space beats global, then personal beats installed within one scope. Equal-priority
conflicts are visible and load neither candidate; canonical aliases are one copy.
Disabling one copy can reveal a lower-priority copy and the UI must say so.

## Engine boundary

The existing App bridge gains an optional effective-catalog provider, declared in
services using renderer-safe shared entry types. Apps registers its implementation
at runtime bootstrap. SDK preparation requests the catalog once when creating an
engine session, not once per model/tool step. Halo SDK receives the explicit list
(including an explicit empty list); independent SDK callers retain discovery.
Other engines read the same shared folders: Codex and dsh find them directly, and
Claude Code, which only reads `.claude`, gets a Halo-owned directory of links
(`services/agent/engine-skill-links.ts`) passed as an extra directory, so no project
setting or user file is changed and no working directory is copied. An engine that
reads the folders itself ignores the library's enable switch.

## Lifecycle

All old App Manager skill entry points use the same file authority: pause does not
remove files, resume does not restore stale personal content, and personal edits
never resynchronize a stored body. Bundled skills are not cascade-deleted when a
digital human is removed. Deleting a workspace preserves external personal files.
User deletion retains only the tombstone needed to prevent automatic bundled
reinstallation; it does not expose a new soft-delete workflow.

Migration is lazy and scope-bounded. Before file authority is established, the old
installation record is the authoritative package: a missing generated directory
is not a deletion decision. Migration reads that record through the manager's
stored-skill accessor, materializes it without overwriting existing files, verifies
the package and only then records the file reference. It also repairs the earlier
missing-directory marker while the original package is still retained. After a
successful migration, missing personal files are never regenerated from old data.
Old uninstalled-only content stays recoverable, not reenabled or pruned. Legacy
disk modifications are preserved; conflicts and unreadable sources remain local
to the affected skill. Successful preservation is not a library-wide warning.

## Verification

The acceptance catalog is the product contract. Tests must check actual files and
engine requests as well as UI state; old tests asserting that pause deletes files
are obsolete. No production directories or user credentials are test fixtures.

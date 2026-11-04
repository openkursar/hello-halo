# Skill management

This module owns the product's effective skill inventory, file-oriented personal
skill management and safe conversion of legacy installations. It consumes App
Manager's public contract and `services/skills`; transports forward requests only.
It does not create engine sessions or own digital-human execution.

## Sources and authority

Personal skills are files in user/project `.agents/skills`, with existing
`.claude/skills` and command-file compatibility. Only preferences and references
are retained for discovered files, not their instruction bodies. Store, bundled
and built-in skill records retain their package in App Manager and materialize
in Halo's private global/workspace skill directories. Their `spec.name` is a
command identity, not an installation identity or ownership proof.

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
Other engines disclose unsupported resolution/disablement rather than silently
changing project settings or using a synthetic copied working directory.

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

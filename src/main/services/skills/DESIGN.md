# Skills

The file layer owns discovery, bounded metadata reads, canonical file identity and
safe package operations. It has no App Manager, engine, renderer or transport
dependency. `apps/skills` supplies installation records and owns the product
inventory and mutations. File-identity preferences are stored here so every
manager and discovery entry reads the same availability choice. Files are authoritative for personal
skills; installed packages remain authoritative for store and bundled skills.

## Resolution

Only the requested workspace and user roots are checked. Discovery reads metadata
on demand through a bounded file-stamp cache, follows root aliases for identity,
and never watches files. A whole package is read only for editing, copying,
exporting, replacing or migrating it. Private installation roots are not scanned:
only explicit installation records authorize those files as skills.

The product resolves scope and origin before handing the selected file entries to
an engine. The same result supplies the library, digital-human availability and
Halo SDK. A selected source that disappears cannot fall back during invocation.

## File operations

A mutation names an already discovered copy, not an arbitrary renderer-supplied
path. The file layer checks a revision before writing. Replacing a package stages
the complete replacement, checks the old source again, and rolls back on failure.
Editing instructions alone preserves all supporting resources. Imports retain
binary bytes; archive traversal and unsafe links are rejected rather than omitted.
Deletion moves the selected directory or link to the OS trash, never its resolved
link target. A failed trash operation does not become permanent deletion.

The files module is synchronous only for explicit bounded mutations; directory
metadata scanning is bounded and cached. No startup crawl, session polling or
per-tool-call logging is introduced.

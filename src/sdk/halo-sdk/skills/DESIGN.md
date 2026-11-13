# Skill resolution

This module owns skill discovery, source precedence, metadata and instruction
loading. The Skill tool, slash commands and prompt catalog consume its public
`index.ts`; none of them searches the filesystem independently. It has no
session registry, background work or dependency on the host application.

Resolution preserves the configured order: each project agent directory's
`commands` then `skills`, the user configuration's `skills`, then each home
agent directory's `commands` and `skills`. Within one directory a flat Markdown
file wins over the same name's `SKILL.md`. Resolved directories and files are
deduplicated. Name matching is case-insensitive, as it is for slash commands;
an optional `.md` suffix is normalized consistently. Bundled `commit` and `pull-request` skills are last-resort entries;
a disk skill with either name replaces the bundled entry. Host slash commands
are still applied after skill commands by the command registry.

A catalog entry contains metadata and a source reference, never an instruction
body. Each query or session creates one immutable catalog shared by prompt
rendering, tool contexts and slash commands. Custom Skill wrappers remain intact;
they receive the same catalog through ToolContext. Direct low-level consumers
can share it through SkillContext.skillCatalog.

Both the SDK root and `/worker` export `getBuiltinSkillDefinitions()` and
`BuiltinSkillDefinition`. The pure getter returns frozen metadata and instruction
strings from the same bundled definitions used by invocation. It performs no I/O,
starts no workers and installs nothing. Hosts may materialize these definitions in
their own inventory; enablement, deletion and update policy remain host concerns.
Calling the getter never adds entries to an explicit catalog.

Public `Options.skillCatalog` accepts a serializable `SkillCatalog` of entries
with `name`, `description`, optional `whenToUse`/`argumentHint`, and a source:
`{ kind: 'file', path: absolutePath }` or `{ kind: 'builtin', name }`.
These types are exported from the SDK root. An explicit empty array provides no
skills, including no bundled defaults. Omission preserves standalone discovery.
Option resolution validates names, duplicate normalized names, metadata types,
absolute file paths and known builtin sources, then copies and freezes the
metadata. Invalid input rejects setup rather than recovering via discovery;
validation does not read files or load bodies. The host owns source selection,
conflict resolution and enablement; the SDK knows no host storage or product state.

Queries, sessions, commands, tool contexts and grouped workers share this
catalog. Collaborators inherit the source's pinned catalog even when using
another working directory; tool restrictions can hide Skill entirely but never
cause rediscovery. Catalog visibility grants no extra tool permissions
and is not a filesystem sandbox. New session instances receive new catalogs;
existing instances retain sources and read current bodies on invocation.

Metadata reads use at most 16 KiB per file. Invocation reads the selected
source only, with a 1 MiB limit, removes frontmatter and expands arguments in one
pass. Execution directives such as `context: fork` are not interpreted by the
SDK loader; it returns instructions to the existing caller and starts no alternate
executor. A missing or unreadable selected source fails rather than switching to a
different workflow. Bundled definitions come from the Rust Harness catalogs and
resources; the build also emits JavaScript baseline assets for synchronous
constants. Direct and Worker invocation use the same native definitions without
requiring a source checkout.

The prompt catalog has a fixed text budget and points to `Skill(list)` if entries
do not fit. Large lists are bounded too; `args` filters list entries by name.
A disabled Skill tool also disables its catalog and generated slash
commands. A slash invocation expands the actual instructions directly into the
user message; it does not ask the model to invoke the Skill tool again.

After history rewriting, the prompt layer can retain the names of the three
most recently loaded skills. This bounded reminder tells the model to reload
instructions that are no longer in view. It contains neither instruction bodies
nor arguments, does not authorize actions, and is recoverable from its own
message after another compaction. Reloading uses the live session's pinned source,
but reads its current instructions. A missing source fails closed rather than
falling back to a lower-priority workflow. A newly created or resumed session
instance discovers a new catalog. Successful Skill call/result pairs and explicit
slash expansion markers are its only activation sources. It introduces no
module-level session state to clean up.

Missing optional search directories are normal. Unexpected discovery, metadata
or loading failures log one warning at the owning operation; instruction bodies
and invocation arguments are never logged. Successful tool calls do not log.

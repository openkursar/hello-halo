# Halo Official Guides — Index

Halo's own documentation about how it works, written for agents rather than for the docs site.
Everything here is raw markdown and is read with the `read_halo_doc` tool.

## How to read these

Paths are relative to this document. Pass them to `read_halo_doc` exactly as written below, e.g.
`create-digital-human/SKILL.md`. Each guide's entry document lists its companion documents, so
read the entry first and follow it from there.

This index is published alongside the guides and is updated whenever a guide is added, so it —
not any list baked into the client — is the authoritative answer to "what documentation exists".

## Available guides

| Entry document | Covers |
|---|---|
| `create-digital-human/SKILL.md` | Authoring and updating digital humans (automation apps): the interview checklist, how triggers actually work (including WeCom/IM), the App Spec field reference, and worked examples from production apps. Read before calling `create_automation_app` or `update_automation_app`. |

## When a document is missing

If a path here returns nothing, the documentation host may be unreachable and this Halo version's
offline snapshot may predate the document. The read tool reports which source answered; treat an
offline snapshot as possibly outdated and say so if the answer depends on recent behavior.

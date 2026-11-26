# Bundled CLI tools

Standard CLI packages (`*.hcli`, schema `halo.cli/1`) placed here before
packaging ship with the client and are imported into the user's tool store on
first use. This directory can also supply `trusted-keys.json` and an optional
`catalog.json` using the existing `halo.cli.catalog/1` wire format. These
build inputs are not tracked in the repository.

An exact built-in catalog entry must match the package ID, version, archive
SHA-256 and payload integrity. Use `<id>-<version>.hcli` for selected packages.
The client checks package and text signatures when trusted keys are configured.
A tool entry with an empty `versions` array can supply a skill only for a
matching preset package; the entry cannot install a tool by itself.

The version guide takes precedence over the tool skill and the original package
guide. Bundled text does not replace live catalog decisions or edited skill
files. The bundled catalog is not a live sync and makes no network requests.
See `src/main/services/cli-tools/DESIGN.md`.

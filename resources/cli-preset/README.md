# Bundled CLI tools

Delivery bundles (`*.zip`, schema `halo.cli.bundle/1`) placed here before
packaging ship with the client and are imported into the user's tool store on
first use. A bundle carries a tool's `halo.cli/1` package and its skill
together. Each bundle needs an entry in `catalog.json` (`halo.cli.catalog/2`)
naming its ID, version, revision, SHA-256 and size; use
`<id>-<version>-r<revision>.zip` as the file name. A catalog entry marked
revoked keeps its bundles from being imported. With `trusted-keys.json`
present, every bundle must carry a valid `bundle.sig` from one of its keys.

Plain `.hcli` packages are also accepted; they carry no skill of their own and
fall back to their package guide. These build inputs are not tracked in the
repository. The bundled catalog is not a live sync and makes no network
requests. See `src/main/services/cli-tools/DESIGN.md`.

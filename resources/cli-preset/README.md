# Bundled CLI tools

Standard CLI packages (`*.hcli`, schema `halo.cli/1`) placed here before
packaging ship with the client and are imported into the user's tool store on
first use. Only `*.hcli` files are packaged; this directory is otherwise empty
in the repository.

A preset becomes the current version of its tool unless the user or a catalog
already chose another version. See `src/main/services/cli-tools/DESIGN.md`.

# runtimes

Runtimes that ship inside the installer and carry their own dependency manifest.
Each directory is self-contained and has the same shape:

| File | Role |
|---|---|
| `package.json`, `package-lock.json` | Locked dependencies of the runtime. Never part of the app's dependency graph. |
| `build.mjs` | Entry point (`npm run runtime:<name>`): installs from the lockfile and writes `resources/<name>-runtime/` (not tracked). |
| `manifest.cjs` | Optional. What the runtime is made of, when packaging scripts (`electron-builder.cjs`, `scripts/afterPack.cjs`) must read it too. |
| `plugins/` | Optional. Source that runs inside the runtime's own process and is compiled into it; the main process never imports it. |

| Runtime | Output | Consumed by |
|---|---|---|
| `dsh/` | `resources/dsh-runtime/` | `src/main/services/agent/dsh/` — experimental: not built by `npm run dev` (run `npm run runtime:dsh`); the app build runs it with `--optional`, so a failure ships the app without dsh |
| `office/` | `resources/office-runtime/` | `src/main/services/office-runtime/` |

Independently deployed projects (`gateway/`, `halo-local/`) stay at the repository root.

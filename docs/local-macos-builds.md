# Local macOS builds

`npm run build:mac` builds a packaged app for the current Mac architecture, plus
DMG and ZIP files. It uses local ad-hoc signatures: no Developer ID certificate,
Apple account, notarization upload, or publishing. This is for testing the actual
packaged product with your existing user data, not the development server.

```sh
npm run build:mac
# Quit the installed app, including renamed copies, then:
npm run install:mac
```

The installer copies the completed app to a fresh directory on the destination
volume, verifies its signatures, and replaces the old bundle by rename. It opens
the new app and prints the retained old app's backup path. It does not terminate
active sessions or change user data. Each installation retains one backup; remove
backups you no longer need using the paths printed by the installer.

By default, only the host architecture is prepared and packaged. Use
`npm run build:mac -- --all` for both ARM64 and x64, or `--arm64` / `--x64` for a
specific target. `install:mac` installs the host architecture. Distribution signing
remains a separate workflow: `npm run build:mac-signed`.

## Why the local signing step is explicit

Native executables inside `Contents/Resources/app.asar.unpacked` can retain their
upstream Developer ID signatures. Apple's `codesign --deep` does not recursively
sign arbitrary resource files as nested code. An upstream certificate revocation
can therefore affect a local package even when the outer app is ad-hoc signed.

Local packaging signs every Mach-O resource binary explicitly, then signs and
verifies the app, and verifies those resource binaries individually. Failure stops
the build. `codesign -dv` only displays signature information; it is not verification.
Third-party files in the source `node_modules` are never re-signed in place.

The build probes `codesign_allocate` before compiling. If the selected Xcode path
is broken, it tries installed Command Line Tools without changing the machine's
global Xcode selection. If neither works, install Apple's Command Line Tools;
a paid signing identity is not required.

## Repeated local installation

Avoid editing or copying executable bytes over the installed executable in place.
macOS caches signature information against the file, and Apple recommends replacing
signed files with newly created files rather than overwriting them. The local
installer uses this approach and keeps the previous app recoverable.

Do not turn off global Gatekeeper or use removal of an engine as a packaging fix.
Downloaded ad-hoc builds on another machine can still require explicit user approval;
this local workflow is not a substitute for distribution notarization.

References: [Apple: Updating Mac Software](https://developer.apple.com/documentation/security/updating-mac-software),
[Apple: Code Signing In Depth](https://developer.apple.com/library/archive/technotes/tn2206/).

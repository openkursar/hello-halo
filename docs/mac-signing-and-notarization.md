# macOS Code Signing & Notarization

How to produce a distributable macOS build that opens cleanly on other machines.

> Chinese version: [mac-signing-and-notarization.zh.md](./mac-signing-and-notarization.zh.md)

## Why this is required

On macOS 15+ (Sequoia) and macOS 26+ (Tahoe), Gatekeeper and XProtect block apps that are
not signed with a **Developer ID** certificate and **notarized** by Apple. Ad-hoc signed or
unsigned apps may fail to open ("app is damaged") or be moved to the Trash by a background
scan. The only reliable way to distribute outside the Mac App Store is:

1. Sign every binary with a **Developer ID Application** certificate.
2. **Notarize** the app with Apple (an automated malware/signature scan).
3. **Staple** the notarization ticket into the app so it validates offline.

## Prerequisites (one-time)

1. **Apple Developer Program** membership.
2. **Developer ID Application** certificate + its private key in your login keychain:
   - Keychain Access → Certificate Assistant → *Request a Certificate From a Certificate
     Authority* → save the CSR to disk (this creates the private key locally).
   - developer.apple.com → Certificates → **Developer ID Application** (Profile Type:
     *G2 Sub-CA*) → upload the CSR → download the `.cer` → double-click to install.
   - If `security find-identity -v -p codesigning` shows **0 valid identities**, the Apple
     intermediate certificate is missing. Install it:
     ```bash
     curl -O https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer && open DeveloperIDG2CA.cer
     ```
3. **App-specific password** for notarization: account.apple.com → Sign-In and Security →
   App-Specific Passwords.
4. **Team ID** (10 characters): developer.apple.com → Membership.

## Configuration model (public vs. private)

The tracked `package.json` stays **neutral** so that open-source contributors can build
locally **without** an Apple account:

```jsonc
"mac": {
  "hardenedRuntime": false,   // default off; enabled only for official signed builds
  "notarize": false,          // default off; no Team ID committed to the repo
  "entitlements": "resources/entitlements.mac.plist",
  "entitlementsInherit": "resources/entitlements.mac.plist"
}
```

Signing and notarization are enabled **at build time** via electron-builder config
overrides, so no account-specific value is ever committed:

```bash
-c.mac.hardenedRuntime=true -c.mac.notarize=true
```

`resources/entitlements.mac.plist` carries the entitlements Electron needs under Hardened
Runtime (JIT, unsigned executable memory, library validation).

`scripts/afterPack.cjs` reads `HALO_MAC_SIGN_MODE`: when set to `developer-id` it skips its
fallback ad-hoc signing and lets electron-builder perform the real Developer ID signing.

## Environment variables (never commit these)

| Variable | Purpose |
| --- | --- |
| `APPLE_ID` | Apple account email, used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | 10-character Team ID; electron-builder reads it for notarization |
| `CSC_NAME` | Signing identity name, e.g. `Your Name (TEAMID)` — selects the keychain certificate |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | Alternative to keychain: path to a `.p12` + its password |
| `HALO_MAC_SIGN_MODE` | Set to `developer-id` so `afterPack.cjs` skips ad-hoc signing |

Keep these in a git-ignored file (e.g. `.env.local`) or your CI secret store only.

## Build lifecycle

```
copy app files
  → afterPack hook           (skip ad-hoc when HALO_MAC_SIGN_MODE=developer-id)
  → codesign                 (sign every nested binary with the Developer ID cert)
  → afterSign / notarize     (zip → upload to Apple → wait for "Accepted")
  → staple                   (embed the notarization ticket into the .app)
  → build dmg / zip          (the packaged app already carries the ticket)
```

## Producing a signed build

With the credentials exported as environment variables:

```bash
export APPLE_ID="<your-apple-id>"
export APPLE_APP_SPECIFIC_PASSWORD="<app-specific-password>"
export APPLE_TEAM_ID="<TEAMID>"

# Identity via keychain:
export CSC_IDENTITY_AUTO_DISCOVERY=true
export CSC_NAME="<Your Name (TEAMID)>"
# ...or portable identity via a .p12 (recommended for CI / a second machine):
# export CSC_LINK="/absolute/path/DeveloperID.p12"
# export CSC_KEY_PASSWORD="<p12-password>"

export HALO_MAC_SIGN_MODE=developer-id

npm run build
npx electron-builder --mac --arm64 \
  -c.mac.hardenedRuntime=true -c.mac.notarize=true \
  --publish never
```

Notarization uploads the app to Apple and waits for a verdict. This is usually a few minutes,
but the **first submission from a brand-new account can take much longer** (occasionally
hours) while the account is processed. This is a one-time delay; later submissions are fast.

## Verification (all three must pass)

Mount the produced `.dmg`, then check the `.app` inside:

```bash
codesign --verify --deep --strict --verbose=2 "Halo.app"   # no errors
codesign -dvv "Halo.app"                                    # Authority chain → Apple Root CA
spctl -a -vvv --type exec "Halo.app"                        # source=Notarized Developer ID
xcrun stapler validate "Halo.app"                           # The validate action worked!
```

`spctl` reporting `source=Notarized Developer ID` is the decisive signal that Gatekeeper will
accept the app on other machines.

## Building on a second machine or in CI

The private key exists **only on the machine where the CSR was generated**. To sign elsewhere:

1. Export the identity to a `.p12`: Keychain Access → select the *Developer ID Application*
   certificate → right-click → **Export** → choose `.p12` → set an export password.
2. Transfer the `.p12` securely (never commit it).
3. On the target machine, use the portable path instead of the keychain:
   ```bash
   export CSC_LINK="/absolute/path/DeveloperID.p12"
   export CSC_KEY_PASSWORD="<p12-password>"
   export HALO_MAC_SIGN_MODE=developer-id
   ```
   electron-builder imports the `.p12` into a temporary keychain and signs without any
   interactive authorization prompt. This is the recommended approach for CI and any
   secondary machine.

The same Developer ID certificate signs **any** app under the account — a different app name
or bundle ID does not require a new certificate.

## Troubleshooting

| Symptom | Cause / Fix |
| --- | --- |
| `0 valid identities found` | Apple intermediate cert missing → install `DeveloperIDG2CA.cer` (see Prerequisites) |
| `codesign` stuck at 0% CPU, no progress | A keychain authorization dialog is waiting → click **Always Allow** once; or use `CSC_LINK` (`.p12`) to avoid prompts; or run `security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <login-password> ~/Library/Keychains/login.keychain-db` |
| Notarization `In Progress` for a long time | Apple-side queue; first submission from a new account can take hours. Under 24h, keep waiting. Inspect with `xcrun notarytool history` / `xcrun notarytool info <id>` |
| Notarization `Invalid` | Run `xcrun notarytool log <id>` — it lists which binary failed (usually unsigned or missing Hardened Runtime). Ensure every native binary is signed |
| App is very large / signing is slow | Mobile-only native packages leaked into the desktop build. Exclude them from `mac` `files`, e.g. `"!node_modules/@capacitor/**"` |
| Existing users can't auto-update | Squirrel.Mac requires a consistent signing identity between installed and new versions. Users on a previous unsigned/ad-hoc build may need a one-time manual re-download |

## Security notes

- Never commit: Apple ID, app-specific password, Team ID, `.p12`, or the certificate name.
- Keep the signing identity and notarization credentials in git-ignored files or a secret
  store only.
- The tracked build config must not force `notarize`/`hardenedRuntime` on, otherwise
  contributors without Apple credentials cannot build.

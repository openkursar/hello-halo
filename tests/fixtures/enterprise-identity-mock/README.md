# Example Org sign-in mock

This is a development-only implementation of Halo's organization identity provider v2 contract. It serves a sign-in page on loopback and issues only fake credentials. It never asks for a password or talks to an identity service. Do not use it in a packaged app.

## Launch Halo with the mock

From the Halo worktree root, with normal dev dependencies installed, run:

```sh
(
  node --input-type=module <<'NODE' || exit 1
import { readFileSync, writeFileSync } from 'node:fs';
const fixture = './tests/fixtures/enterprise-identity-mock/';
const config = JSON.parse(readFileSync(fixture + 'product.mock.json', 'utf8'));
config.enterpriseIdentity.provider = fixture + 'provider.mjs';
writeFileSync('product.local.json', JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
NODE
  profile=$(mktemp -d "${TMPDIR:-/tmp}/halo-org-mock.XXXXXX") || exit 1
  printf 'Mock Halo profile: %s\n' "$profile"
  HALO_E2E_TEST=1 HALO_DATA_DIR="$profile" HALO_ORG_MOCK_AUTO=never npm run dev
)
```

The unpackaged app reads the ignored `product.local.json` before `product.json` and resolves providers relative to that file. The command refuses to replace an existing override. Remove `product.local.json` after quitting if you created it here, or keep it and rerun only the profile and `npm run dev` lines to use the mock again. The temporary profile keeps mock data and Electron browser storage separate from your normal Halo profile.

Open Halo's Organization sign-in in Settings. In the sign-in window, choose **Phone app**, **Web**, or **Account**, and select **Confirm (mock)**. For the intermediate phone confirmation state, select **Simulate scan** first. The QR encodes a synthetic label, not a scannable real sign-in link; if the app dependency `qrcode` is unavailable, the page shows the same label as text.

| Method | Unlocks |
| --- | --- |
| Phone app | Models, Internal systems, Mail |
| Web | Internal systems |
| Account | Models |

The example product binding is illustrative: the fixture does not install `example-org.mock-tool` or attach tokens to any real tool. The Models capability is mock sign-in state, not a model endpoint.

The product also declares **Example Cloud** as a model account that comes with the sign-in, so Settings offers Example Org in its place. `model-account-provider.mjs` never logs in or contacts a server; it only reports a fixed quota for an account a test places in the profile.

## Exercise specific states

Set these variables on the `npm run dev` command; restart Halo to apply them:

- `HALO_ORG_MOCK_AUTO=succeed|cancel|fail|never`: after about 700 ms, automatically sign in as **Phone app**, cancel, fail, or wait for input (the default). A flow that receives no input still expires at its deadline.
- `HALO_ORG_MOCK_TTL_MS`: positive integer in milliseconds. Defaults to 30 minutes; controls flow timeout and the lifetime of each granted capability.
- `HALO_ORG_MOCK_RESTORE=1`: show `restoring` when Halo first loads the provider, then silently grant all three capabilities after about 800 ms. No earlier sign-in is needed or persisted.

The provider writes `halo-org-mock-control.json` in Node's `os.tmpdir()` when it loads (normally when the sign-in state is first opened). The file contains `{port, token}` and is rewritten for each new flow. It points to the most recently loaded or used mock instance; run only one app mock per OS user when using this default control file. It may outlive the app, but its token will not work on a new instance. Do not share the control file while an instance is running. Set `HALO_ORG_MOCK_CONTROL_FILE` to a private absolute path to run independent instances.

Use a second terminal to send actions to the local mock. The helper below reads the file on every call and does not print the token:

```sh
mock_control() {
  node --input-type=module - "$1" <<'NODE'
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { port, token } = JSON.parse(readFileSync(join(tmpdir(), 'halo-org-mock-control.json'), 'utf8'));
const response = await fetch(`http://127.0.0.1:${port}/control`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: process.argv[2]
});
console.log(await response.json());
process.exitCode = response.ok ? 0 : 1;
NODE
}

mock_control '{"action":"scan"}'
mock_control '{"action":"confirm","method":"phone"}'
mock_control '{"action":"expire","capability":"mail"}'
mock_control '{"action":"switch-subject"}'
mock_control '{"action":"credential","mode":"slow"}'
mock_control '{"action":"credential","mode":"fail"}'
mock_control '{"action":"credential","mode":"normal"}'
```

`confirm` accepts `phone`, `web`, or `account`. `expire` accepts one of `model`, `intranet`, or `mail`. `switch-subject` changes the signed-in subject while retaining the display name and capabilities. `slow` adds 2.5 seconds to subsequent issuance attempts; `fail` rejects them. To affect the first issuance after sign-in, set that mode **before** confirmation. For browser automation, `GET /status` on the same port also accepts `Authorization: Bearer <token>` and returns `{scanned, outcome}`. Confirming a settled flow has no effect.

## Smoke test

```sh
node --test tests/fixtures/enterprise-identity-mock/provider.test.mjs
```

The tests exercise the provider and its real local HTTP server, not Electron or the Halo renderer. They use separate temporary control files and do not overwrite a running app's control file.

# Email Setup — Mailbox Tools vs. Notification Alerts

Last updated: 2026-09-03

Read this whenever the user wants Halo to read/send email, wants a digital human to send a
one-off alert email, or asks "why isn't email working". This topic has no companion documents —
everything is in this file. For WeCom/WeChat IM channels (a different, unrelated integration),
read `message-channels/index.md` instead; its §1a explains the IM-channel-vs-notify-channel
distinction that also applies here.

## 1. Concept: one credential set, two independent consumers

Halo has exactly **one** email credential object per install —
`config.notificationChannels.email` (`EmailChannelConfig`, `src/shared/types/notification-channels.ts:52-69`).
Configuring "Email" once in **Settings → Message Channels → Email** powers two unrelated
mechanisms that read the same fields:

| | **`halo-email` mailbox tools** | **Email notify-channel** |
|---|---|---|
| Direction | Bidirectional — list/read/search/send/reply/forward/move/mark/delete mail, plus calendar | One-way outbound only — a single alert email |
| Purpose | A digital human that manages an inbox as part of its work | A digital human tells someone something happened |
| Source | `src/main/services/email-mcp/` | `src/main/services/notify-channels/email.ts` |
| Agent tool surface | `email_list`, `email_read`, `email_search`, `email_send`, `email_reply`, `email_forward`, `email_move`, `email_mark`, `email_delete`, `email_folders`, `email_attachment_download`, plus `calendar_list`/`calendar_create`/`calendar_delete` if CalDAV is configured — all registered by `createEmailMcpServer()`, `src/main/services/email-mcp/index.ts` | `notify_channel` tool (one shared tool across all notify-channel types, not email-specific) |
| App Spec field | `permissions: ["email"]` (alias for MCP server id `halo-email`, `src/shared/apps/builtin-mcp.ts`) | `output.notify.channels` |
| Gating | Requires the `email` permission **and** the channel to be enabled globally (see §4) | Requires *any* notify-channel enabled, or IM contacts for `notify_bot`; independent of the `email` app permission — `src/main/apps/runtime/notify-availability.ts` |

There is no separate "IMAP settings" or "per-app email account" anywhere in Halo. If a user wants
a digital human to have its own distinct mailbox, that is not supported — there is one global
email identity for the whole Halo install.

### Mailbox tools only exist in a digital human's own conversation

`createEmailMcpServer()` is called from exactly two places in the whole codebase:
`src/main/apps/runtime/app-chat.ts` (interactive chat with a digital human) and
`src/main/apps/runtime/execute.ts` (scheduled/triggered automation runs). It is never wired into
plain space conversations. If a user asks for email help in a regular space chat (not a digital
human's Chat tab), the agent genuinely has no mailbox tools there — that isn't a bug to
troubleshoot, it's by design. Point them at a digital human's own conversation, or WeCom/IM if one
is bound (`message-channels/index.md`).

### Transport details worth knowing before you touch config

- **SMTP** (`src/main/services/email-mcp/smtp-client.ts`) — via `nodemailer`, one transporter per
  send/reply/forward call. The `From` header is always synthesized as
  `"${smtp.user}" <${smtp.user}>` — a display name or alternate From address cannot be set.
- **IMAP** (`src/main/services/email-mcp/imap-client.ts:96-140`) — via `imapflow`. Host/port are
  **not independently configurable**: Halo hardcodes `port: 993, secure: true` and reuses the
  same `smtp.user` / `smtp.password` for IMAP auth. There is no IMAP host field in the schema or
  UI at all (the SMTP host is the only host you provide).
- **CalDAV** (`src/main/services/email-mcp/caldav-client.ts:76-78`) — a hand-rolled iCalendar
  client, only registered when `caldavUrl` is set; otherwise the 3 calendar tools simply don't
  appear. Auth reuses SMTP username/password over HTTP Basic — no separate CalDAV credential.
- **No OAuth anywhere.** Auth is username + password (or provider "app password") only.

## 2. Configuration — shortest path

1. Open **Settings → Message Channels** (设置 → 消息通道) and expand the **Email**
   (电子邮件) notify-channel card (`src/renderer/components/settings/MessageChannelsSection.tsx`,
   `buildNotifyChannelDefs()` lines 92-169).
2. Fill in the fields (exact set, `MessageChannelsSection.tsx:100-109`):

   | Field (UI label) | Required | Notes |
   |---|---|---|
   | SMTP Host | yes | e.g. `smtp.gmail.com` — this is a **placeholder string only**, not a working default |
   | SMTP Port | yes | e.g. `465` |
   | Use SSL/TLS | no (toggle) | |
   | Username | yes | full email address |
   | Password | yes | provider **app password**, not the account login password, for any provider with 2FA/app-password policy |
   | Default Recipient | yes | fixed destination for the one-way notify-channel alert (§1, right column) — irrelevant to the mailbox tools |
   | CalDAV URL (Advanced, collapsed) | no | e.g. `https://{host}/dav/users/{email}/calendars/default/` — `{host}`/`{email}` are literal placeholders substituted by Halo |
   | TLS Ciphers (Advanced, collapsed) | no | leave blank unless a specific provider requires a nonstandard cipher list |
3. Toggle **Enabled** on the card.
4. Click **Test** (see §3 for exactly what this validates).
5. Save is automatic — the form auto-saves via a debounced `api.setConfig()` call
   (`MessageChannelsSection.tsx:1580-1596`); there is no separate Save button.

**There is no provider picker.** No Gmail/Outlook/QQ/163 dropdown exists, so never tell a user
"select your provider and Halo will fill this in."

**But do not assume the form starts blank.** A build can declare its own SMTP/CalDAV endpoint in
`product.json` under `serviceDefaults.email`; on first run `seedEmailChannelDefaults()`
(`src/main/foundation/config.service.ts:346-370`) writes host / port / secure / caldavUrl /
tlsCiphers directly into the user's config, so the settings form opens already populated and
editable. The open-source template ships no `serviceDefaults`, so that path no-ops there — but it
is ordinary code present in every build. Ask what the user actually sees; when fields arrive
pre-filled, their remaining job is usually just Username + Password.

### Credential storage

Config lives in plain JSON at `~/.{dataFolderName}/config.json` (`getConfigPath()`,
`src/main/foundation/config.service.ts:824-826`). `dataFolderName` comes from the build's
`product.json` (`getDataFolderName()`, `src/main/foundation/product-config.ts:459-467`) and
defaults to `halo` in the open-source template, so the usual path is `~/.halo/config.json` — but
a differently-branded build uses its own directory. Never hand the user a literal `~/.halo/...`
path without checking; that is how people end up editing a file the running app never reads.
Only the `password` field gets special handling:
- It is always masked as `***` before being sent to the renderer/API
  (`src/main/foundation/config-encryption.ts`, sentinel logic lines 28, 114, 272-290) — resaving
  the form without touching Password does not wipe the stored credential.
- Whether it is encrypted at rest depends on the build's `security.credentialAtRestSafe` flag
  (`product.json`). When enabled, it is stored as an SM4-CBC + HMAC-SM3 envelope
  (`src/main/foundation/crypto-envelope.ts`); when disabled, it is plaintext in `config.json`.
  This is a build-time setting, not something the user configures — don't offer it as a choice.

## 3. Verification

- Click **Test** on the Email card. This calls `testChannel()` →
  `notify-channels/email.ts:69-90`, which does **`nodemailer`'s `transporter.verify()` only —
  this exercises SMTP AUTH exclusively and sends nothing.** No test email is actually delivered
  to Default Recipient — `verify()` opens and closes the SMTP connection without a `sendMail()`
  call. IMAP and CalDAV connectivity are never checked by the Test button either. A green
  "Test passed" only proves SMTP auth works; it says nothing about whether
  `email_list`/`email_read`/calendar tools will function.
- To actually verify the mailbox tools, have the digital human call `email_list` or
  `email_folders` and check for a real folder list back, rather than trusting Test alone.
- To confirm a digital human can use email at runtime, three things must all be true:
  1. `resolvePermission(app, 'email')` — the app's own **Capabilities → Email** toggle
     (`src/renderer/components/apps/AppCapabilitiesSection.tsx`). **This defaults to ON**: a
     freshly-installed app gets `permissions: {granted: [], denied: []}`
     (`src/main/apps/manager/service.ts:436-439`), and `resolvePermission()`'s `defaultValue`
     parameter is `true` (`src/shared/apps/app-types.ts:285-294`) — so unless someone explicitly
     toggled it off, email is already enabled for every digital human. Don't tell a user they
     need to "turn on" email per app unless you've confirmed the toggle is actually off; more
     often the blocker is step 2.
  2. `config.notificationChannels.email.enabled` — the global toggle from §2. If this is off,
     `AppCapabilitiesSection.tsx` shows the Email toggle dimmed with an inline warning even when
     `resolvePermission` is true, and links back to Settings → Message Channels.
  3. If reached through a WeCom/IM bot as a non-owner: the instance's **Permission Control →
     Halo Capabilities → Email** guest toggle must also be on — this is a separate, third gate
     that only affects non-owner senders, not the app owner. The runtime gate is `allowEmail` in
     `GUEST_TOGGLEABLE_MCP` (`src/main/apps/runtime/app-chat.ts:161`, read at `app-chat.ts:206`);
     the same-named list in the renderer (`MessageChannelsSection.tsx`) only renders the toggle
     row and enforces nothing. Owners are never subject to this gate.
  This is implemented identically for automation runs
  (`src/main/apps/runtime/execute.ts:265,290,455-456`) and interactive chat
  (`src/main/apps/runtime/app-chat.ts:91,163,578-579`).

## 4. Diagnostics

Halo has **no custom error codes** for email connection failures — auth failure, wrong port, SSL
handshake issues, and "IMAP disabled on server" are not distinguished anywhere in Halo's own
code. What the UI shows is a raw pass-through of whatever `nodemailer` (SMTP) or `imapflow`
(IMAP) returned. Map the raw substring to a cause yourself:

| Symptom (raw error contains) | Likely cause | What to check |
|---|---|---|
| `Invalid login`, `Authentication failed`, `535` | Wrong username/password, or provider requires an app password instead of the account password | Regenerate an app password from the provider; confirm Username is the full email address |
| `ETIMEDOUT`, `ECONNREFUSED` | Wrong host or port, or the port is firewalled | Re-check SMTP Host/Port against the provider's documented values; note IMAP is fixed at port 993 and is not user-configurable (§1) |
| `self signed certificate`, `unable to verify the first certificate` | Halo doesn't perform its own certificate-chain validation on these connections — every TLS connection it opens (SMTP send, SMTP test, IMAP, CalDAV) sets `rejectUnauthorized: false` (`smtp-client.ts`, `notify-channels/email.ts:41-44,80-83`, `imap-client.ts:109-112`) | This error doesn't originate from Halo's own trust store, so look elsewhere — most likely a `secure`/port mismatch (a plain TLS handshake sent to a plaintext or STARTTLS-only port) rather than an actual certificate problem |
| Test passes but `email_list` fails or times out | IMAP-specific issue (Test never checks IMAP, §3) | Confirm the provider has IMAP access enabled for the account (many providers disable IMAP by default even when SMTP works) |
| Calendar tools (`calendar_*`) don't appear at all | `caldavUrl` is empty | Expected, not a bug — CalDAV tools are registered only when the Advanced `caldavUrl` field has a value (`caldav-client.ts:76-78`). Note the converse too: a build shipping `serviceDefaults.email.caldavUrl` may have pre-filled it (§2), so "the calendar tools are there" does not prove the user configured them |
| `CalDAV <method> failed: HTTP ...` | Wrong CalDAV URL or the provider's CalDAV path doesn't match the `{host}`/`{email}` template | Confirm the exact CalDAV base path with the provider; the `{host}`/`{email}` placeholders are substituted literally, not guessed |
| Test card shows "Not enabled" but the send path (`notify_channel`) fails with a differently-worded error | Cosmetic inconsistency in Halo itself — both mean the same thing (`enabled` is false) | `notify-channels/index.ts:108` uses `'Not enabled'` for Test, line 40 uses `'Email channel not enabled'` for Send — don't treat these as two different problems |

## 5. Never ask the user

- **Don't ask which email provider they use expecting Halo to auto-configure anything.** No
  preset/auto-detect logic exists (§2) — every field is manual regardless of provider.
- **Don't ask for a separate IMAP host or port.** IMAP is hardcoded to port 993 with TLS and
  reuses the SMTP username/password — there is nothing to configure there.
- **Don't ask about OAuth, "sign in with Google", or app-specific integrations.** Auth is always
  username + password/app-password over SMTP/IMAP/CalDAV Basic. If the account requires 2FA, the
  user needs the provider's app-password mechanism — that's a provider-side step, not a Halo
  setting.
- **Don't offer per-digital-human email accounts.** There is exactly one global
  `notificationChannels.email` credential set; every app that has the `email` permission shares
  it (§1). If isolation between apps is required, that is not something this feature supports.
- **Don't put the email password (or any credential) in an automation app's `config_schema`.**
  It is configured once, globally, in Settings — never per app.
- **Don't ask "should I test IMAP too?"** — there is no separate IMAP test; only SMTP is checked
  by the Test button (§3), and that's a Halo behavior, not a user choice.

# WeCom Intelligent Bot (企业微信智能机器人) — Setup, Permissions, Diagnosis

Provider type: `wecom-bot`. Source: `src/main/apps/runtime/im-channels/wecom-bot.provider.ts`,
`wecom-bot-scan-auth.ts`, `wecom-bot-default-spec.ts`, `owner-claim.ts`. UI:
`src/renderer/components/settings/MessageChannelsSection.tsx` (`InstanceCard`),
`WecomScanAuthDialog.tsx`.

Read `message-channels/index.md` first if you haven't — it disambiguates this channel from
WeChat iLink Bot, which is a different platform entirely.

## 1. Two ways to create an instance

### A. Scan to add (推荐 / recommended) — `WecomScanAuthDialog.tsx`

A device-flow QR authorization (`wecom-bot-scan-auth.ts`, RFC 8628-style):

1. Halo requests a short-lived `scode` + `auth_url` from WeCom (`generateScode()`), 5-minute TTL.
2. Renders `auth_url` as a QR code. The user scans with the WeCom app and taps "Agree".
3. Halo long-polls `query_result` (`pollResult()`) until WeCom returns `{ botId, secret }`.
4. On success, Halo **auto-creates a new, minimal automation app** as the bound digital human
   (`wecom-bot-default-spec.ts` — a generic "be helpful, reply in the user's language" prompt,
   **no `subscriptions`** since IM is the trigger) and appends a new `ImChannelInstanceConfig`
   with `permissionEnabled: true` (forced on, regardless of any product-level default — see §3).
5. The dialog explicitly does not auto-close on success: it shows "send the bot a message to
   bind yourself as owner" (`WecomScanAuthDialog.tsx` success state) because scan-auth never
   returns the scanning user's WeCom `userid`.

This is a device-flow scan (Halo's own client, not the bot itself) — do not confuse it with a
message an end user sends to the bot.

### B. Manual setup (手动设置)

Click **Manual setup** to create a blank instance, then fill in:

| Field | Meaning |
|---|---|
| Bot ID (`botId`) | WeCom's bot identifier, format `aib-xxx` |
| Secret (`secret`) | Long-lived secret, paired with Bot ID |
| WebSocket URL (`wsUrl`) | Optional override; defaults to `wss://openws.work.weixin.qq.com` |
| Digital Human | Which app receives every message from this bot |

Both `botId` and `secret` come from the user's own WeCom workspace admin console — Halo cannot
generate or look these up; if the user doesn't have them yet, point them at **Scan to add**
instead, which sidesteps needing them at all.

**WeCom's admin console offers two connection modes for the bot; Halo only implements one.**
`wecom-bot.provider.ts` connects via a persistent outbound WebSocket (`openws.work.weixin.qq.com`)
— this is WeCom's "长连接" (persistent connection) mode. WeCom also offers a "使用 URL 回调" (URL
callback / webhook) mode, which Halo has no code path for at all. If the user's bot is configured
for URL callback, it will never connect no matter how correct `botId`/`secret` are — the fix is on
the WeCom side: workspace admin console → the bot → API 配置 → switch to **使用长连接**.

A duplicate `botId` across two *enabled* instances triggers an inline warning
(`getDuplicateWarning` in `MessageChannelsSection.tsx`) — each real bot can only be bound to one
digital human at a time; the second instance simply won't be able to claim the WebSocket slot
(see §5 standby behavior).

## 2. Reply scope, quote reply, streaming

- **Reply Scope** (`replyScope`): `all` (default for new manual instances) / `group` only /
  `direct` only. A message outside scope gets a bilingual rejection reply, not silence
  (`DM_REJECTED_MESSAGE` / `GROUP_REJECTED_MESSAGE` in `dispatch-inbound.ts`).
- **Quote Reply** (`quoteReply`, config field, default **on**): group replies carry WeCom's
  quote-bubble UI. Turning it off routes group replies through a plain push instead
  (`wecom-bot.provider.ts` `buildReplyHandle`). Direct messages always keep the quote bubble
  regardless of this setting.
- **Streaming** (`instance.streaming`, default **off** — "current streaming pipeline is
  unstable" per `im-channel.ts`): shows thinking/tool-call progress live. **Requires Quote Reply
  to be on** — the UI disables the Streaming toggle when Quote Reply is off
  (`isQuoteReplyEnabled` gate in `InstanceCard`), and turning Quote Reply off force-clears
  Streaming if it was on. Reason: a suppressed quote bubble routes through the no-req_id push
  path, which streaming needs a req_id-bearing session to attach to.

Reply Scope, Quote Reply, and Streaming all take effect on the **next** inbound message with no
reconnect and no restart of Halo required — `ImChannelManager.configEqual()` deliberately excludes
these fields from its stop+recreate diff (`manager.ts`: "read at dispatch time from
currentConfigs... do NOT require a WebSocket reconnect when changed").

## 3. Permission control — owners, guests, and auto-claim

`permissionEnabled` (master switch, default off = "everyone has full access, personal-use
default"):

- **`false`/unset** — no restrictions. Everyone who messages the bot has full tool access.
- **`true` with empty `owners`** — deny-all for everyone, **including the creator**, until an
  owner is claimed (see below). This is why the scan-auth path (§1A) forces
  `permissionEnabled: true` on creation — WeCom bots default to locked, not open.
- **`true` with `owners: [userid, ...]`** — listed IDs are owners (full access, unrestricted by
  guest policy below); everyone else is a guest.

**Owner auto-claim** (`owner-claim.ts`, `maybeClaimOwner`): when `permissionEnabled` is true and
`owners` is empty, the **first person to send the bot a direct message** is automatically bound
as sole owner. This is deliberate — asking the user to look up their own WeCom `userid` is
error-prone. Group chats never auto-claim (first-sender-wins would be unsafe in a group). Until
someone claims it, group messages get a throttled guidance reply at most once per 10 minutes per
chat (`buildNoOwnerGuideMessage`, `NO_OWNER_GUIDE_INTERVAL_MS` in `dispatch-inbound.ts`), and
blocked DMs get nothing extra since the DM itself performs the claim.

**Adding owners beyond the auto-claimed one**: `dispatch-inbound.ts` injects the sender's raw
platform ID into the conversation as `senderIdentity` (direct chats) or a `<msg-sender id=...
name=... />` tag (group chats) — the digital human genuinely has this value in context. So the
practical way for a user to find *someone else's* WeCom `userid` to add as an additional owner is
to have that person message the bot and ask it directly (e.g. "what is my user ID"); the AI can
read it straight out of its own context and answer. Paste the returned ID into **Owner User IDs**
manually — there is no picker or lookup UI for this field, it's a plain textarea (comma/newline
separated).

**Guest policy** (`guestPolicy`, only meaningful once `owners` is non-empty): a whitelist —
`allowedTools` for built-in tools (empty array = chat-only, no tools) plus individual toggles for
Halo capabilities (`allowAiBrowser`, `allowEmail`, `allowNotify`, `allowApps`, `allowFileSend`,
`allowOcr`) and a per-server whitelist for user-installed MCP servers
(`allowedUserMcp`). `guestPolicy: undefined` (the default when guest access is off) means guests
get **zero** tool access — chat only.

**The defaults applied to a *new* instance are build-specific, not fixed.** `defaultEnabled`,
`defaultGuestAccess`, `defaultGuestPolicy`, `ownerIdHint`, and `ownerSetupGuideUrl`
(`ImChannelsPermissionDefaults`, `src/main/foundation/product-config.ts`) are all read from
`product.json` → `imChannels.permissionControl`, a per-build configuration file — its actual
content varies by which build of Halo the user is running and is not something to assume or
recite from memory. To find out what a given install's defaults actually are, either look at
what a freshly-added instance's Permission Control section shows in Settings → Message Channels
(the toggle state and any pre-filled hint text reflect the live values), or ask the user what
they see. These values only affect instances at creation time; existing instances are never
retroactively changed.

## 4. Real-name resolution (optional, separate credential)

WeCom bots created after WeCom's April 2026 anonymization change receive **opaque encrypted
sender IDs** instead of real names/userids. The **Name Resolution URL** field
(`nameResolveUrl`, optional) fixes this:

1. In the WeCom client: Workspace → Intelligent Bot → this bot → Permissions → authorize
   "Message" (a capability **separate from** the bot's own `botId`/`secret` connection
   credential).
2. Paste the resulting `streamableHTTP` URL (contains an `apikey` query param) into Name
   Resolution URL.
3. Halo fetches a point-in-time directory of up to ~20 recent chatId→name mappings on cache miss
   (`identity-resolve.ts`, `wecom-identity-resolve.ts`), and applies it to **whole chats/sessions
   only** — never to an individual sender inside a group (a resolved name for a group chatId is
   the *group's* name, not any member's).

This grant **expires 7 days after authorization** and must be re-copied — the UI surfaces this as
an `expired` status (amber, "re-copy the link from WeCom and paste it here"). Absence of this
field simply means chat IDs display as-is; it is fully optional and never blocks messaging.

## 5. Multi-device standby (informational, not a failure)

WeCom's protocol grants the live bot slot to whichever device connected most recently. If the
same `botId`/`secret` pair is configured on two Halo installs, `ConnectionArbiter`
(`wecom-bot.provider.ts`) detects repeated supersede events and yields: the losing device enters
**`standby`** (sky-blue dot, "In use on another device"), periodically probing to reclaim the
slot if the other device goes away, and sends **one** desktop notification per standby episode.
The user can force-reclaim immediately via **Use on this device** (calls `reconnect()`, which
resets the arbiter and always wins). This is expected behavior for a shared credential, not a
bug — do not diagnose it as a connection failure.

## 6. Diagnosis

| Symptom | Likely cause | Where to check |
|---|---|---|
| Instance stuck "Disconnected", never goes green | Missing/invalid `botId` or `secret`; `start_skip` logged | Console: `event=start_skip reason="missing botId or secret"`; re-check the two fields |
| Instance stuck "Disconnected" despite correct `botId`/`secret` | WeCom-side bot is configured for "使用 URL 回调" (webhook) instead of "使用长连接" — Halo only speaks the persistent-connection protocol | Have the user check WeCom admin console → the bot → API 配置, switch to 使用长连接 (see §1B) |
| Instance stuck "Disconnected", network-adjacent | Outbound access to `openws.work.weixin.qq.com:443` is blocked (corporate firewall/proxy) | Ask the user to confirm the machine can reach general internet sites; if behind a strict corporate firewall, IT needs to allow outbound HTTPS to that host |
| Instance shows sky-blue "Standby" | Same bot credential is live on another device | Normal — see §5. "Use on this device" to reclaim |
| Bot connects but never replies to DMs | No owner claimed yet + `permissionEnabled: true` | Have the user DM the bot once (auto-claims); or check `owners` in the instance config |
| Bot replies in DM but ignores group messages (or vice versa) | `replyScope` mismatch | Check the instance's Reply Scope setting; user gets an explicit rejection message, not silence, when scoped out |
| Group replies show as plain text, no quote bubble | Quote Reply toggled off for that instance | `quoteReply: false` in config — expected, not a bug |
| Streaming toggle greyed out / won't turn on | Quote Reply is off | Turn Quote Reply on first — Streaming requires it (§2) |
| Sender shows an opaque ID instead of a real name | No Name Resolution URL configured, or it expired | §4 — check `identityResolution.status` in instance status; `expired` needs a fresh 7-day grant |
| "This Bot ID is already in use" warning | Same `botId` configured on two enabled instances | Only one instance can hold the WebSocket slot per real bot — delete or disable the duplicate |
| Owner claimed the wrong user | First DM sender ≠ intended owner | Manually edit **Owner User IDs** in the Permission Control section; replaces the auto-claimed value |
| `notify_bot` / scheduled push to a chat never delivers | That chat has never messaged the bot before | A chat only becomes a known, pushable session after at least one real inbound message (`ImSessionRegistry`, registered in `dispatch-inbound.ts`) — have the target person or group `@`-mention the bot once first; see `create-digital-human/im-triggers.md` §B |

## Do not ask / do not assume

- **Do not ask the user for their WeCom `userid` up front** for the scan-auth flow — it isn't
  available at scan time; the first-DM auto-claim (§3) obtains it without ever having to ask.
- **Do not offer to configure per-message @-mention filtering.** WeCom's platform itself only
  forwards `@`-mentioned messages to the bot in groups — Halo never even receives the rest. See
  `create-digital-human/im-triggers.md`.
- **Do not treat `standby` as an error requiring troubleshooting** — see §5.

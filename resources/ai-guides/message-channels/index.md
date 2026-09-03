# Message Channels — WeCom Bot, WeChat iLink Bot, and IM Wiring

Last updated: 2026-09-03

Read this whenever the user wants a digital human reachable from an IM app (WeCom, WeChat),
asks "why isn't my bot replying", or confuses the two available channel types. This document
covers the **channel/instance layer** — how a bot connection is created, authorized, and bound
to a digital human. For the inbound/outbound *messaging* mechanics once a channel exists
(triggering, `notify_bot`, what NOT to ask), read `create-digital-human/im-triggers.md` — the
two documents are complementary, not overlapping.

| Document | Read it when |
|---|---|
| `message-channels/wecom-bot.md` | Setting up, debugging, or explaining **WeCom Intelligent Bot** (企业微信智能机器人) — QR onboarding, manual setup, permission control, owner claiming, real-name resolution |
| `message-channels/weixin-ilink.md` | Setting up or debugging **WeChat iLink Bot** (微信个人号机器人) — QR login, session expiry, its narrower feature set |
| `create-digital-human/im-triggers.md` | Inbound/outbound message mechanics once a channel is connected: `@`-mention rule in groups, `notify_bot`, what fields do NOT exist in the App Spec |

## 1. The #1 confusion: two completely different "WeCom/WeChat bot" products

Halo's Settings → Message Channels (设置 → 消息通道) page currently offers **two working**
bidirectional IM channel types. `src/shared/types/im-channel.ts`'s `IM_CHANNEL_TYPES` tuple lists
four (`wecom-bot`, `feishu-bot`, `dingtalk-bot`, `weixin-ilink-bot`), but only two have a real
`ImChannelProvider` implementation, registered in `src/main/apps/runtime/index.ts`:

```
imChannelManager.registerProvider(new WecomBotProvider())
imChannelManager.registerProvider(new WeixinIlinkBotProvider())
// Future: imChannelManager.registerProvider(new FeishuBotProvider())
// Future: imChannelManager.registerProvider(new DingTalkBotProvider())
```

`feishu-bot` and `dingtalk-bot` exist only as a type-level tag and a UI label mapping (e.g.
`ImSessionsSection.tsx`'s `CHANNEL_DISPLAY`) — there is no provider, no connection, no way to
create an instance of either. **Never offer Feishu or DingTalk as a bidirectional IM channel to
a user; only WeCom Intelligent Bot and WeChat Bot are real.** (Feishu and DingTalk *do* exist for
one-way notifications — see §1a.)

The two real channels look similar in the UI but are built on unrelated platform APIs and must
never be conflated when talking to a user:

| | **WeCom Intelligent Bot** (企业微信智能机器人) | **WeChat Bot** (微信机器人) |
|---|---|---|
| Provider type | `wecom-bot` | `weixin-ilink-bot` |
| What account it runs as | An official WeCom (企业微信) **AI Bot** feature, created inside a WeCom workspace | The user's own **personal WeChat (微信) account**, automated via a third-party API called "iLink" |
| Underlying transport | Persistent WebSocket to `openws.work.weixin.qq.com`, using `@wecom/aibot-node-sdk` (`wecom-bot.provider.ts`) | HTTP long-polling against `ilinkai.weixin.qq.com` (`weixin-ilink.provider.ts`, `ilink-api.ts`) |
| Setup credential | `botId` + `secret` (a config field pair), obtained via QR scan-authorization or typed in manually | `bot_token` obtained **only** via QR login — there are no manually-typed credential fields (`configFields: []` in `weixin-ilink.provider.ts`) |
| Group chat support | Yes — group and direct | Direct chats only (`chatType: 'direct'` is hardcoded in `weixin-ilink.provider.ts`; there is no group concept) |
| Permission control (owners/guests) | Exposed in Settings UI (`PermissionSection` in `MessageChannelsSection.tsx`) | **Not exposed in the UI at all** — the `WeixinIlinkInstanceCard.tsx` component has no permission section. Anyone who messages the connected personal WeChat account has full, unrestricted access |
| Streaming replies | Configurable per instance | Not implemented — no `streaming` handling in `weixin-ilink.provider.ts` |
| Multi-device behavior | Explicit standby/arbitration — see `wecom-bot.md` | Not implemented; a new QR login simply replaces the token |

If a user says "企业微信号" or "ilink" while trying to set up a work-facing group bot, they
almost certainly want **WeCom Intelligent Bot**, not the iLink channel — iLink automates a
*personal* WeChat account and cannot join WeCom's enterprise workspace at all. Confirm which
platform (WeCom app icon vs. WeChat app icon) they mean before proceeding.

## 1a. "配企业微信" has a second, unrelated meaning — IM channels vs. notify-channels

Before doing anything, work out whether the user wants a **conversation** or a **one-way
alert**. Halo has two completely separate WeCom integrations and the phrase "配置企业微信"
(or just "WeCom") is genuinely ambiguous between them:

| | **IM channels** (this document) | **Notify channels** |
|---|---|---|
| Direction | Bidirectional — the bot receives messages and replies | One-way outbound only — Halo pushes a message, nothing comes back |
| Purpose | A digital human you chat with over WeCom/WeChat | A digital human tells you something happened (a scheduled run finished, an alert fired) |
| Source | `src/shared/types/im-channel.ts`, `src/main/apps/runtime/im-channels/` | `src/main/services/notify-channels/` — `wecom.ts`, `dingtalk.ts`, `feishu.ts`, `email.ts`, `webhook.ts` (all five implemented) |
| Configured via | Settings → Message Channels → **WeCom Intelligent Bot** / **WeChat Bot** cards (this document) | Settings → Message Channels → the **notification channel cards** further down the same page (WeCom/DingTalk/Feishu/Email/Webhook) |
| App Spec field | Not in the spec at all — see §2 | `output.notify.channels` (declares which channels a run may push to) |
| Agent tool | None — replying is just normal chat output | `notify_channel` (the app decides at runtime whether to push) |

Concretely: Feishu and DingTalk **do exist** in Halo, but only as one-way notify-channels — never
offer them as a chat-back bot (§1). Conversely, WeCom has a real notify-channel *and* a real IM
channel, both independently configurable — enabling one does not enable the other. Ask the user
"do you want to talk to it, or just get notified by it?" when it isn't obvious which they mean.

## 2. Shared architecture — read once, applies to both channel types

- **Instance = one live connection, bound to exactly one digital human.** Each configured "Bot"
  in Settings is an `ImChannelInstanceConfig` (`src/shared/types/im-channel.ts`) with an `appId`.
  Several instances may point at the same digital human (N:1), but one instance never serves
  two apps. This binding is what "which digital human answers this bot" means — there is no
  other routing layer.
- **All inbound messages funnel through one place**: `src/main/apps/runtime/dispatch-inbound.ts`.
  Whatever channel-specific detail you're debugging, the gates it applies (owner-claim,
  `replyScope`, busy-buffering, permission context) are identical for both provider types.
- **Config lives in `config.json` under `imChannels.instances[]`**, edited exclusively through
  Settings → Message Channels (设置 → 消息通道). There is no per-channel config file.
- **An instance with no `appId` or `enabled: false` never connects** — `ImChannelManager` only
  calls `createAndStartInstance` when both are set (`manager.ts`).

## 3. Configuration — shortest path

1. Open **Settings → Message Channels** (设置 → 消息通道).
2. Expand the **WeCom Intelligent Bot** (企业微信智能机器人) or **WeChat Bot** (微信机器人)
   provider card.
3. Click **Scan to add** (扫描添加) for WeCom (recommended — creates and binds a default digital
   human automatically) or **Add Bot** (添加机器人) → **Connect WeChat** (连接微信) for iLink.
4. Scan the QR code with the corresponding phone app and approve.
5. **WeCom only** — send the bot one direct message afterward. This is not optional busywork:
   the WeCom scan-auth protocol never returns the scanning user's `userid`, so Halo cannot know
   who the owner is until they message the bot once (`dispatch-inbound.ts`'s owner auto-claim
   gate, detailed in `message-channels/wecom-bot.md` §3). Until that happens the bot is
   configured but treats every sender as a deny-all guest.
6. Confirm the instance card shows a green **Connected** (已连接) dot.

Full field-by-field detail, the manual (non-QR) setup path, and permission control are in the
per-channel companion documents — read the one matching the user's platform before configuring
anything, since the two setup flows share no steps beyond "open this settings section".

## 4. Verification

There is no agent tool for any of this — `imChannelsStatus` and `imSessionsList` are renderer-only
IPC calls (`src/main/ipc/im-channels.ts`, `src/main/ipc/im-sessions.ts`), not something an AI
session can call. Verification means telling the user what to look at, or asking them to perform
an action and report back:

- **Ask the user to look at the instance card's connection dot** in Settings → Message Channels.
  A green dot / "Connected" (已连接) means the transport is live. A sky-blue "Standby" dot
  (WeCom only) means the same bot credential is already active on another device — that's normal,
  not broken; see `wecom-bot.md`.
- **The only real end-to-end check is a live message.** Ask the user to send the bot a message
  from their phone and confirm the digital human replies. This is the sole way to verify the full
  path (owner claim → replyScope → dispatch → agent run) — a green connection dot alone does not
  prove a message will be accepted (e.g. it can still be blocked by `replyScope` or an unclaimed
  owner, both silent-to-the-dot conditions).
- **A session only appears after a real inbound message.** If the user says they don't see the
  new contact/session in the digital human's IM Sessions list, the fix is the same live-message
  test above, not a settings change.

## 5. Do not ask / do not assume

- **Do not ask which subscription type receives IM messages.** IM channels are configured
  entirely outside the App Spec (Settings → Message Channels), not via `subscriptions`. See
  `create-digital-human/im-triggers.md` §"Questions you should NOT ask".
- **Do not offer to type in a WeChat iLink `bot_token`.** There is no manual-entry path for this
  channel — `weixin-ilink.provider.ts`'s `configFields` is an empty array. QR login is the only
  onboarding path.
- **Do not assume WeChat iLink supports group chats, permission control, or streaming.** None of
  the three exist for this channel (see the comparison table above); don't ask the user to
  configure them, and don't promise them.
- **Do not assume a "Disconnected" WeCom instance is broken** before checking whether it's
  actually in `standby` — that state means it's working correctly, just yielded to another
  device, and is a normal condition, not a failure.

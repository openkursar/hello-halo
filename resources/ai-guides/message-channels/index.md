# Message Channels — WeCom Bot, WeChat iLink Bot, Feishu Bot, and IM Wiring

Last updated: 2026-10-06

Read this whenever the user wants a digital human reachable from an IM app (WeCom, WeChat,
Feishu), asks "why isn't my bot replying", or confuses the available channel types. This document
covers the **channel/instance layer** — how a bot connection is created, authorized, and bound
to a digital human. For the inbound/outbound *messaging* mechanics once a channel exists
(triggering, `notify_bot`, what NOT to ask), read `create-digital-human/im-triggers.md` — the
two documents are complementary, not overlapping.

| Document | Read it when |
|---|---|
| `message-channels/wecom-bot.md` | Setting up, debugging, or explaining **WeCom Intelligent Bot** (企业微信智能机器人) — QR onboarding, manual setup, permission control, owner claiming, real-name resolution, group @mentions and commands |
| `message-channels/weixin-ilink.md` | Setting up or debugging **WeChat iLink Bot** (微信个人号机器人) — QR login, session expiry, its narrower feature set |
| §1b of this document | Setting up or debugging **Feishu Bot** (飞书机器人, Halo 3.0 and later) — QR onboarding, manual setup, the group @mention rule |
| `create-digital-human/im-triggers.md` | Inbound/outbound message mechanics once a channel is connected: `@`-mention rule in groups, `notify_bot`, what fields do NOT exist in the App Spec |

## 1. The #1 confusion: which IM channels exist, and two different "WeCom/WeChat bot" products

Which bidirectional IM channel types Halo's Settings → Message Channels (设置 → 消息通道) page
offers depends on the Halo version:

- **Halo 3.0 and later — three:** WeCom Intelligent Bot, WeChat Bot, and Feishu Bot (飞书机器人,
  §1b).
- **Halo 2.1.x — two:** WeCom Intelligent Bot and WeChat Bot. There is no Feishu Bot card; Feishu
  exists there only as a one-way notification channel (§1a).

`src/shared/types/im-channel.ts`'s `IM_CHANNEL_TYPES` tuple lists four (`wecom-bot`, `feishu-bot`,
`dingtalk-bot`, `weixin-ilink-bot`). From 3.0, three have a real `ImChannelProvider`
implementation, registered in `src/main/apps/runtime/index.ts`:

```
imChannelManager.registerProvider(new WecomBotProvider())
imChannelManager.registerProvider(new WeixinIlinkBotProvider())
imChannelManager.registerProvider(new FeishuBotProvider())
// Future: imChannelManager.registerProvider(new DingTalkBotProvider())
```

`dingtalk-bot` exists only as a type-level tag and a UI label mapping — there is no provider, no
connection, no way to create an instance. **Never offer DingTalk as a bidirectional IM channel to
a user** (DingTalk *does* exist for one-way notifications — see §1a). **Offer Feishu Bot only when
the user's Message Channels page shows a Feishu Bot (飞书机器人) card** — ask them to look rather
than assuming; on a 2.1.x build it is not there.

WeCom Intelligent Bot and WeChat Bot look similar in the UI but are built on unrelated platform
APIs and must never be conflated when talking to a user:

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
| Purpose | A digital human you chat with over WeCom/WeChat/Feishu | A digital human tells you something happened (a scheduled run finished, an alert fired) |
| Source | `src/shared/types/im-channel.ts`, `src/main/apps/runtime/im-channels/` | `src/main/services/notify-channels/` — `wecom.ts`, `dingtalk.ts`, `feishu.ts`, `email.ts`, `webhook.ts` (all five implemented) |
| Configured via | Settings → Message Channels → **WeCom Intelligent Bot** / **WeChat Bot** / **Feishu Bot** (3.0 and later) cards (this document) | Settings → Message Channels → the **notification channel cards** further down the same page (WeCom/DingTalk/Feishu/Email/Webhook) |
| App Spec field | Not in the spec at all — see §2 | `output.notify.channels` (declares which channels a run may push to) |
| Agent tool | None — replying is just normal chat output | `notify_channel` (the app decides at runtime whether to push) |

Concretely: DingTalk **does exist** in Halo, but only as a one-way notify-channel — never offer it
as a chat-back bot (§1). Feishu has a notify-channel in every build and, from Halo 3.0, also the
bidirectional Feishu Bot (§1b). WeCom likewise has a real notify-channel *and* a real IM channel.
In each case the two are configured independently — enabling one does not enable the other. Ask
the user "do you want to talk to it, or just get notified by it?" when it isn't obvious which they
mean.

## 1b. Feishu Bot (飞书机器人) — Halo 3.0 and later

A Feishu / Lark app bot on Feishu's long connection (`feishu-bot.provider.ts`, built on
`@larksuiteoapi/node-sdk`). It uses the same instance-to-digital-human binding and the same
inbound gates as the other channels (§2). Only describe it after the user confirms their Message
Channels page has a **Feishu Bot** (飞书机器人) card (§1).

- **Onboarding.** Expand the Feishu Bot card → **Scan to add** (扫描添加) and scan with the Feishu
  app. On the confirmation page the user can rename the bot and change its icon; keeping the
  availability scope to themselves or a few members usually lets the tenant publish the app
  without admin review. Scan-to-add creates and binds a default digital human. **Manual setup**
  (手动设置) instead takes the **App ID** and **App Secret** (应用密钥) of an existing Feishu app,
  plus the **Deployment** (部署): Feishu (China) (飞书（中国）) or Lark (International)
  (Lark（国际版）).
- **Owner.** As with WeCom, setup does not tell Halo who the owner is: right after setup the user
  sends the bot one direct message, and the first person to message it in a direct chat becomes
  its owner. Owners and guests are managed with the same permission editor as WeCom, guest skills
  included (`message-channels/wecom-bot.md` §3).
- **Groups.** **Require @mention in groups** (在群聊中需要 @ 提及) is on by default, so the bot
  answers only group messages that @ it. Feishu delivers un-mentioned group messages at all only
  when the tenant granted the sensitive "all group messages" permission; only then does turning
  the toggle off make the bot answer every group message. **Quote Reply (Group)** (引用回复（群聊）)
  decides whether group replies quote the triggering message; direct messages never quote.
- **Replies.** **Streaming** (流式传输) shows progress live in a Feishu card that is then replaced
  by the final answer; with it off, only the final reply is sent, plus the **Processing Notice**
  (处理中提示) described in §2. The bot can also send files into the chat.
- **One machine per bot.** Feishu hands each event to exactly one connection, so the same App ID
  connected from two machines splits the messages at random between them. Keep a given bot on one
  Halo; Halo also refuses to bind a bot that is already bound to another digital human.
- **"Connected · no messages received yet"** (已连接 · 尚未收到消息) means the link is up but nothing
  has arrived — typically the Feishu app is still waiting for administrator approval, or the person
  messaging it is outside its availability scope. A direct message from an in-scope user clears it.

## 2. Shared architecture — read once, applies to every channel type

- **Instance = one live connection, bound to exactly one digital human.** Each configured "Bot"
  in Settings is an `ImChannelInstanceConfig` (`src/shared/types/im-channel.ts`) with an `appId`.
  Several instances may point at the same digital human (N:1), but one instance never serves
  two apps. This binding is what "which digital human answers this bot" means — there is no
  other routing layer.
- **All inbound messages funnel through one place**: `src/main/apps/runtime/dispatch-inbound.ts`.
  Whatever channel-specific detail you're debugging, the gates it applies (owner-claim,
  `replyScope`, busy-buffering, permission context) are identical for every provider type.
- **Config lives in `config.json` under `imChannels.instances[]`**, edited exclusively through
  Settings → Message Channels (设置 → 消息通道). There is no per-channel config file.
- **An instance with no `appId` or `enabled: false` never connects** — `ImChannelManager` only
  calls `createAndStartInstance` when both are set (`manager.ts`).
- **Processing Notice** (处理中提示, Halo 3.0 and later) — a switch on every bot card (WeCom,
  Feishu, WeChat), **on** by default. With Streaming off, a reply that has not arrived within 5
  seconds is preceded by "✅ 已收到，正在处理…" so the sender knows the message arrived; a faster
  reply comes alone. Switched off, only the final reply is ever sent. While Streaming is on the
  switch is greyed out: the streaming message itself shows the status. Before 3.0 that notice was
  sent at once for every message and could not be turned off.
- **"?" next to each setting** (Halo 3.0 and later): the reply and permission settings on a bot card
  each have a **?** that opens a short explanation, and it opens with a tap on a phone or in the
  remote web page too. Point the user at it rather than paraphrasing a setting from memory.
- **Answering the digital human's questions in IM** (Halo 3.0 and later). When the digital human
  asks for a decision, the bot bound to it (or the bot serving its team) sends the question at once:
  - **The owner's direct chat** gets the full question with a number and the options, e.g.
    "【name】需要你决定（编号 12）…". The owner replies `/answer 12 B` — an option letter, the
    option's text, or an answer in their own words. With only one question waiting, the number
    may be left out; with several, Halo lists the numbers and asks which one.
  - **Group chats** — those with **Auto-sync run result** (自动同步运行结果) on in the digital
    human's bot sessions, and the group a team's work came from — get only "有一个问题在等主人回复
    （编号 12）", never the question itself.
  - **Who counts as the owner**: with permission control on, the IDs in the owner list, answering
    from any chat; anyone else is told only the owner can answer. With permission control off there
    is no owner list: the question goes only to direct chats with **Auto-sync run result** on, and
    answers are accepted only in direct chats, never in groups.
  - The first answer wins, from IM or Halo alike, and the task carries on; the bot confirms with
    "已收到，任务继续". An answer to a question already answered, expired or closed gets a short
    explanation instead.
  - A bot limited to group chats (Reply Scope "group only") with permission control off cannot take
    answers in IM at all — answer in Halo. The question also stays answerable in Halo whenever the
    bot was offline.
  - Halo learns which direct chat is the owner's from a message the owner sends there. A Feishu
    owner whose direct chat gets no questions should message the bot once.
  - Only messages that start with `/answer` (in a group, right after the @mention) count as
    answers; they never reach the AI.

## 3. Configuration — shortest path

1. Open **Settings → Message Channels** (设置 → 消息通道).
2. Expand the **WeCom Intelligent Bot** (企业微信智能机器人), **WeChat Bot** (微信机器人), or —
   on Halo 3.0 and later — **Feishu Bot** (飞书机器人) provider card.
3. Click **Scan to add** (扫描添加) for WeCom or Feishu (recommended — creates and binds a default
   digital human automatically) or **Add Bot** (添加机器人) → **Connect WeChat** (连接微信) for
   iLink.
4. Scan the QR code with the corresponding phone app and approve.
5. **WeCom and Feishu** — send the bot one direct message afterward. This is not optional
   busywork: the scan-auth flow never tells Halo the scanning user's ID (for WeCom, its `userid`),
   so Halo cannot know who the owner is until they message the bot once (`dispatch-inbound.ts`'s
   owner auto-claim gate, detailed for WeCom in `message-channels/wecom-bot.md` §3). Until that
   happens the bot is configured but treats every sender as a deny-all guest.
6. Confirm the instance card shows a green **Connected** (已连接) dot.

Full field-by-field detail, the manual (non-QR) setup path, and permission control are in the
per-channel companion documents (§1b for Feishu) — read the one matching the user's platform
before configuring anything, since the setup flows share no steps beyond "open this settings
section".

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
- **Do not offer Feishu Bot on a build whose Message Channels page has no Feishu Bot card.** It
  exists from Halo 3.0; on 2.1.x Feishu is only a one-way notification channel (§1a).
- **Do not suggest running the same Feishu bot on two machines.** Unlike WeCom there is no standby
  arbitration — Feishu splits the messages between the two connections (§1b).

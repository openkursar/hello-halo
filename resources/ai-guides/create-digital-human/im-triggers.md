# IM / WeCom Triggering — How It Actually Works

Read this whenever the digital human should be reachable via WeCom (or another IM channel), or
should proactively push messages to IM contacts. This is where guessing produces the most
visibly wrong questions, because the mechanism is genuinely not part of the App Spec.

## Two separate mechanisms — do not conflate them

### A. Inbound: someone messages the bot, it replies (conversational)

This has **nothing to do with `subscriptions`, `config_schema`, or any spec field**:

1. In Halo Settings → Message Channels, the user connects a WeCom Bot (or other IM channel)
   and creates an "instance".
2. That instance binds **1:1 to exactly one digital human's `appId`** (several instances may
   point at the same app, but one instance never serves two apps) —
   `src/shared/types/im-channel.ts`: *"Each Instance binds to exactly one digital human
   (appId). Multiple Instances can bind to the same appId (N:1 supported)."*
3. Every inbound message on that instance goes to `dispatchInboundMessage()`
   (`src/main/apps/runtime/dispatch-inbound.ts`), which starts a normal AI chat turn for the
   bound app, isolated per `appId + channel + chatType + chatId`. That file's header states:
   *"No routing logic — appId is provided by the caller (ImChannelManager)."*
4. When a WeCom bot is created through the QR scan-auth flow, Halo auto-creates a minimal app
   with **zero subscriptions** — `src/main/apps/runtime/im-channels/wecom-bot-default-spec.ts`
   says it outright: `// No subscriptions — IM message is the trigger.`

**So: for a WeCom-reachable digital human, `create_automation_app` needs no `subscriptions`
entry at all.** The IM wiring happens in Settings after the app exists. If the user also wants
scheduled background work, add a `schedule` subscription for that — additive, not a
replacement.

### B. Outbound: the app pushes a message on its own initiative (`im-push`)

The opposite direction, and this one *is* spec-controlled:

- Add `"im-push"` to `permissions[]`.
- At runtime, if the permission is granted **and** the app already has at least one known IM
  contact, a `notify_bot` tool appears (`src/main/apps/runtime/notify-tool.ts`).
- `notify_bot`'s description embeds a live contact directory (`instanceId:chatId` → display
  name) built from the app's IM sessions at run time. Targets are chosen by the agent during
  the run; they are never pre-declared in the spec.
- If `im-push` is granted but no contact exists yet, the tool is simply absent. The correct
  guidance is then: "connect an IM channel in Settings → Message Channels and have someone
  message this digital human once" — not a spec change
  (`src/main/apps/runtime/prompt/capabilities.ts`).

A and B are independent: an app can be conversational without pushing, or push from scheduled
runs without ever being bound to a chat.

## Questions you should NOT ask

- ~~"Should it respond to every message, or only when @-mentioned / prefixed with X?"~~ — In
  WeCom group chats the platform only delivers `@`-mentioned messages to the bot; Halo never
  sees the rest. `dispatch-inbound.ts` strips the leading mention with the note *"WeCom (and
  similar IM platforms) deliver a group message to the bot only when the bot is mentioned...
  no identity matching needed."* Nothing to configure.
- ~~"Which subscription type receives WeCom messages?"~~ — None. Omit `subscriptions`. Do not
  use `source.type: "wecom"`; it is schema-only with no event producer.
- ~~"Which chat IDs should trigger this?"~~ — Scoping is implicit in which bot instance the
  user binds to the app, not an ID list in the spec.

## Legitimate requests whose answer is "not in the spec"

These behaviors are real but live on the IM channel *instance*, not the App Spec.
`create_automation_app` / `update_automation_app` cannot set them — tell the user where to go:

| What they want | Where it is configured |
|---|---|
| Reply only in groups, or only in DMs | Settings → Message Channels → edit the instance → `replyScope` (`all` / `group` / `direct`) |
| Restrict who may command the bot | Same place → permission control (`owners` allowlist, `guestPolicy`) |
| Streaming replies | Same place (`streaming`, opt-in, default off) |

## Built-in behaviors worth knowing (informational, not configurable)

- The first person to DM an ownerless permission-controlled instance is auto-bound as owner;
  group chats never auto-claim.
- `/halo-stop` (also `/stop`, `/halo-cancel`) aborts the running generation for that chat;
  `/halo-clear` (also `/clear`, `/halo-reset`) resets its context. Both are handled before the
  message reaches the AI.
- A message arriving while the app is still answering is buffered and merged into the next
  round — never dropped, never run concurrently.

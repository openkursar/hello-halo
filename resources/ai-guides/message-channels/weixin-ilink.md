# WeChat Bot / iLink (微信机器人) — Setup, Limits, Diagnosis

Provider type: `weixin-ilink-bot`. Source: `src/main/apps/runtime/im-channels/weixin-ilink.provider.ts`,
`ilink-api.ts`, `ilink-media.ts`, `src/main/ipc/weixin-ilink.ts`. UI:
`src/renderer/components/settings/WeixinIlinkInstanceCard.tsx`.

Read `message-channels/index.md` first — this channel automates a **personal WeChat (微信)
account**, not WeCom's enterprise "Intelligent Bot" feature. If the user wants group-chat
support, permission control, or streaming, they want `message-channels/wecom-bot.md` instead —
none of those three exist here.

## 1. What this actually is

`weixin-ilink.provider.ts`'s header states it plainly: "WeChat Personal Bot via iLink API
(微信个人号 via iLink API)". It automates the user's own personal WeChat account through a
third-party HTTP API (`https://ilinkai.weixin.qq.com`), using long-polling
(`POST /ilink/bot/getupdates`, up to 35s hold per call) for inbound and `POST
/ilink/bot/sendmessage` for outbound. There is no WebSocket, no official WeCom involvement, and
no manual credential entry — everything is obtained through a QR login.

## 2. Setup — QR login is the only path

`configFields` in `weixin-ilink.provider.ts` is an empty array — do not offer or invent manual
fields (bot token, API key, etc.) for this channel.

1. In Settings → Message Channels, expand **WeChat Bot** (微信机器人), click **Add Bot**
   (添加机器人) to create an empty instance, then **Connect WeChat** (连接微信).
2. Halo requests a QR code (`GET /ilink/bot/get_bot_qrcode`) and renders it.
3. The user scans with WeChat. UI shows `scaned` (waiting for confirmation) then `confirmed`
   (`weixinIlinkPollAuthStatus`, polled every ~2s, `WeixinIlinkInstanceCard.tsx`).
4. On `confirmed`, Halo persists `bot_token` + `accountId` (`ilink_bot_id`) + `baseUrl` into the
   instance config and reloads the channel manager to start long-polling.
5. Bind a **Digital Human** in the instance card — same binding model as every other channel
   (one instance → exactly one app).

There is no separate "manual setup" button for this channel — every instance goes through this
QR flow, including reconnecting after a session expiry.

## 3. What is NOT available (do not offer, do not promise)

- **No group chats.** `chatType: 'direct'` is hardcoded in the inbound handler — this channel
  only ever produces direct-message conversations.
- **No permission control UI.** `WeixinIlinkInstanceCard.tsx` has no owners/guest section.
  Anyone who messages the connected personal WeChat account gets full, unrestricted tool access
  — there is no way to restrict this for this channel today.
- **No streaming.** The provider builds a plain `ReplyHandle` with only `send`; there is no
  `streaming` capability.
- **No manual credential entry.** See §2 — QR login only.

## 4. Message semantics worth knowing

- **`context_token` gates every outbound send.** WeChat's protocol requires echoing back the
  `context_token` from the most recent inbound message; Halo caches the latest one per
  `${accountId}:${userId}`. **Proactive push (`notify_bot`, auto-sync) to a contact who has never
  messaged first will fail** — `pushToChat` explicitly returns `false` with "no context_token —
  blocked until next inbound message from user" until that contact sends at least one message.
  This is a hard protocol constraint, not a Halo limitation to route around.
- **Session expiry ends the connection, not just one call.** iLink signals expiry with
  `errcode`/`ret === -14` on *either* the poll or the send path. On expiry the instance halts
  itself (`haltOnFatal()`) and requires a brand-new QR login — there is no silent token refresh.
- **Media items degrade gracefully.** A failed image/file/video download becomes a text
  placeholder (`[Image — download failed]` etc.) rather than dropping the whole message.

## 5. Diagnosis

| Symptom | Likely cause | Where to check |
|---|---|---|
| QR code shown but never reaches "connected" | User hasn't scanned yet, or scanned with the wrong WeChat account | Re-generate via **Refresh**; confirm the phone's WeChat account is the one meant to run the bot |
| Instance was connected, now shows "Not connected" | Session expired (protocol code -14) or 100 reconnect attempts exhausted | Console: `Session expired (code -14) — re-auth via QR required`, or `Max reconnect attempts (100) reached` — either way, redo the QR login (§2) |
| `notify_bot` / auto-sync push silently fails to a known contact | No `context_token` cached for that user yet | The contact must send at least one message to this bot first — this is a protocol requirement, not configurable (§4) |
| Bot only ever sees direct messages, never groups | Expected — this channel has no group support | Point the user at WeCom Intelligent Bot (`wecom-bot.md`) if they need groups |
| A guest/random contact has full tool access and the user wants to restrict it | No permission control exists for this channel | There is currently no way to restrict access per-contact for `weixin-ilink-bot`; this is a real gap, not a misconfiguration — do not claim a setting exists to fix it |

## Do not ask / do not assume

- **Do not ask for a bot token, API key, or app secret** — there is nothing to type in; QR login
  is the only credential path.
- **Do not offer group-chat, permission-control, or streaming options** for this channel — none
  exist (§3).
- **Do not assume a proactive push failure means the channel is broken** — check whether the
  target contact has ever messaged first (§4) before treating it as a bug.

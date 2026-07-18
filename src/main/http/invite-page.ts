/**
 * Office-invite landing page.
 *
 * The shareable invite link is a plain http(s) URL pointing at the inviter's
 * own server with `?office=&invite=` query params. When it is opened in a
 * BROWSER (instead of being pasted into the app), this page is what the invitee
 * sees: who invited them, to which office, one button that hands off into the
 * installed app via the `halo://join` deep link, and a download path when Halo
 * is not installed yet.
 *
 * Security notes:
 *   - The invite token is NEVER echoed into the HTML by the server. The deep
 *     link is assembled client-side from `location.search`, so the page body
 *     carries no secret and is safe to cache/log.
 *   - Server-rendered strings (office/inviter names) are HTML-escaped.
 */

import { loadProductConfig } from '../foundation/product-config'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Latest-release download URL derived from the product's update config. */
function getDownloadUrl(): string | null {
  const update = loadProductConfig().updateConfig
  if (update?.provider === 'github' && update.owner && update.repo) {
    return `https://github.com/${encodeURIComponent(update.owner)}/${encodeURIComponent(update.repo)}/releases/latest`
  }
  return null
}

export interface InvitePageContext {
  /** Office display name; falls back to a neutral label when unknown. */
  officeName: string | null
  /** Inviter display name; falls back to a neutral label when unknown. */
  inviterName: string | null
}

export function getInvitePage(ctx: InvitePageContext): string {
  const office = escapeHtml(ctx.officeName ?? '')
  const inviter = escapeHtml(ctx.inviterName ?? '')
  const downloadUrl = getDownloadUrl()

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex">
  <title>Halo</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      padding: 1.5rem;
    }
    .card { text-align: center; max-width: 420px; width: 100%; }
    .logo {
      width: 72px; height: 72px; border-radius: 50%;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      margin: 0 auto 1.25rem;
      display: flex; align-items: center; justify-content: center;
      font-size: 1.75rem;
      box-shadow: 0 0 30px rgba(102, 126, 234, 0.4);
    }
    h1 { font-size: 1.35rem; margin-bottom: 0.5rem; line-height: 1.4; }
    .office { color: #a5b4fc; }
    .sub { color: #999; font-size: 0.95rem; margin-bottom: 2rem; line-height: 1.6; }
    .open-btn {
      display: inline-block; width: 100%; padding: 0.95rem 1.5rem;
      border: none; border-radius: 12px; cursor: pointer;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff; font-size: 1rem; font-weight: 600; text-decoration: none;
      transition: opacity 0.15s ease;
    }
    .open-btn:hover { opacity: 0.9; }
    .hint { color: #777; font-size: 0.85rem; margin-top: 1.25rem; line-height: 1.7; }
    .hint a { color: #a5b4fc; text-decoration: none; }
    .hint a:hover { text-decoration: underline; }
    .note {
      color: #c9a94e; font-size: 0.82rem; margin-top: 1rem; line-height: 1.6;
      background: rgba(201, 169, 78, 0.08); border: 1px solid rgba(201, 169, 78, 0.25);
      border-radius: 10px; padding: 0.7rem 0.9rem;
    }
    .divider { color: #555; margin: 0 0.4rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">✨</div>
    <h1 id="title"></h1>
    <p class="sub" id="sub"></p>
    <a class="open-btn" id="open" href="#"></a>
    <p class="note" id="note"></p>
    <p class="hint" id="hint"></p>
  </div>
  <script>
    (function () {
      var zh = (navigator.language || '').toLowerCase().indexOf('zh') === 0
      var office = ${JSON.stringify(office)}
      var inviter = ${JSON.stringify(inviter)}

      var title = zh
        ? (inviter ? inviter + ' 邀请你加入办公室' : '你被邀请加入一间办公室')
        : (inviter ? inviter + ' invited you to join an office' : 'You are invited to join an office')
      document.getElementById('title').innerHTML =
        title + (office ? '<br><span class="office">「' + office + '」</span>' : '')

      document.getElementById('sub').textContent = zh
        ? '带上你自己的数字人加入，和大家在同一间办公室实时协作。'
        : 'Bring your own digital humans and collaborate live in the same office.'

      // Hand off into the installed app. The deep link is built from THIS page's
      // own query string, so the invite secret never appears in the page body.
      var params = new URLSearchParams(location.search)
      var deepLink = 'halo://join?office=' + encodeURIComponent(params.get('office') || '')
        + '&invite=' + encodeURIComponent(params.get('invite') || '')
        + '&server=' + encodeURIComponent(location.origin)
      var open = document.getElementById('open')
      open.setAttribute('href', deepLink)
      open.textContent = zh ? '在 Halo 中打开' : 'Open in Halo'

      // Set expectations up front: joining connects to the inviter's machine, so
      // both sides must be on the same network (or a gateway is configured). Without
      // this, a cross-network click looks like a broken link with no explanation.
      document.getElementById('note').textContent = zh
        ? '需要和邀请你的人在同一网络（或已配置网关）才能加入。若打不开或加入失败，多半是不在同一网络。'
        : 'You must be on the same network as the person who invited you (or have a gateway configured) to join. A broken link or failed join usually means you are on different networks.'

      var download = ${JSON.stringify(downloadUrl)}
      var hint = document.getElementById('hint')
      if (download) {
        hint.innerHTML = (zh
          ? '还没有安装 Halo？<a href="' + download + '">下载安装</a>，装好后重新打开这条邀请链接即可。'
          : 'Don\\u2019t have Halo yet? <a href="' + download + '">Download it</a>, then open this invite link again.')
      } else {
        hint.textContent = zh
          ? '还没有安装 Halo？安装后重新打开这条邀请链接即可。'
          : 'Don\\u2019t have Halo yet? Install it, then open this invite link again.'
      }
    })()
  </script>
</body>
</html>`
}

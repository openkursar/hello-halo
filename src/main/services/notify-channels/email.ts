/**
 * Notify Channels — Email (SMTP) Channel
 *
 * Sends notification emails using nodemailer.
 * Users configure their own SMTP credentials (QQ Mail, 163, Gmail, etc.).
 */

import type { EmailChannelConfig, NotificationPayload, NotifySendResult } from '../../../shared/types/notification-channels'
import { normalizeEmailChannelConfig } from '../../../shared/email-channel-config'

// Use dynamic import for nodemailer since it's a large dependency
let nodemailerModule: typeof import('nodemailer') | null = null

async function getNodemailer() {
  if (!nodemailerModule) {
    nodemailerModule = await import('nodemailer')
  }
  return nodemailerModule
}

/**
 * Send a notification email via SMTP.
 */
export async function sendEmail(
  rawConfig: EmailChannelConfig,
  payload: NotificationPayload
): Promise<NotifySendResult> {
  const config = normalizeEmailChannelConfig(rawConfig)
  const channel = 'email' as const
  console.log(`[NotifyChannel][Email] Sending to=${config.defaultTo}, subject="${payload.title}"`)

  try {
    const nodemailer = await getNodemailer()

    const transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.password,
      },
      tls: {
        rejectUnauthorized: false,
        ...(config.tlsCiphers ? { ciphers: config.tlsCiphers } : {}),
      },
    })

    const timestamp = new Date(payload.timestamp).toLocaleString()

    await transporter.sendMail({
      from: `"Halo" <${config.smtp.user}>`,
      to: config.defaultTo,
      subject: `[Halo] ${payload.title}`,
      text: `${payload.body}\n\n---\n${payload.appName ? `App: ${payload.appName}\n` : ''}Time: ${timestamp}`,
      html: buildEmailHtml(payload, timestamp),
    })

    console.log(`[NotifyChannel][Email] Sent successfully`)
    return { channel, success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[NotifyChannel][Email] Failed:`, message)
    return { channel, success: false, error: message }
  }
}

/**
 * Test SMTP connection.
 */
export async function testEmail(rawConfig: EmailChannelConfig): Promise<{ success: boolean; error?: string }> {
  try {
    const config = normalizeEmailChannelConfig(rawConfig)
    const nodemailer = await getNodemailer()
    const transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: {
        user: config.smtp.user,
        pass: config.smtp.password,
      },
      tls: {
        rejectUnauthorized: false,
        ...(config.tlsCiphers ? { ciphers: config.tlsCiphers } : {}),
      },
    })
    await transporter.verify()
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function buildEmailHtml(payload: NotificationPayload, timestamp: string): string {
  const appInfo = payload.appName
    ? `<p style="color:#888;font-size:12px;">App: ${escapeHtml(payload.appName)}</p>`
    : ''

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <div style="background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:16px 20px;border-radius:8px 8px 0 0;">
        <h2 style="margin:0;font-size:18px;">Halo</h2>
      </div>
      <div style="background:#f9fafb;padding:20px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
        <h3 style="margin:0 0 12px;color:#111827;">${escapeHtml(payload.title)}</h3>
        <p style="margin:0 0 16px;color:#374151;white-space:pre-wrap;">${escapeHtml(payload.body)}</p>
        ${appInfo}
        <p style="color:#888;font-size:12px;margin:0;">Time: ${escapeHtml(timestamp)}</p>
      </div>
    </div>
  `
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

declare module 'nodemailer' {
  interface SmtpOptions {
    host: string
    port: number
    secure: boolean
    auth: { user: string; pass: string }
    tls?: { rejectUnauthorized?: boolean; ciphers?: string }
  }

  interface MessageOptions {
    from: string
    to: string
    cc?: string
    bcc?: string
    subject: string
    text?: string
    html?: string
    inReplyTo?: string
    references?: string
    attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>
  }

  export function createTransport(options: SmtpOptions): {
    verify(): Promise<true>
    sendMail(message: MessageOptions): Promise<{ messageId: string }>
  }
}

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, type AddressInfo, type Socket } from 'node:net'

export type MailAccount = 'primary' | 'control'
export interface MailCredentials { user: string; password: string }
export type MailFailure = 'none' | 'auth' | 'transport'
export interface SmtpReceipt {
  connection: string
  command: 'EHLO' | 'HELO' | 'AUTH' | 'MAIL' | 'RCPT' | 'DATA' | 'RSET' | 'QUIT' | 'NOOP' | 'UNKNOWN'
  status: number
  account?: MailAccount
  address?: string
  messageId?: string
}
export interface StoredMail {
  id: string
  account: MailAccount
  from: string
  to: string[]
  size: number
  raw: Buffer
}

export async function startAcceptanceSmtp(options: {
  directory: string
  accounts: Record<MailAccount, MailCredentials>
  recipients: string[]
}) {
  for (const credentials of Object.values(options.accounts)) {
    if (!/^[a-z0-9._+-]+@[a-z0-9.-]+\.test$/i.test(credentials.user) || !credentials.password.startsWith('local-only-')) throw new Error('SMTP fixtures require generated credentials and synthetic .test identities')
  }
  if (!options.recipients.length || options.recipients.some(address => !/^[a-z0-9._+-]+@[a-z0-9.-]+\.test$/i.test(address))) throw new Error('SMTP recipients must be explicitly owned .test identities')
  const directory = join(options.directory, 'smtp')
  mkdirSync(directory)
  const recipients = new Set(options.recipients.map(address => address.toLowerCase()))
  const sockets = new Set<Socket>()
  const receipts: SmtpReceipt[] = []
  const errors: string[] = []
  let failure: MailFailure = 'none'
  let closing = false
  const limit = 4 * 1024 * 1024
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    const connection = randomUUID()
    let pending = Buffer.alloc(0)
    let data = false
    let account: MailAccount | undefined
    let from: string | undefined
    let to: string[] = []
    let refused = false
    const resetEnvelope = () => { from = undefined; to = []; data = false }
    const reply = (command: SmtpReceipt['command'], status: number, text: string, extra: Partial<SmtpReceipt> = {}) => {
      receipts.push({ connection, command, status, ...(account ? { account } : {}), ...extra })
      socket.write(`${status} ${text}\r\n`)
    }
    const completeMessage = (wire: Buffer) => {
      if (failure === 'transport') {
        refused = true
        reply('DATA', 451, 'Synthetic temporary delivery refusal')
        resetEnvelope()
        return
      }
      if (!account || !from || to.length === 0) {
        reply('DATA', 503, 'An authenticated envelope is required')
        resetEnvelope()
        return
      }
      const raw = Buffer.from(wire.toString('latin1').replace(/(^|\r\n)\.\./g, '$1.'), 'latin1')
      const id = randomUUID()
      const record = { id, account, from, to: [...to], size: raw.length }
      try {
        writeFileSync(join(directory, `${id}.eml.tmp`), raw)
        writeFileSync(join(directory, `${id}.json.tmp`), JSON.stringify(record))
        renameSync(join(directory, `${id}.eml.tmp`), join(directory, `${id}.eml`))
        renameSync(join(directory, `${id}.json.tmp`), join(directory, `${id}.json`))
        reply('DATA', 250, 'Accepted into the isolated fixture store', { messageId: id })
      } catch (error) {
        errors.push(`SMTP persistence failed: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`)
        reply('DATA', 451, 'The isolated fixture store could not persist the message')
      }
      resetEnvelope()
    }
    const commandLine = (line: string) => {
      const split = line.indexOf(' ')
      const name = (split < 0 ? line : line.slice(0, split)).toUpperCase()
      const argument = split < 0 ? '' : line.slice(split + 1)
      if (name === 'EHLO' || name === 'HELO') {
        receipts.push({ connection, command: name, status: 250 })
        socket.write('250-acceptance.test\r\n250-AUTH PLAIN\r\n250-8BITMIME\r\n250 SIZE 4194304\r\n')
      } else if (name === 'AUTH') {
        const auth = argument.match(/^PLAIN\s+([A-Za-z0-9+/=]+)$/i)
        const fields = auth ? Buffer.from(auth[1], 'base64').toString('utf8').split('\0') : []
        const match = (Object.keys(options.accounts) as MailAccount[]).find(key => fields.length === 3 && fields[1] === options.accounts[key].user && fields[2] === options.accounts[key].password)
        if (!match || failure === 'auth') { refused = true; reply('AUTH', 535, 'Synthetic authentication refusal'); return }
        account = match
        reply('AUTH', 235, 'Authenticated with the isolated fixture')
      } else if (name === 'MAIL') {
        const address = argument.match(/^FROM:\s*<([^>]+)>/i)?.[1].toLowerCase()
        resetEnvelope()
        if (!account) { reply('MAIL', 530, 'Authentication is required'); return }
        if (address !== options.accounts[account].user.toLowerCase()) { reply('MAIL', 553, 'The sender must be the authenticated fixture account'); return }
        from = address
        reply('MAIL', 250, 'Sender accepted', { address })
      } else if (name === 'RCPT') {
        const address = argument.match(/^TO:\s*<([^>]+)>/i)?.[1].toLowerCase()
        if (!account || !from) { reply('RCPT', 503, 'An authenticated sender is required'); return }
        if (!address || !recipients.has(address)) { refused = true; reply('RCPT', 550, 'Recipient is outside the isolated fixture scope'); return }
        to.push(address)
        reply('RCPT', 250, 'Owned recipient accepted', { address })
      } else if (name === 'DATA') {
        if (!account || !from || to.length === 0) { reply('DATA', 503, 'An authenticated envelope is required'); return }
        data = true
        reply('DATA', 354, 'Send the synthetic message')
      } else if (name === 'RSET') { resetEnvelope(); reply('RSET', 250, 'Envelope reset') }
      else if (name === 'NOOP') reply('NOOP', 250, 'Ready')
      else if (name === 'QUIT') { reply('QUIT', 221, 'Closing the fixture connection'); socket.end() }
      else reply('UNKNOWN', 502, 'This command is not supported by the fixture')
    }
    socket.write('220 acceptance.test ESMTP isolated fixture\r\n')
    socket.on('data', chunk => {
      if (closing) return
      pending = Buffer.concat([pending, chunk])
      if (pending.length > limit) { reply('DATA', 552, 'Fixture message limit exceeded'); socket.destroy(); return }
      while (pending.length) {
        if (data) {
          const empty = pending.subarray(0, 3).equals(Buffer.from('.\r\n'))
          const end = empty ? 0 : pending.indexOf('\r\n.\r\n')
          if (end < 0) return
          const body = empty ? Buffer.alloc(0) : pending.subarray(0, end + 2)
          pending = pending.subarray(empty ? 3 : end + 5)
          completeMessage(body)
        } else {
          const end = pending.indexOf('\r\n')
          if (end < 0) return
          const line = pending.subarray(0, end).toString('utf8')
          pending = pending.subarray(end + 2)
          commandLine(line)
        }
      }
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (!closing && !(refused && error.code === 'ECONNRESET')) errors.push(`SMTP socket failed: ${error.code ?? 'unknown'}`)
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  server.on('error', (error: NodeJS.ErrnoException) => { if (!closing) errors.push(`SMTP listener failed: ${error.code ?? 'unknown'}`) })
  const port = (server.address() as AddressInfo).port
  return {
    port, receipts, errors,
    setFailure(value: MailFailure) { failure = value },
    readMessages(): StoredMail[] {
      return readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => {
        const metadata = JSON.parse(readFileSync(join(directory, name), 'utf8')) as Omit<StoredMail, 'raw'>
        return { ...metadata, raw: readFileSync(join(directory, `${metadata.id}.eml`)) }
      })
    },
    async close() {
      if (closing) return
      closing = true
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

export type AcceptanceSmtp = Awaited<ReturnType<typeof startAcceptanceSmtp>>

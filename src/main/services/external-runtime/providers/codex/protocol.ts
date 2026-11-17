import type { RuntimeProvider } from '../../provider'
import { RuntimeError } from '../../errors'

export const probeCodex: RuntimeProvider['probe'] = async (_candidate, run) => {
  const env = { CODEX_HOME: run.directory, OPENAI_BASE_URL: 'http://127.0.0.1:9', CODEX_DISABLE_UPDATE_CHECK: '1' }
  const output = await run({ args: ['--version'], env })
  const match = /^codex-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/m.exec(output)
  if (!match) throw new RuntimeError('version-unrecognized')
  run.reportVersion(match[1])
  let stage = 0
  const requests = [
    { id: 1, method: 'initialize', params: { clientInfo: { name: 'halo_runtime_probe', version: '1.0.0' }, capabilities: { experimentalApi: true } } },
    { id: 2, method: 'config/read', params: { includeLayers: false } },
    { id: 3, method: 'thread/list', params: { limit: 1 } }
  ]
  await run({ args: ['app-server'], env, input: JSON.stringify(requests[0]) + '\n', onLine: (line, send) => {
    let message
    try { message = JSON.parse(line) } catch { throw new RuntimeError('protocol-unsupported') }
    if (message.id !== requests[stage].id) return false
    if (message.error || !message.result || typeof message.result !== 'object') throw new RuntimeError('protocol-unsupported')
    if (stage === 0) {
      if (typeof message.result.userAgent !== 'string') throw new RuntimeError('protocol-unsupported')
      send(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
    }
    if (stage === 1 && (!message.result.config || typeof message.result.config !== 'object')) throw new RuntimeError('protocol-unsupported')
    if (stage === 2 && !Array.isArray(message.result.data)) throw new RuntimeError('protocol-unsupported')
    stage++
    if (stage === requests.length) return true
    send(JSON.stringify(requests[stage]) + '\n')
    return false
  } })
  return match[1]
}

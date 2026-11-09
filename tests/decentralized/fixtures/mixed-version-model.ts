import { latestUserInput, createModelGate, startAcceptanceModel, type ModelRequest } from '../../e2e/fixtures/acceptance-model'
import { planModelTool } from '../../e2e/fixtures/acceptance-tool-discovery'

export async function startMixedVersionModel() {
  const model = await startAcceptanceModel()
  const commands = new Map<string, { kind: 'send' | 'answer' | 'hold'; target?: string; delivery?: string }>()
  const issues: string[] = []
  const gates: ReturnType<typeof createModelGate>[] = []
  const observed: Array<{ marker: string; sequence: number }> = []
  model.respond((request: ModelRequest) => {
    const input = latestUserInput(request)
    const matches = [...commands.keys()].filter(marker => input.includes(marker))
    const marker = matches.at(-1)
    if (!marker) return { text: 'No mixed-version instruction.' }
    const command = commands.get(marker)!
    observed.push({ marker, sequence: request.sequence })
    if (command.kind === 'send') {
      const id = `send-${marker}`
      const result = request.toolResults.find(result => result.id === id)
      if (result) {
        if (result.error || !/Message (accepted|delivered)/.test(result.text)) {
          const reason = /offline|NOT delivered/.test(result.text) ? 'recipient-unreachable'
            : /permission|contact|reporting|allowed/i.test(result.text) ? 'contact-refused' : 'invalid-tool-receipt'
          issues.push(`Tool execution failed for ${marker}: ${reason}; receipt=${result.text.slice(0, 240)}`)
          return { text: `UNDELIVERED_${marker}` }
        }
        return { text: `SENT_${marker}` }
      }
      const next = planModelTool(request, 'team_send', { to: command.target, message: command.delivery }, id)
      if ('call' in next) return { tools: [next.call] }
      issues.push(`Tool discovery failed for ${marker}`)
      return { text: `UNAVAILABLE_${marker}` }
    }
    if (command.kind === 'hold') {
      const gate = createModelGate()
      gates.push(gate)
      return { text: `STREAM_${marker}`, hold: gate.promise }
    }
    return { text: `RECEIVED_${marker}` }
  })
  return {
    ...model,
    issues,
    register(marker: string, command: { kind: 'send' | 'answer' | 'hold'; target?: string; delivery?: string }) {
      if (commands.has(marker)) throw new Error('Duplicate scripted instruction')
      commands.set(marker, command)
    },
    exchangesFor(marker: string) {
      const sequences = new Set(observed.filter(item => item.marker === marker).map(item => item.sequence))
      return model.exchanges.filter(exchange => sequences.has(exchange.request.sequence))
    },
    evidence() {
      return observed.map(({ marker, sequence }) => {
        const exchange = model.exchanges.find(item => item.request.sequence === sequence)!
        return { marker, sequence, protocol: exchange.request.protocol, completed: exchange.completed, cancelled: exchange.cancelled }
      })
    },
    async close() {
      await model.close()
      for (const gate of gates) gate.release()
    },
  }
}

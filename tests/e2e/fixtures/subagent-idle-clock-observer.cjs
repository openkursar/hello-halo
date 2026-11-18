const originalNow = Date.now
let offset = 0
let observedLog
let previousLog
const cleanup = []
Date.now = () => originalNow() + offset
function observeCurrentLogger() {
  previousLog = console.log
  observedLog = function (...args) {
    const text = args.map(String).join(' ')
    const match = text.match(/\[Agent\]\[([^\]]+)\] Cleaning up session: idle timeout \(30 min\)/)
    if (match) cleanup.push({ conversationId: match[1], observedAt: originalNow() })
    return previousLog.apply(this, args)
  }
  console.log = observedLog
}
const sessions = []
const dlopen = process.dlopen
process.dlopen = function (module, ...args) {
  const result = dlopen.call(this, module, ...args)
  const NativeSession = module.exports?.NativeSession
  if (typeof NativeSession === 'function') module.exports.NativeSession = new Proxy(NativeSession, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget)
      const options = JSON.parse(args[0])
      const observation = { sequence: sessions.length, model: options.model, closed: false }
      sessions.push(observation)
      const close = instance.close
      instance.close = function (...args) {
        const result = close.apply(this, args)
        if (result && typeof result.then === 'function') return result.then(value => { observation.closed = true; return value })
        observation.closed = true
        return result
      }
      return instance
    },
  })
  return result
}
globalThis.subagentIdleClock = {
  sessions() { return sessions.map(entry => ({ ...entry })) },
  advance() {
    if (offset) throw new Error('Idle test clock already advanced')
    observeCurrentLogger()
    offset = 31 * 60 * 1000
    return originalNow()
  },
  reset() {
    offset = 0
    if (console.log === observedLog) console.log = previousLog
  },
  observations() { return cleanup.map(entry => ({ ...entry })) },
}

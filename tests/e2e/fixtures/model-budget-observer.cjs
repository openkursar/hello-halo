const { Worker } = require('node:worker_threads')
const { ChildProcess } = require('node:child_process')

// Observe only numeric limits at the engine boundary; never retain prompts or credentials.
globalThis.modelBudgetObservations = []
const dlopen = process.dlopen
process.dlopen = function (module, ...args) {
  const result = dlopen.call(this, module, ...args)
  const NativeSession = module.exports?.NativeSession
  if (typeof NativeSession === 'function') {
    module.exports.NativeSession = new Proxy(NativeSession, {
      construct(target, args, newTarget) {
        const instance = Reflect.construct(target, args, newTarget)
        const options = JSON.parse(args[0])
        globalThis.modelBudgetObservations.push({ engine: 'halo', boundary: 'native-session', model: options.model, contextWindow: options.contextWindow, maxOutputTokens: options.maxOutputTokens })
        return instance
      },
    })
  }
  return result
}
const postMessage = Worker.prototype.postMessage
Worker.prototype.postMessage = function (message, ...args) {
  if (message?.type === 'request' && message.method === 'create') {
    const options = message.value?.encoded?.options
    if (options) globalThis.modelBudgetObservations.push({ engine: 'halo', model: options.model, contextWindow: options.contextWindow, maxOutputTokens: options.maxOutputTokens })
  }
  return postMessage.call(this, message, ...args)
}
const spawn = ChildProcess.prototype.spawn
ChildProcess.prototype.spawn = function (options) {
  const env = Object.fromEntries((options.envPairs ?? []).map(pair => {
    const separator = pair.indexOf('=')
    return [pair.slice(0, separator), pair.slice(separator + 1)]
  }))
  if (env.CLAUDE_CODE_AUTO_COMPACT_WINDOW && env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
    globalThis.modelBudgetObservations.push({ engine: 'anthropic', contextWindow: Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW), maxOutputTokens: Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) })
  }
  return spawn.call(this, options)
}

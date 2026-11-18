const electron = require('electron')

const NativeBrowserWindow = electron.BrowserWindow
const state = { created: 0, preventedPresentations: 0 }
const preventPresentation = () => { state.preventedPresentations++ }

const HiddenBrowserWindow = new Proxy(NativeBrowserWindow, {
  construct(target, [options = {}]) {
    const window = Reflect.construct(target, [{ ...options, show: false, focusable: false,
      webPreferences: { ...options.webPreferences, backgroundThrottling: false } }], target)
    state.created++
    for (const method of ['show', 'showInactive', 'focus', 'maximize', 'restore']) {
      Object.defineProperty(window, method, { value: preventPresentation, configurable: true })
    }
    return window
  },
})

const { Module } = require('node:module')
const load = Module._load
const hiddenElectron = Object.create(electron)
Object.defineProperty(hiddenElectron, 'BrowserWindow', { value: HiddenBrowserWindow })
Module._load = function (request, ...args) {
  return request === 'electron' || request === 'electron/main' ? hiddenElectron : load.call(this, request, ...args)
}
electron.app.setActivationPolicy?.('accessory')
electron.app.dock?.hide()
globalThis.acceptanceHiddenWindows = state

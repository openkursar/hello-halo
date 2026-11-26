const { ipcMain } = require('electron')

// Count deliveries without recording arguments or replacing the application's implementation.
const handle = ipcMain.handle.bind(ipcMain)
globalThis.orgIdentityRequests = 0
ipcMain.handle = (channel, listener) => handle(channel, channel.startsWith('enterprise-identity:')
  ? (...args) => { globalThis.orgIdentityRequests++; return listener(...args) }
  : listener)

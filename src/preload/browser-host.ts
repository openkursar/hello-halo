import { contextBridge } from 'electron'
import { browserHostBridge } from './browser-host-bridge'

contextBridge.exposeInMainWorld('halo', browserHostBridge)

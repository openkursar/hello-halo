/**
 * File Watcher Worker -- Utility Process entry point.
 *
 * This file runs in a separate OS process (child_process.fork).
 * It handles all file system watching and scanning, keeping the main process
 * event loop clean.
 *
 * Communication: process.on('message') / process.send()
 * Protocol: see src/shared/protocol/file-watcher.protocol.ts
 *
 * HARD CONSTRAINT: This file MUST NOT import anything from 'electron'.
 */

import type {
  MainToWorkerMessage,
  WorkerToMainMessage
} from '../../shared/protocol/file-watcher.protocol'
import {
  startWatcher,
  stopWatcher,
  stopAll,
  refreshIgnoreRules,
  setOnEventsCallback
} from './watcher'
import {
  scanDirectoryTreeShallow,
  scanDirectoryRecursive,
  loadIgnoreRules
} from './scanner'

// --- Messaging ---

function send(message: WorkerToMainMessage): void {
  if (process.send) {
    process.send(message)
  }
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
  send({ type: 'log', level, message })
}

// --- Event callback ---

setOnEventsCallback((spaceId, events) => {
  send({ type: 'fs-events', spaceId, events })
})

// --- Message handler ---

async function handleMessage(msg: MainToWorkerMessage): Promise<void> {
  try {
    switch (msg.type) {
      case 'init-space': {
        await startWatcher(msg.spaceId, msg.rootPath)
        send({ type: 'space-ready', spaceId: msg.spaceId })
        break
      }

      case 'destroy-space': {
        await stopWatcher(msg.spaceId)
        break
      }

      case 'scan-dir': {
        const ig = loadIgnoreRules(msg.rootPath)

        if (msg.mode === 'tree') {
          const nodes = await scanDirectoryTreeShallow(
            msg.dirPath, msg.rootPath, msg.depth, ig
          )
          send({
            type: 'scan-result',
            requestId: msg.requestId,
            spaceId: msg.spaceId,
            dirPath: msg.dirPath,
            nodes
          })
        } else {
          const artifacts = await scanDirectoryRecursive(
            msg.dirPath, msg.rootPath, msg.spaceId,
            msg.maxDepth ?? 1, 0, ig
          )
          send({
            type: 'scan-result',
            requestId: msg.requestId,
            spaceId: msg.spaceId,
            dirPath: msg.dirPath,
            artifacts
          })
        }
        break
      }

      case 'refresh-ignore': {
        refreshIgnoreRules(msg.spaceId, msg.rootPath)
        break
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    log('error', `Failed to handle message ${msg.type}: ${errMsg}`)

    if ('requestId' in msg) {
      send({
        type: 'scan-error',
        requestId: (msg as { requestId: string }).requestId,
        spaceId: msg.spaceId,
        error: errMsg
      })
    } else if ('spaceId' in msg) {
      send({
        type: 'space-error',
        spaceId: msg.spaceId,
        error: errMsg
      })
    }
  }
}

// --- Bootstrap ---

// Listen for messages from main process via child_process.fork IPC
process.on('message', (msg: MainToWorkerMessage) => {
  handleMessage(msg)
})

// Graceful shutdown
process.on('SIGTERM', async () => {
  log('info', 'Received SIGTERM, shutting down...')
  await stopAll()
  process.exit(0)
})

process.on('SIGINT', async () => {
  log('info', 'Received SIGINT, shutting down...')
  await stopAll()
  process.exit(0)
})

log('info', 'File watcher worker started')

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { test as base, expect } from './browser-site'
import { createTestConfigDir, cleanupTestConfigDir } from './electron'
import { packagedCommandEnvironment, type HostCommandPolicy } from './packaged-command-environment'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export function packagedAppPath(): string {
  if (process.env.HALO_E2E_PACKAGED_APP) return path.resolve(process.env.HALO_E2E_PACKAGED_APP)
  if (process.env.HALO_ACCEPTANCE_MODE) throw new Error('Acceptance packaged tests require a controlled HALO_E2E_PACKAGED_APP; an existing dist application is not accepted')
  if (process.platform === 'darwin') return path.join(projectRoot, process.arch === 'arm64' ? 'dist/mac-arm64' : 'dist/mac', 'Halo.app/Contents/MacOS/Halo')
  if (process.platform === 'win32') return path.join(projectRoot, 'dist/win-unpacked/Halo.exe')
  return path.join(projectRoot, 'dist/linux-unpacked/halo')
}

export const test = base.extend<{ hostCommands: HostCommandPolicy }>({
  hostCommands: ['inherit', { option: true }],
  electronApp: async ({ sdkEngine, hostCommands }, use, testInfo) => {
    const executablePath = packagedAppPath()
    if (!fs.existsSync(executablePath)) throw new Error(`Packaged app missing: ${executablePath}`)
    const { ELECTRON_RUN_AS_NODE: _unused, ...environment } = process.env
    const commandEnvironment = packagedCommandEnvironment(environment, hostCommands)
    const profile = createTestConfigDir(executablePath, undefined, { sdkEngine })
    const instance = await electron.launch({
      executablePath,
      args: ['--lang=en-US', ...(process.env.HALO_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
      env: { ...commandEnvironment, HOME: profile, USERPROFILE: profile, HALO_DATA_DIR: path.join(profile, '.halo'), HALO_E2E_TEST: '1', ELECTRON_DISABLE_GPU: '1' },
    })
    try {
      if (hostCommands === 'system-only') await testInfo.attach('packaged-launch-command-policy', {
        body: JSON.stringify({ hostCommands, launchPath: commandEnvironment.PATH, isolatedProfile: true, packagePathsAddedByFixture: false }), contentType: 'application/json',
      })
      await use(instance)
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        const log = path.join(profile, '.halo/logs/main.log')
        if (fs.existsSync(log)) await testInfo.attach('packaged-main-log', { body: fs.readFileSync(log).subarray(-500000), contentType: 'text/plain' })
      }
      await instance.close()
      cleanupTestConfigDir(profile)
    }
  },
})

export { expect }

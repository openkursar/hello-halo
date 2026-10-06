/**
 * Where a variant build writes its logs.
 *
 * On Windows and Linux a branded build's logs used to land in
 * <userData>/<variant>/ — a second folder named after the variant inside its
 * own data folder — while the logs/ folder beside it stayed empty.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'path'

const { fileTransport, isolateHttpLogPath, isolateSdkLogPath, product } = vi.hoisted(() => ({
  fileTransport: {} as { resolvePathFn?: (variables: { fileName?: string }) => string },
  isolateHttpLogPath: vi.fn(),
  isolateSdkLogPath: vi.fn(),
  product: { dataFolderName: 'halo' },
}))

vi.mock('electron-log/main.js', () => ({
  default: { transports: { file: fileTransport }, info: vi.fn() },
}))
vi.mock('../../../../src/main/foundation/product-config', () => ({
  getDataFolderName: () => product.dataFolderName,
  DEFAULT_DATA_FOLDER_NAME: 'halo',
}))
vi.mock('../../../../src/main/foundation/logging/http-transport', () => ({
  isolateHttpLogPath: (fn: unknown) => isolateHttpLogPath(fn),
}))
vi.mock('../../../../src/main/foundation/logging/sdk-transport', () => ({
  isolateSdkLogPath: (fn: unknown) => isolateSdkLogPath(fn),
}))

import { isolateLogPath } from '../../../../src/main/foundation/logging/log-isolation'

/** An Electron app whose paths follow each platform's defaults for the given userData. */
function fakeApp(platform: NodeJS.Platform, userData: string, packaged = true) {
  const paths: Record<string, string> = {
    userData,
    logs: platform === 'darwin' ? '/Users/u/Library/Logs/Halo' : join(userData, 'logs'),
  }
  return {
    isPackaged: packaged,
    getPath: (name: string) => paths[name],
    setPath: vi.fn((name: string, value: string) => {
      paths[name] = value
    }),
  }
}

function isolate(platform: NodeJS.Platform, app: ReturnType<typeof fakeApp>): string | undefined {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  isolateLogPath(app as never)
  return fileTransport.resolvePathFn?.({ fileName: 'main.log' })
}

const realPlatform = process.platform
const realDataDir = process.env.HALO_DATA_DIR

describe('variant log folder', () => {
  beforeEach(() => {
    delete process.env.HALO_DATA_DIR
    delete fileTransport.resolvePathFn
    isolateHttpLogPath.mockClear()
    isolateSdkLogPath.mockClear()
    product.dataFolderName = 'halo-enterprise'
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    if (realDataDir === undefined) delete process.env.HALO_DATA_DIR
    else process.env.HALO_DATA_DIR = realDataDir
  })

  it.each(['win32', 'linux'] as const)('writes a packaged variant on %s to its own logs folder', (platform) => {
    const userData = '/data/halo-enterprise'
    const app = fakeApp(platform, userData)

    expect(isolate(platform, app)).toBe(join(userData, 'logs', 'main.log'))
    expect(app.setPath).toHaveBeenCalledWith('logs', join(userData, 'logs'))
    // The dedicated transports follow the same folder.
    expect(isolateHttpLogPath).toHaveBeenCalled()
    expect(isolateSdkLogPath).toHaveBeenCalled()
  })

  it('keeps a macOS variant in its own folder under the shared logs parent', () => {
    expect(isolate('darwin', fakeApp('darwin', '/Users/u/Library/Application Support/halo-enterprise')))
      .toBe('/Users/u/Library/Logs/halo-enterprise/main.log')
  })

  it('keeps a dev run apart from the installed copy it shares userData with', () => {
    product.dataFolderName = 'halo'
    const userData = '/data/Halo'
    expect(isolate('win32', fakeApp('win32', userData, false))).toBe(join(userData, 'halo-dev', 'main.log'))
  })

  it('leaves the packaged default build on its default folder', () => {
    product.dataFolderName = 'halo'
    const app = fakeApp('win32', '/data/Halo')

    expect(isolate('win32', app)).toBeUndefined()
    expect(app.setPath).not.toHaveBeenCalled()
  })

  it('puts a custom data dir’s logs inside it, whatever the variant', () => {
    process.env.HALO_DATA_DIR = '/cluster/node-2'
    expect(isolate('linux', fakeApp('linux', '/data/halo-enterprise'))).toBe('/cluster/node-2/logs/main.log')
  })
})

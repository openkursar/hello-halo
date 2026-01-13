/**
 * Git Bash Installer Service - Download and install Portable Git for Windows
 *
 * Downloads Portable Git from mirrors (China-friendly) and extracts it locally.
 * This allows Windows users without Git to use Claude Code's shell features.
 */

import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import https from 'https'
import http from 'http'
import { execSync } from 'child_process'
import { getAppLocalGitBashDir } from './git-bash.service'

// Portable Git version to download
const PORTABLE_GIT_VERSION = '2.47.1'

export interface DownloadProgress {
  phase: 'downloading' | 'extracting' | 'configuring' | 'done' | 'error'
  progress: number  // 0-100
  message: string
  error?: string
}

export type ProgressCallback = (progress: DownloadProgress) => void

/**
 * Get download sources for Portable Git
 * Uses China-friendly mirrors first, then GitHub as fallback
 */
function getDownloadSources(arch: '64' | '32'): string[] {
  const filename = `PortableGit-${PORTABLE_GIT_VERSION}-${arch}-bit.7z.exe`
  const version = `v${PORTABLE_GIT_VERSION}.windows.1`

  return [
    // China-friendly mirrors (faster in mainland)
    `https://registry.npmmirror.com/-/binary/git-for-windows/${version}/${filename}`,
    `https://mirrors.huaweicloud.com/git-for-windows/${version}/${filename}`,
    // GitHub as fallback (may be slow in China)
    `https://github.com/git-for-windows/git/releases/download/${version}/${filename}`
  ]
}

/**
 * Download and install Portable Git
 *
 * @param onProgress - Callback for progress updates
 * @returns Installation result with path or error
 */
export async function downloadAndInstallGitBash(
  onProgress: ProgressCallback
): Promise<{ success: boolean; path?: string; error?: string }> {
  const arch = process.arch === 'x64' ? '64' : '32'
  const sources = getDownloadSources(arch)
  const tempDir = app.getPath('temp')
  const tempFile = join(tempDir, `PortableGit-${arch}.7z.exe`)
  const installDir = getAppLocalGitBashDir()

  try {
    // Phase 1: Download
    onProgress({ phase: 'downloading', progress: 0, message: 'Connecting to download server...' })

    let downloaded = false
    let lastError = ''

    for (let i = 0; i < sources.length; i++) {
      const url = sources[i]
      try {
        console.log(`[GitBash] Trying download source ${i + 1}/${sources.length}: ${url}`)
        await downloadFile(url, tempFile, (percent) => {
          onProgress({
            phase: 'downloading',
            progress: percent,
            message: `Downloading command execution environment... ${percent}%`
          })
        })
        downloaded = true
        console.log('[GitBash] Download completed successfully')
        break
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        console.log(`[GitBash] Download source ${url} failed: ${lastError}, trying next...`)
      }
    }

    if (!downloaded) {
      throw new Error(`All download sources failed: ${lastError}`)
    }

    // Phase 2: Extract and install
    onProgress({ phase: 'extracting', progress: 0, message: 'Installing...' })

    // Ensure install directory exists
    if (!existsSync(installDir)) {
      mkdirSync(installDir, { recursive: true })
    }

    // Silent extraction (-y auto confirm, -o output directory)
    // PortableGit-*.7z.exe is a self-extracting archive
    console.log(`[GitBash] Extracting to: ${installDir}`)
    execSync(`"${tempFile}" -y -o"${installDir}"`, {
      windowsHide: true,
      timeout: 180000  // 3 minutes timeout for extraction
    })

    onProgress({ phase: 'extracting', progress: 100, message: 'Installation complete' })

    // Phase 3: Configure
    onProgress({ phase: 'configuring', progress: 0, message: 'Configuring environment...' })

    const bashPath = join(installDir, 'bin', 'bash.exe')
    if (!existsSync(bashPath)) {
      throw new Error('Installation completed but bash.exe not found, extraction may have failed')
    }

    // Clean up temp file
    try {
      unlinkSync(tempFile)
      console.log('[GitBash] Temp file cleaned up')
    } catch {
      // Ignore cleanup errors
    }

    onProgress({ phase: 'done', progress: 100, message: 'Initialization complete' })

    console.log(`[GitBash] Installation completed: ${bashPath}`)
    return { success: true, path: bashPath }

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error('[GitBash] Installation failed:', errorMsg)

    onProgress({
      phase: 'error',
      progress: 0,
      message: 'Initialization failed',
      error: errorMsg
    })

    // Clean up temp file on error
    try {
      if (existsSync(tempFile)) unlinkSync(tempFile)
    } catch {
      // Ignore cleanup errors
    }

    return { success: false, error: errorMsg }
  }
}

/**
 * Download a file from URL with progress callback
 */
function downloadFile(
  url: string,
  destPath: string,
  onProgress: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http

    const request = protocol.get(url, { timeout: 30000 }, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location
        if (redirectUrl) {
          console.log(`[GitBash] Following redirect to: ${redirectUrl}`)
          downloadFile(redirectUrl, destPath, onProgress).then(resolve).catch(reject)
          return
        }
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`))
        return
      }

      const totalSize = parseInt(response.headers['content-length'] || '0', 10)
      let downloadedSize = 0

      const file = createWriteStream(destPath)

      response.on('data', (chunk) => {
        downloadedSize += chunk.length
        if (totalSize > 0) {
          const percent = Math.round((downloadedSize / totalSize) * 100)
          onProgress(percent)
        }
      })

      response.pipe(file)

      file.on('finish', () => {
        file.close()
        resolve()
      })

      file.on('error', (err) => {
        file.close()
        reject(err)
      })
    })

    request.on('error', reject)
    request.on('timeout', () => {
      request.destroy()
      reject(new Error('Download timed out'))
    })
  })
}

/**
 * Get estimated download size for display
 */
export function getEstimatedDownloadSize(): string {
  return '~50MB'
}

/**
 * Get Portable Git version
 */
export function getPortableGitVersion(): string {
  return PORTABLE_GIT_VERSION
}

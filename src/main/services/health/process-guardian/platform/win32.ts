/**
 * Platform-specific process operations for Windows
 *
 * Uses PowerShell and wmic for process discovery and management.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import type { PlatformProcessOps, ProcessInfo, ChildProcessInfo } from '../../types'

const execAsync = promisify(exec)

/**
 * Windows implementation of platform process operations
 */
export class Win32ProcessOps implements PlatformProcessOps {
  /**
   * Find processes by command-line pattern
   * Uses PowerShell for reliable command-line searching
   */
  async findByArgs(pattern: string): Promise<ProcessInfo[]> {
    const results: ProcessInfo[] = []

    try {
      // Use PowerShell to search for processes with matching command line
      // Get-WmiObject provides access to full command line
      const psCommand = `powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*${pattern}*' } | Select-Object ProcessId, Name, CommandLine | ConvertTo-Json -Compress"`

      const { stdout } = await execAsync(psCommand, { timeout: 10000 })

      if (!stdout.trim()) {
        return []
      }

      // Parse JSON output
      const parsed = JSON.parse(stdout)

      // Handle single result (not an array) or array
      const processes = Array.isArray(parsed) ? parsed : [parsed]

      for (const proc of processes) {
        if (proc && proc.ProcessId) {
          results.push({
            pid: proc.ProcessId,
            commandLine: proc.CommandLine || '',
            name: proc.Name
          })
        }
      }
    } catch (error: unknown) {
      const err = error as { message?: string }
      // Empty result is not an error
      if (err.message?.includes('ConvertTo-Json')) {
        return []
      }
      console.error('[Health][Win32] Failed to find processes:', error)
    }

    return results
  }

  /**
   * Kill a process by PID
   * Uses taskkill command
   */
  async killProcess(pid: number, signal: string = 'SIGTERM'): Promise<void> {
    try {
      // /F forces termination (equivalent to SIGKILL)
      // /T terminates child processes
      const forceFlag = signal === 'SIGKILL' ? '/F ' : ''
      await execAsync(`taskkill ${forceFlag}/PID ${pid} /T`, { timeout: 5000 })
      console.log(`[Health][Win32] Killed process ${pid}`)
    } catch {
      // Goal-based validation: verify the process is gone regardless of error message
      // This approach is language-agnostic and works on any Windows locale
      if (!this.isProcessAlive(pid)) {
        console.log(`[Health][Win32] Process ${pid} no longer exists`)
        return
      }
      // Process still alive after kill attempt - this is a real failure
      throw new Error(`Failed to terminate process ${pid}`)
    }
  }

  /**
   * Check if a process is still alive
   * Uses tasklist to check process existence
   */
  isProcessAlive(pid: number): boolean {
    try {
      // Use synchronous approach with process.kill for consistency
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * Find child processes by parent PID (PPID scanning)
   * Uses PowerShell to query by ParentProcessId
   */
  async findChildProcesses(ppid: number): Promise<ChildProcessInfo[]> {
    const results: ChildProcessInfo[] = []

    try {
      // Use PowerShell to find processes with matching ParentProcessId
      const psCommand = `powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.ParentProcessId -eq ${ppid} } | Select-Object ProcessId, ParentProcessId, Name | ConvertTo-Json -Compress"`

      const { stdout } = await execAsync(psCommand, { timeout: 10000 })

      if (!stdout.trim()) {
        return []
      }

      // Parse JSON output
      const parsed = JSON.parse(stdout)

      // Handle single result (not an array) or array
      const processes = Array.isArray(parsed) ? parsed : [parsed]

      for (const proc of processes) {
        if (proc && proc.ProcessId) {
          results.push({
            pid: proc.ProcessId,
            ppid: proc.ParentProcessId,
            name: proc.Name || ''
          })
        }
      }
    } catch (error: unknown) {
      const err = error as { message?: string }
      // Empty result is not an error
      if (err.message?.includes('ConvertTo-Json')) {
        return []
      }
      console.error('[Health][Win32] Failed to find child processes:', error)
    }

    return results
  }
}

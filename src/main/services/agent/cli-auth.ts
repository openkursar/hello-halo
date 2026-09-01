/**
 * Delegated authentication state of the bundled Claude Code CLI.
 *
 * The CLI keeps its own credential store, namespaced by `CLAUDE_CONFIG_DIR`:
 * on macOS a Keychain entry whose name embeds a hash of that directory, on
 * other platforms `<configDir>/.credentials.json`. Halo therefore owns a login
 * slot independent of the user's personal `claude` install, and never holds a
 * token itself — the subprocess authenticates on its own behalf.
 *
 * State is read from `<configDir>/.claude.json` rather than from the credential
 * store: reading the Keychain entry from Halo would raise a system
 * authorization prompt, whereas the CLI records the signed-in account in that
 * file on every successful login.
 *
 * Kept free of spawn/path dependencies so the credential-resolution path can
 * import it. The login command that writes this state is built in sdk-config,
 * alongside the CLI path resolution it needs.
 */

import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { resolveClaudeConfigDir } from '../../foundation/config.service'
import { getActiveEngine } from './resolved-sdk'

/** Login state of Halo's credential slot in the bundled CLI. */
export interface CliAuthState {
  loggedIn: boolean
  /** Signed-in account label for display; empty when the CLI recorded none. */
  account: string
  /** Absolute path of the slot this state was read from. */
  configDir: string
}

interface ClaudeCliConfigFile {
  oauthAccount?: {
    emailAddress?: string
    displayName?: string
    organizationName?: string
  }
}

/**
 * Read the login state of Halo's slot. Never throws: a missing or malformed
 * config file is an unauthenticated slot, which is exactly the state a
 * first-time user is in.
 */
export function readCliAuthState(): CliAuthState {
  const configDir = resolveClaudeConfigDir()
  const configFile = path.join(configDir, '.claude.json')

  if (!existsSync(configFile)) {
    return { loggedIn: false, account: '', configDir }
  }

  try {
    const parsed = JSON.parse(readFileSync(configFile, 'utf-8')) as ClaudeCliConfigFile
    const account = parsed.oauthAccount
    if (!account) {
      return { loggedIn: false, account: '', configDir }
    }
    return {
      loggedIn: true,
      account: account.emailAddress || account.displayName || account.organizationName || '',
      configDir
    }
  } catch (error) {
    console.warn(`[CliAuth] Unreadable ${configFile}:`, (error as Error).message)
    return { loggedIn: false, account: '', configDir }
  }
}

/**
 * Reject a turn that would run on a delegated source the CLI cannot
 * authenticate.
 *
 * Both conditions otherwise surface as the same thing — a subprocess that dies
 * at startup leaving only a stderr line — so they are caught at credential
 * resolution, where the message can name the fix.
 */
export function assertDelegatedAuthReady(): void {
  const engine = getActiveEngine()
  if (engine && engine !== 'anthropic') {
    throw new Error(
      `CLI-delegated sources run on the Claude Code engine; the active engine is "${engine}". ` +
      'Switch the engine in Settings, or pick another AI source.'
    )
  }

  if (!readCliAuthState().loggedIn) {
    throw new Error(
      'The Claude Code CLI is not signed in for Halo. Open Settings > AI Sources and run the delegated login.'
    )
  }
}

// ============================================================================
// macos-floor — which Macs a Mac update feed may offer the update to
//
// electron-updater skips an update whose feed carries `minimumSystemVersion`
// above the running OS, but compares it with os.release(): the Darwin kernel
// version, not the macOS version (electron-updater 6.6.2, in every shipped
// Halo). A feed therefore states the Darwin version of the app's
// LSMinimumSystemVersion. The macOS number itself would gate nothing: "12.0.0"
// is below the Darwin version of every macOS Halo has ever supported.
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'

/** Darwin version of a macOS release's first build, e.g. "12.0.0" → "21.0.0". */
export function darwinVersionForMacOS(version) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(version ?? '').trim())
  if (!match) throw new Error(`not a macOS version: "${version}"`)
  const [major, minor, patch] = match.slice(1).map((part) => Number(part ?? 0))

  let darwin = null
  if (major === 10 && minor >= 4 && patch === 0) darwin = minor + 4
  else if (major >= 11 && major <= 15 && minor === 0 && patch === 0) darwin = major + 9
  // Apple renumbered macOS by year after 15: macOS 26 is Darwin 25.
  else if (major >= 26 && minor === 0 && patch === 0) darwin = major - 1
  if (darwin === null) {
    throw new Error(`macOS ${version} has no whole Darwin release to gate on — declare a floor such as "${major}.0.0"`)
  }
  return `${darwin}.0.0`
}

/** LSMinimumSystemVersion of a packaged .app, or null when it declares none. */
export function readMinimumMacOS(appPath) {
  const plist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8')
  return /<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1].trim() ?? null
}

function readBundleVersion(appPath) {
  const plist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8')
  return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1].trim() ?? null
}

/**
 * The macOS that every packaged app of `version` under `dist` (dist/mac*\/*.app)
 * requires — read from the apps themselves, so a feed states exactly what makes
 * macOS refuse to open the update. Apps left over from other builds are ignored.
 */
export function packagedMinimumMacOS(dist, version) {
  const floors = new Map()
  for (const dir of fs.readdirSync(dist, { withFileTypes: true })) {
    if (!dir.isDirectory() || !/^mac(-|$)/.test(dir.name)) continue
    for (const name of fs.readdirSync(path.join(dist, dir.name))) {
      const appPath = path.join(dist, dir.name, name)
      if (!name.endsWith('.app') || readBundleVersion(appPath) !== version) continue
      floors.set(`${dir.name}/${name}`, readMinimumMacOS(appPath))
    }
  }

  if (floors.size === 0) throw new Error(`no packaged mac app of version ${version} under ${dist}`)
  const undeclared = [...floors].filter(([, floor]) => !floor).map(([app]) => app)
  if (undeclared.length > 0) throw new Error(`${undeclared.join(', ')} declare no LSMinimumSystemVersion`)
  const distinct = [...new Set(floors.values())]
  if (distinct.length > 1) {
    throw new Error(`packaged apps disagree on the minimum macOS: ${[...floors].map(([app, floor]) => `${app} → ${floor}`).join(', ')}`)
  }
  return distinct[0]
}

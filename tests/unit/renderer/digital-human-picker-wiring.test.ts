/**
 * Every picker that offers digital humans for new work goes through the shared
 * rule in utils/people-model, so a member a temporary collaboration built is
 * never offered. The rule itself is tested in people-model.test.ts. These
 * pickers open their lists only on a click, which this Node environment cannot
 * render, so their wiring is pinned at the source.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const source = (file: string) =>
  readFileSync(resolve(__dirname, '../../../src/renderer/components', file), 'utf-8')

describe('digital-human pickers use the shared rule', () => {
  it.each([
    ['team/TeamCreateDialog.tsx', /const availableApps = useMemo\(\(\) => teamMemberCandidates\(apps, teams\)/, /pickableApps\.map\(/],
    ['team/TeamJoinDialog.tsx', /const bringable = useMemo\(\(\) => teamMemberCandidates\(apps, teams\)/, /bringable\.map\(/],
    ['team/SettingsTab.tsx', /const candidates = useMemo\(\(\) =>\s+teamMemberCandidates\(allApps, teams\)/, /candidates\.map\(/],
  ])('%s offers members from teamMemberCandidates', (file, rule, rendered) => {
    const code = source(file)
    expect(code).toMatch(rule)
    expect(code).toMatch(rendered)
    // A picker that filters digital humans by itself bypasses the rule.
    expect(code).not.toMatch(/spec\.type === 'automation'/)
  })

  it('store sharing offers installed digital humans through pickableDigitalHumans', () => {
    const code = source('store/ShareToStoreDialog.tsx')
    expect(code).toMatch(/pickableDigitalHumans\(installedOfType, teams\)/)
    expect(code).toMatch(/<InstalledPicker\s+apps=\{offeredInstalled\}/)
  })
})

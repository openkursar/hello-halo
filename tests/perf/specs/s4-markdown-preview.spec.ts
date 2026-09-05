/**
 * S4 — File preview: markdown (the scenario user pointed at directly:
 * "连 md 文件都卡"). MarkdownViewer.tsx:196-232 renders the whole file into a
 * single `<Streamdown mode="static">` with no virtualization/chunking — this
 * scenario is what proves or disproves that theory with real numbers:
 * open duration, longtask distribution during open (captured between the
 * reset-before-click and the loaded-after-open snapshots), DOM Nodes after
 * render, and 60s idle CPU once rendering settles.
 */

import { test, expect } from '@playwright/test'
import { runFilePreviewScenario } from '../lib/file-preview-scenario'

test('S4 markdown preview (2MB extreme)', async () => {
  const result = await runFilePreviewScenario({
    scenario: 's4-markdown-preview',
    fixtureFileName: 'md-extreme-2mb.md',
    idleCpuMs: 60000
  })

  expect(result.status).toBe('ok')
  expect(result.durationMs).toBeGreaterThan(0)
})

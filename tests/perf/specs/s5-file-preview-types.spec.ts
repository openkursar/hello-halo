/**
 * S5 — File preview across every content type with a real renderer
 * (perf-file-preview-map.md §0): markdown / code / json / csv / image / html
 * / text / pdf. Each type gets its own launch + result JSON — user feedback
 * says "不同类型的 canvas 卡的程度还不一样", so blending them into one number
 * would hide exactly what we're looking for.
 *
 * csv gets three tiers (50KB/500KB/5MB): CsvViewer.tsx renders
 * `dataRows.map()` with no virtualization, so the 5MB tier is expected to
 * hang — that hang is itself the result (`toleratesHang: true`, recorded as
 * `status: "hung"`, never thrown as a test failure).
 *
 * pdf opens via BrowserViewer, a *separate* Electron renderer process
 * (Chromium's native PDF viewer in a BrowserView) — `includePerProcess`
 * records a per-pid breakdown so that process isn't blended into the main
 * window's renderer numbers.
 */

import { test, expect } from '@playwright/test'
import { runFilePreviewScenario } from '../lib/file-preview-scenario'

test('S5 markdown (2MB)', async () => {
  const result = await runFilePreviewScenario({
    scenario: 's5-markdown',
    fixtureFileName: 'md-extreme-2mb.md',
    idleCpuMs: 60000
  })
  expect(result.status).toBe('ok')
})

test('S5 code (20000 lines)', async () => {
  const result = await runFilePreviewScenario({
    scenario: 's5-code',
    fixtureFileName: 'code-extreme-20000lines.ts',
    idleCpuMs: 60000
  })
  expect(result.status).toBe('ok')
})

test('S5 json (5MB)', async () => {
  const result = await runFilePreviewScenario({
    scenario: 's5-json',
    fixtureFileName: 'json-extreme-large.json',
    idleCpuMs: 60000
  })
  expect(result.status).toBe('ok')
})

test('S5 csv typical (50KB)', async () => {
  const result = await runFilePreviewScenario({
    scenario: 's5-csv-50kb',
    fixtureFileName: 'csv-typical.csv',
    idleCpuMs: 60000
  })
  expect(result.status).toBe('ok')
})

test('S5 csv medium (500KB)', async () => {
  const result = await runFilePreviewScenario({
    scenario: 's5-csv-500kb',
    fixtureFileName: 'csv-medium-500kb.csv',
    idleCpuMs: 60000,
    openTimeoutMs: 90000,
    toleratesHang: true
  })
  expect(['ok', 'hung', 'error']).toContain(result.status)
})

test('S5 csv extreme (5MB)', async () => {
  const result = await runFilePreviewScenario({
    scenario: 's5-csv-5mb',
    fixtureFileName: 'csv-extreme-large.csv',
    idleCpuMs: 60000,
    openTimeoutMs: 90000,
    toleratesHang: true
  })
  // A hang OR a crash is the expected finding here (CsvViewer has no
  // virtualization) — not a test failure. `runFilePreviewScenario` already
  // throws for anything it can't classify, so reaching this line at all
  // means the run completed and produced a result JSON either way.
  expect(['ok', 'hung', 'error']).toContain(result.status)
})

test('S5 image (huge png)', async () => {
  const result = await runFilePreviewScenario({
    scenario: 's5-image',
    fixtureFileName: 'image-extreme-huge.png',
    idleCpuMs: 60000
  })
  expect(result.status).toBe('ok')
})

test('S5 html (2MB)', async () => {
  const result = await runFilePreviewScenario({
    scenario: 's5-html',
    fixtureFileName: 'html-extreme-2mb.html',
    idleCpuMs: 60000
  })
  expect(result.status).toBe('ok')
})

test('S5 text/log (5MB)', async () => {
  const result = await runFilePreviewScenario({
    scenario: 's5-text',
    fixtureFileName: 'text-extreme-5mb.log',
    idleCpuMs: 60000
  })
  expect(result.status).toBe('ok')
})

test('S5 pdf (300 pages)', async () => {
  const result = await runFilePreviewScenario({
    scenario: 's5-pdf',
    fixtureFileName: 'pdf-extreme-large.pdf',
    idleCpuMs: 60000,
    loadingKind: 'pdf',
    includePerProcess: true
  })
  expect(result.status).toBe('ok')
})

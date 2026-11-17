import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeId, RuntimeStatus } from '../../../src/shared/types/external-runtime'

vi.mock('../../../src/renderer/i18n', () => ({ useTranslation: () => ({ t: (text: string, args?: Record<string, string>) => text.replace(/{{(\w+)}}/g, (_, key) => args?.[key] ?? key) }) }))
vi.mock('../../../src/renderer/api', () => ({ api: {} }))
import { RuntimeDownloadPanel } from '../../../src/renderer/components/settings/external-runtime/DownloadPanel'
import { RuntimeInstallationList } from '../../../src/renderer/components/settings/external-runtime/InstallationList'

function status(runtimeId: RuntimeId): RuntimeStatus {
  return {
    recommendedVersion: runtimeId === 'codex' ? '0.128.0' : '2.1.310',
    sourceId: 'official', sources: [{ id: 'official', name: 'Official', baseUrl: 'https://example.test' }],
    installations: [], selected: null, install: { phase: 'idle', downloadedBytes: 0 },
    catalogTruncated: false, installVersion: runtimeId === 'codex' ? '0.128.0' : '2.1.310',
    recommendedRange: '', verifiedVersions: [],
  }
}

describe.each(['anthropic', 'codex'] as const)('shared runtime UI for %s', runtimeId => {
  it('keeps recommended, other-version and source controls in the same panel', () => {
    const html = renderToStaticMarkup(createElement(RuntimeDownloadPanel, {
      runtimeId, status: status(runtimeId), installing: false, busy: false,
      onInstall: vi.fn(), onSelect: vi.fn(), onRefresh: vi.fn(), onFindLocal: vi.fn(),
    }))
    expect(html).toContain('Install recommended version')
    expect(html).toContain('Install another version')
    expect(html).toContain('Source settings')
    expect(html).toContain(runtimeId === 'codex' ? 'Official (OpenAI)' : 'Official (Anthropic)')
    const custom = renderToStaticMarkup(createElement(RuntimeDownloadPanel, {
      runtimeId, status: { ...status(runtimeId), sourceId: 'custom' }, installing: false, busy: false,
      onInstall: vi.fn(), onSelect: vi.fn(), onRefresh: vi.fn(), onFindLocal: vi.fn(),
    }))
    expect(custom).toContain(runtimeId === 'codex' ? 'npm-compatible registry' : 'official download layout')
  })

  it('keeps provenance-aware recommended reuse available after saving another source', () => {
    const current = status(runtimeId)
    const item = { path: '/fixture/selected', version: current.recommendedVersion, compatibility: 'verified' as const, managed: true, recommended: true, sourceId: 'official' }
    const html = renderToStaticMarkup(createElement(RuntimeDownloadPanel, {
      runtimeId, status: { ...current, sourceId: 'custom', selectedPath: item.path, selected: item, installations: [item], sources: [...current.sources, { id: 'custom', name: 'Mirror', baseUrl: 'https://mirror.example.test' }] },
      installing: false, busy: false, onInstall: vi.fn(), onSelect: vi.fn(), onRefresh: vi.fn(), onFindLocal: vi.fn(),
    }))
    expect(html).toContain('Use installed version')
    expect(html).toContain(`Version ${current.recommendedVersion} is already installed.`)
    expect(html).not.toContain('No download needed.')
    expect(html).not.toContain('>Selected</button>')
    expect(html).not.toMatch(/disabled=""[^>]*>[^<]*Use installed version/)
  })

  it('lists the correct engine without leaking the other engine label', () => {
    const html = renderToStaticMarkup(createElement(RuntimeInstallationList, {
      runtimeId, installations: [{ path: '/fixture/runtime', version: status(runtimeId).recommendedVersion, compatibility: 'unchecked', managed: false, recommended: true }],
      onSelect: vi.fn(), onCheck: vi.fn(),
    }))
    expect(html).toContain(runtimeId === 'codex' ? 'Installed Codex versions' : 'Installed Claude Code versions')
    expect(html).toContain('Use this version')
    expect(html).toContain('Halo will check this installation before using it.')
    expect(html).not.toContain(runtimeId === 'codex' ? 'Claude Code' : 'Codex')
  })
})

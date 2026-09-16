/**
 * Guards the custom-model-id binding in the provider editor.
 *
 * Original bug: `ModelConfigPanel` was given the dropdown selection even when
 * the user had typed a custom model id, so Model Config edits saved under the
 * previous dropdown model's key and never took effect for the typed id.
 *
 * Fixing that by binding the panel to the raw input traded one bug for two:
 * two capability round-trips per keystroke, and edits landing under
 * half-typed ids. Hence the committed-id rule these tests pin.
 *
 * The rendering is still covered by source assertions at the bottom (this
 * repo runs vitest in a Node environment with no DOM), but the rule itself is
 * tested through `resolveModelSelection`.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

import { resolveModelSelection } from '../../../src/renderer/components/settings/model-selection'

describe('resolveModelSelection', () => {
  it('uses the dropdown selection when custom mode is off', () => {
    expect(resolveModelSelection({
      useCustomModel: false,
      customModelDraft: 'ignored-draft',
      committedCustomModelId: 'ignored-commit',
      selectedModel: 'gpt-4o'
    })).toEqual({ configured: 'gpt-4o', submitted: 'gpt-4o' })
  })

  // The whole point of the committed id: a half-typed model id must never
  // reach ModelConfigPanel, or every keystroke fires capability RPCs and can
  // persist an override under `gpt-4o-mi`.
  it('configures nothing while a custom draft is uncommitted', () => {
    for (const draft of ['g', 'gp', 'gpt-4o-mi']) {
      expect(resolveModelSelection({
        useCustomModel: true,
        customModelDraft: draft,
        committedCustomModelId: '',
        selectedModel: 'previous-dropdown-model'
      }).configured).toBe('')
    }
  })

  it('configures the draft once it is committed', () => {
    expect(resolveModelSelection({
      useCustomModel: true,
      customModelDraft: 'gpt-4o-mini',
      committedCustomModelId: 'gpt-4o-mini',
      selectedModel: 'previous-dropdown-model'
    })).toEqual({ configured: 'gpt-4o-mini', submitted: 'gpt-4o-mini' })
  })

  it('stops configuring as soon as the draft diverges from the committed id', () => {
    expect(resolveModelSelection({
      useCustomModel: true,
      customModelDraft: 'gpt-4o-mini-2',
      committedCustomModelId: 'gpt-4o-mini',
      selectedModel: 'previous-dropdown-model'
    }).configured).toBe('')
  })

  it('re-activates when the draft is edited back to the committed id', () => {
    expect(resolveModelSelection({
      useCustomModel: true,
      customModelDraft: '  gpt-4o-mini  ',
      committedCustomModelId: 'gpt-4o-mini',
      selectedModel: 'x'
    }).configured).toBe('gpt-4o-mini')
  })

  // Regression: the original bug was Model Config writing under the dropdown
  // model while a custom id was active. Neither id may ever leak back.
  it('never falls back to the dropdown selection in custom mode', () => {
    const cases = [
      { customModelDraft: '', committedCustomModelId: '' },
      { customModelDraft: 'typing', committedCustomModelId: '' },
      { customModelDraft: 'typing', committedCustomModelId: 'other' }
    ]
    for (const c of cases) {
      const result = resolveModelSelection({
        useCustomModel: true,
        selectedModel: 'dropdown-model',
        ...c
      })
      expect(result.configured).not.toBe('dropdown-model')
      expect(result.submitted).not.toBe('dropdown-model')
    }
  })

  it('treats a blank draft as nothing to configure or submit', () => {
    expect(resolveModelSelection({
      useCustomModel: true,
      customModelDraft: '   ',
      committedCustomModelId: '',
      selectedModel: 'dropdown-model'
    })).toEqual({ configured: '', submitted: '' })
  })

  // Intentional asymmetry: saving a typed-but-uncommitted id saves that id
  // with no overrides, rather than carrying the previously committed id's
  // capability edits onto a different model.
  it('submits the trimmed draft even when nothing is configured', () => {
    expect(resolveModelSelection({
      useCustomModel: true,
      customModelDraft: '  brand-new-model  ',
      committedCustomModelId: 'older-model',
      selectedModel: 'dropdown-model'
    })).toEqual({ configured: '', submitted: 'brand-new-model' })
  })
})

describe('ProviderSelector wiring', () => {
  const source = readFileSync(
    resolve(__dirname, '../../../src/renderer/components/settings/ProviderSelector.tsx'),
    'utf8'
  )

  it('routes both panels through the resolved selection', () => {
    const panels = [...source.matchAll(/<ModelConfigPanel[\s\S]*?\/>/g)]
    expect(panels.length).toBeGreaterThanOrEqual(2)
    for (const panel of panels) {
      expect(panel[0]).toContain('modelId={effectiveModelId}')
      expect(panel[0]).toContain('catalogCapability={catalogCapability}')
      expect(panel[0]).not.toContain('modelId={selectedModel}')
    }
    expect(source).toContain('resolveModelSelection({')
    expect(source).not.toContain('showCustomModel && customModelInput ? customModelInput : selectedModel')
  })
})

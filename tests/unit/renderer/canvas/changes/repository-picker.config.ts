import { defineConfig } from 'vitest/config'
import unitConfig from '../../../../vitest.config'

export default defineConfig({
  ...unitConfig,
  test: {
    ...unitConfig.test,
    include: ['unit/renderer/canvas/changes/repository-picker.ui.ts', 'unit/renderer/canvas/changes/repository-reveal.ui.ts'],
  },
})

import { defineConfig } from 'vitest/config'
import unitConfig from '../../vitest.config'

export default defineConfig({
  ...unitConfig,
  test: { ...unitConfig.test, include: ['unit/renderer/team-member-rail.ui.ts'] },
})

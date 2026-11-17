import type { RuntimeProvider } from '../../provider'
import { materializeCodex } from './archive'
import { discoverCodexCandidates, getCodexPlatform, resolveCodexCandidate } from './local'
import { CODEX_PLATFORMS, RECOMMENDED_INTEGRITY, RECOMMENDED_VERSION, requiredComponents, type CodexPlatform } from './policy'
import { getCodexDownloadSource } from '../../../../foundation/product-config'
import { probeCodex } from './protocol'
import { fetchCodexRelease } from './releases'

export const codexProvider: RuntimeProvider = {
  id: 'codex', configKey: 'codexRuntime', directoryName: 'codex',
  recommendedVersion: RECOMMENDED_VERSION, recommendedRange: RECOMMENDED_VERSION,
  officialSource: { id: 'official', name: 'Official npm registry', baseUrl: 'https://registry.npmjs.org' },
  presetSource: getCodexDownloadSource,
  getPlatform: getCodexPlatform,
  verifiedVersions: () => [],
  isRecommendedVersion: version => version === RECOMMENDED_VERSION,
  isVerifiedRuntime: () => false,
  resolveCandidate: resolveCodexCandidate,
  discoveryCandidates: discoverCodexCandidates,
  probe: probeCodex,
  fetchRelease: fetchCodexRelease,
  materialize: materializeCodex,
  requiredComponents: platform => platform in CODEX_PLATFORMS ? requiredComponents(platform as CodexPlatform) : [],
  pinnedIntegrity: (version, platform) => version === RECOMMENDED_VERSION && platform in CODEX_PLATFORMS
    ? RECOMMENDED_INTEGRITY[platform as CodexPlatform] : undefined,
}

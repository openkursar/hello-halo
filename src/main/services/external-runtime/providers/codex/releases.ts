import type { RuntimeDownloadSource } from '../../../../../shared/types/external-runtime'
import type { RuntimeArtifact } from '../../provider'
import { RuntimeError } from '../../errors'
import { readMetadataResponse } from '../../transfer'
import { CODEX_PLATFORMS, RECOMMENDED_INTEGRITY, RECOMMENDED_VERSION, type CodexPlatform } from './policy'

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuntimeError('invalid-manifest')
  return value as Record<string, any>
}

export async function fetchCodexRelease(source: RuntimeDownloadSource, requestedVersion: string, platform: string, signal: AbortSignal): Promise<RuntimeArtifact> {
  if (!(platform in CODEX_PLATFORMS)) throw new RuntimeError('unsupported-platform')
  const target = CODEX_PLATFORMS[platform as CodexPlatform]
  if (!VERSION.test(requestedVersion) && !['latest', 'stable'].includes(requestedVersion)) throw new RuntimeError('invalid-version')
  const base = new URL(source.baseUrl.endsWith('/') ? source.baseUrl : `${source.baseUrl}/`)
  let secure = base.protocol === 'https:'
  const metadata = async (version: string) => {
    const response = await readMetadataResponse(new URL(`@openai%2Fcodex/${encodeURIComponent(version)}`, base).toString(), signal)
    secure ||= new URL(response.url).protocol === 'https:'
    try { return object(JSON.parse(response.text)) }
    catch (cause) { throw new RuntimeError('invalid-manifest', { cause }) }
  }
  const wrapper = await metadata(requestedVersion)
  if (wrapper.name !== '@openai/codex' || typeof wrapper.version !== 'string' || !VERSION.test(wrapper.version) || wrapper.version.length > 80
    || (VERSION.test(requestedVersion) && wrapper.version !== requestedVersion)) throw new RuntimeError('invalid-manifest')
  const version = wrapper.version
  const payloadVersion = `${version}-${platform}`
  const aliases = object(wrapper.optionalDependencies)
  if (aliases[`@openai/codex-${platform}`] !== `npm:@openai/codex@${payloadVersion}`) throw new RuntimeError('invalid-manifest')
  const payload = await metadata(payloadVersion)
  const dist = object(payload.dist)
  if (payload.name !== '@openai/codex' || payload.version !== payloadVersion || !Array.isArray(payload.os) || payload.os.length !== 1 || payload.os[0] !== target.os
    || !Array.isArray(payload.cpu) || payload.cpu.length !== 1 || payload.cpu[0] !== target.cpu
    || typeof dist.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist.integrity)) throw new RuntimeError('invalid-manifest')
  const bytes = Buffer.from(dist.integrity.slice(7), 'base64')
  if (bytes.length !== 64 || `sha512-${bytes.toString('base64')}` !== dist.integrity) throw new RuntimeError('invalid-manifest')
  if (version === RECOMMENDED_VERSION && dist.integrity !== RECOMMENDED_INTEGRITY[platform as CodexPlatform]) throw new RuntimeError('checksum-mismatch')
  let url: URL
  try { url = new URL(dist.tarball) } catch { throw new RuntimeError('invalid-manifest') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (secure && url.protocol !== 'https:')) throw new RuntimeError('invalid-source')
  return { requestedVersion, version, payloadVersion, sourceId: source.id, platform, checksum: bytes.toString('hex'), integrity: dist.integrity, url: url.toString(), recommended: version === RECOMMENDED_VERSION }
}

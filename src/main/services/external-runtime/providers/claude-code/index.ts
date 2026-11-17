import { existsSync } from 'node:fs';
import { chmod, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { getConfig } from '../../../../foundation/config.service';
import { getClaudeCodeDownloadSource } from '../../../../foundation/product-config';
import { hasExplicitCcSelection } from '../../../../../shared/types/cc-runtime';
import { RuntimeError } from '../../errors';
import type { RuntimeProvider } from '../../provider';
import { MAX_BINARY_BYTES, readMetadataResponse, validateTransferUrl } from '../../transfer';
import { resolveCandidate } from './paths';
import { compareVersion, getVerifiedVersionsForPlatform, isRecommendedVersion, isVerifiedRuntime, MINIMUM_VERSION, OFFICIAL_SOURCE, RECOMMENDED_RANGE, RECOMMENDED_VERSION, VERSION_PATTERN } from './policy';
export function getNativePlatform(): string {
  if (!['darwin', 'linux', 'win32'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
    throw new RuntimeError('unsupported-platform');
  }
  const musl = process.platform === 'linux' && (existsSync('/lib/libc.musl-x86_64.so.1') || existsSync('/lib/libc.musl-aarch64.so.1'));
  return `${process.platform}-${process.arch}${musl ? '-musl' : ''}`;
}
export const claudeCodeProvider: RuntimeProvider = {
  id: 'anthropic',
  configKey: 'ccRuntime',
  directoryName: 'claude-code',
  recommendedVersion: RECOMMENDED_VERSION,
  recommendedRange: RECOMMENDED_RANGE,
  officialSource: OFFICIAL_SOURCE,
  presetSource: getClaudeCodeDownloadSource,
  getPlatform: getNativePlatform,
  verifiedVersions: getVerifiedVersionsForPlatform,
  isRecommendedVersion,
  isVerifiedRuntime,
  resolveCandidate,
  hasExplicitSelection: config => hasExplicitCcSelection(config, getConfig().aiSources),
  async discoveryCandidates({
    selectedPath,
    root,
    signal,
    childDirectories
  }) {
    const home = homedir(),
      binary = process.platform === 'win32' ? 'claude.exe' : 'claude',
      paths = new Set<string>();
    if (selectedPath) {
      paths.add(selectedPath);
    }
    const managed = await childDirectories(root, 12);
    if (signal.aborted) {
      return {
        paths: [...paths],
        truncated: true
      };
    }
    managed.paths.forEach(path => paths.add(join(path, binary)));
    let truncated = managed.truncated;
    const common = process.platform === 'win32' ? [join(home, '.local', 'bin'), process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '', process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'claude') : ''] : [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', join(home, '.npm-global', 'bin'), join(home, '.volta', 'bin')];
    for (const path of common.filter(Boolean)) {
      paths.add(join(path, binary));
      if (process.platform === 'win32') {
        paths.add(join(path, 'claude.cmd'));
      }
      paths.add(join(path, process.platform === 'win32' ? 'node_modules/@anthropic-ai/claude-code/cli.js' : '../lib/node_modules/@anthropic-ai/claude-code/cli.js'));
    }
    const versions = await childDirectories(join(home, '.nvm', 'versions', 'node'), 8);
    if (signal.aborted) {
      return {
        paths: [...paths],
        truncated: true
      };
    }
    versions.paths.forEach(path => paths.add(join(path, 'bin', binary)));
    truncated ||= versions.truncated;
    for (const directory of (process.env.PATH || '').split(delimiter)) {
      if (!isAbsolute(directory)) {
        continue;
      }
      if (paths.size >= 64) {
        truncated = true;
        break;
      }
      ;
      paths.add(join(directory, binary));
      if (process.platform === 'win32') {
        paths.add(join(directory, 'claude.cmd'));
      }
    }
    return {
      paths: [...paths],
      truncated
    };
  },
  async probe(_candidate, run) {
    const env = {
      CLAUDE_CONFIG_DIR: run.directory,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9'
    };
    const output = await run({
        args: ['--version'],
        env
      }),
      match = output.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*\(Claude Code\)/);
    if (!match) {
      throw new RuntimeError('version-unrecognized');
    }
    const version = match[1];
    run.reportVersion(version);
    if (compareVersion(version, MINIMUM_VERSION) < 0) {
      throw new RuntimeError('version-too-old');
    }
    const controls = [{
      subtype: 'initialize',
      hooks: {},
      sdkMcpServers: []
    }, {
      subtype: 'set_permission_mode',
      mode: 'default'
    }, {
      subtype: 'cancel_async_message',
      message_uuid: '00000000-0000-4000-8000-000000000000'
    }, {
      subtype: 'set_max_thinking_tokens',
      max_thinking_tokens: 0
    }];
    let index = 0,
      malformed = 0;
    const message = () => JSON.stringify({
      type: 'control_request',
      request_id: `halo-probe-${index}`,
      request: controls[index]
    }) + '\n';
    try {
      await run({
        args: ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}', '--no-session-persistence'],
        env,
        input: message(),
        onLine(line, send) {
          let value;
          try {
            value = JSON.parse(line);
          } catch {
            malformed++;
            return false;
          }
          if (value?.type !== 'control_response' || value.response?.request_id !== `halo-probe-${index}`) {
            return false;
          }
          const response = value.response;
          if (response.subtype !== 'success' || index === 0 && (!Array.isArray(response.response?.commands) || !Array.isArray(response.response?.models)) || index === 2 && response.response?.cancelled !== false) {
            throw new RuntimeError('protocol-unsupported');
          }
          if (++index === controls.length) {
            return true;
          }
          send(message());
          return false;
        }
      });
    } finally {
      if (malformed) {
        console.warn('[ExternalRuntime] Claude Code probe ignored malformed output', {
          count: malformed
        });
      }
    }
    return version;
  },
  async fetchRelease(source, requestedVersion, platform, signal) {
    let secure = new URL(source.baseUrl).protocol === 'https:';
    const metadata = async (url: string) => {
      const response = await readMetadataResponse(url, signal);
      secure ||= new URL(response.url).protocol === 'https:';
      return response.text;
    };
    const version = VERSION_PATTERN.test(requestedVersion) ? requestedVersion : (await metadata(`${source.baseUrl}/${requestedVersion}`)).trim();
    if (!VERSION_PATTERN.test(version) || version.length > 80) {
      throw new RuntimeError('invalid-manifest');
    }
    if (compareVersion(version, MINIMUM_VERSION) < 0) {
      throw new RuntimeError('version-too-old');
    }
    let manifest;
    try {
      manifest = JSON.parse(await metadata(`${source.baseUrl}/${version}/manifest.json`));
    } catch (cause) {
      if (cause instanceof RuntimeError) {
        throw cause;
      }
      throw new RuntimeError('invalid-manifest', {
        cause
      });
    }
    if (manifest?.version !== version || !manifest.platforms || typeof manifest.platforms !== 'object') {
      throw new RuntimeError('invalid-manifest');
    }
    const artifact = manifest.platforms[platform];
    if (!artifact) {
      throw new RuntimeError('unsupported-platform');
    }
    if (typeof artifact.checksum !== 'string' || !/^[a-fA-F0-9]{64}$/.test(artifact.checksum) || artifact.size !== undefined && (!Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > MAX_BINARY_BYTES)) {
      throw new RuntimeError('invalid-manifest');
    }
    const url = `${source.baseUrl}/${version}/${platform}/${process.platform === 'win32' ? 'claude.exe' : 'claude'}`;
    validateTransferUrl(url, secure);
    return {
      requestedVersion,
      version,
      sourceId: source.id,
      platform,
      checksum: artifact.checksum.toLowerCase(),
      ...(artifact.size !== undefined ? {
        size: artifact.size
      } : {}),
      recommended: isRecommendedVersion(version),
      url
    };
  },
  async materialize(_artifact, archivePath, directory) {
    const executable = process.platform === 'win32' ? 'claude.exe' : 'claude';
    await rename(archivePath, join(directory, executable));
    await chmod(join(directory, executable), 0o755);
    return {
      executable
    };
  },
  async indexManagedDirectory(name, root) {
    const match = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-(darwin|linux|win32)-(arm64|x64)(-musl)?-([a-f0-9]{16})(?:-[a-f0-9-]+)?$/i.exec(name);
    if (!match) {
      return null;
    }
    const [, version, os, arch, musl = '', checksumPrefix] = match,
      path = join(root, name, os === 'win32' ? 'claude.exe' : 'claude');
    if (!(await stat(path)).isFile()) {
      return null;
    }
    return {
      installation: {
        path,
        version,
        kind: 'native',
        managed: true,
        compatibility: 'unchecked',
        recommended: isRecommendedVersion(version)
      },
      integrity: {
        platform: `${os}-${arch}${musl}`,
        checksumPrefix: checksumPrefix.toLowerCase()
      }
    };
  }
};

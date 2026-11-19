import type { RuntimeConfig, RuntimeDownloadSource, RuntimeId, RuntimeInstallation, RuntimeLaunch, RuntimeReleaseInfo } from '../../../shared/types/external-runtime';
export interface ResolvedCandidate {
  path: string;
  resolvedPath: string;
  stamp: string;
  launch: Omit<RuntimeLaunch, 'version'>;
}
export interface RuntimeComponent {
  path: string;
  checksum: string;
  size: number;
}
export interface RuntimeArtifact extends RuntimeReleaseInfo {
  url: string;
  integrity?: string;
  payloadVersion?: string;
}
export interface ProbeProcess {
  args: string[];
  env?: Record<string, string>;
  input?: string;
  onLine?: (line: string, send: (message: string) => void) => boolean;
}
export interface RuntimeProbeRunner {
  (process: ProbeProcess): Promise<string>;
  directory: string;
  reportVersion(version: string): void;
}
export interface RuntimeProvider {
  id: RuntimeId;
  configKey: 'ccRuntime' | 'codexRuntime';
  directoryName: string;
  recommendedVersion: string;
  recommendedRange: string;
  officialSource: RuntimeDownloadSource;
  presetSource(): {
    baseUrl: string;
    name?: string;
  } | undefined;
  getPlatform(): string;
  verifiedVersions(): string[];
  isRecommendedVersion(version: string): boolean;
  isVerifiedRuntime(version: string, kind: 'native' | 'javascript'): boolean;
  resolveCandidate(input: string): Promise<ResolvedCandidate>;
  discoveryCandidates(context: {
    selectedPath?: string;
    root: string;
    signal: AbortSignal;
    childDirectories(path: string, limit: number): Promise<{
      paths: string[];
      truncated: boolean;
    }>;
  }): Promise<{
    paths: string[];
    truncated: boolean;
  }>;
  probe(candidate: ResolvedCandidate, run: RuntimeProbeRunner): Promise<string>;
  fetchRelease(source: RuntimeDownloadSource, requestedVersion: string, platform: string, signal: AbortSignal): Promise<RuntimeArtifact>;
  materialize(artifact: RuntimeArtifact, archivePath: string, directory: string, signal: AbortSignal): Promise<{
    executable: string;
    components?: RuntimeComponent[];
  }>;
  indexManagedDirectory?(name: string, root: string): Promise<{
    installation: RuntimeInstallation;
    integrity?: {
      platform: string;
      checksumPrefix?: string;
    };
  } | null>;
  requiredComponents?(platform: string): string[];
  pinnedIntegrity?(version: string, platform: string): string | undefined;
  hasExplicitSelection?(config: RuntimeConfig): boolean;
}

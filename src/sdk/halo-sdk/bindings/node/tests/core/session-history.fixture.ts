import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { TranscriptOptions } from '../../contracts/core/transcript.js';

const locations = new Map<string, { cwd: string; options?: TranscriptOptions }>();

export function transcriptLocation(path: string) {
  const location = locations.get(path);
  if (!location) throw new Error(`Unknown fixture transcript: ${path}`);
  return location;
}

export function getTranscriptPath(sessionId: string, cwd: string, options?: TranscriptOptions): string {
  const env = options?.env ?? process.env;
  const config = options?.conventions;
  const root = env[config?.configDirEnv ?? 'CLAUDE_CONFIG_DIR'] || join(env.HOME ?? homedir(), config?.userConfigDirName ?? '.claude');
  const path = join(root, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  locations.set(path, { cwd, options });
  return path;
}

export function getLegacyRecordPath(sessionId: string, agentId: string, cwd: string, options?: TranscriptOptions): string {
  return join(dirname(getTranscriptPath(sessionId, cwd, options)), sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

export function transcriptExists(sessionId: string, cwd: string, options?: TranscriptOptions): boolean {
  return existsSync(getTranscriptPath(sessionId, cwd, options));
}

export async function appendToTranscript(path: string, entry: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`);
}

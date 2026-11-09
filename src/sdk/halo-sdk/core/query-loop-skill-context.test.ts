/**
 * Skill-catalog injection tests.
 *
 * The catalog rides the same ephemeral per-turn prepend as the user context:
 * it must reach the provider when the Skill tool is available, stay out of
 * persistent history, and never appear when the tool was filtered away.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryLoop } from './query-loop.js';
import { SkillTool } from '../tools/skill/index.js';
import { buildSkillContextMessage } from '../prompt/skill-context.js';
import type { SDKMessage } from './query-types.js';
import type {
  LlmProvider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
  StreamEvent,
  UsageInfo,
} from '../types/provider.js';
import type { QueryConfig } from '../types/config.js';

const TEST_CAPS: ProviderCapabilities = {
  streaming: true,
  toolCalling: true,
  thinking: false,
  imageInput: false,
  pdfInput: false,
  audioInput: false,
  videoInput: false,
  caching: false,
  systemPromptStyle: 'top_level',
};

function makeUsage(): UsageInfo {
  return { input_tokens: 10, output_tokens: 20 };
}

/** Isolated env: cwd = fixture project, HOME = empty fixture home. */
function makeEnv(cwd: string, home: string): Record<string, string | undefined> {
  return { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: undefined };
}

function makeConfig(
  cwd: string,
  home: string,
  overrides: Partial<QueryConfig> = {},
): QueryConfig {
  return {
    model: 'test-model',
    contextWindow: 200_000,
    maxTurns: 3,
    cwd,
    env: makeEnv(cwd, home),
    permissionMode: 'bypassPermissions',
    systemPrompt: 'You are a test assistant.',
    thinking: { type: 'disabled' },
    abortSignal: new AbortController().signal,
    ...overrides,
  } as QueryConfig;
}

function makeRecordingProvider(): { provider: LlmProvider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'recording',
    name: 'Recording',
    capabilities: () => TEST_CAPS,
    async createMessage(): Promise<ProviderResponse> {
      throw new Error('not used');
    },
    async *createMessageStream(
      req: ProviderRequest,
    ): AsyncGenerator<StreamEvent, void, undefined> {
      requests.push(req);
      yield { type: 'message_start', id: `msg_${randomUUID()}`, model: req.model, usage: makeUsage() };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'text_delta', index: 0, text: 'ok' };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn', usage: makeUsage() };
      yield { type: 'message_stop' };
    },
  };
  return { provider, requests };
}

async function drain(gen: AsyncGenerator<SDKMessage>, limit = 60): Promise<SDKMessage[]> {
  const msgs: SDKMessage[] = [];
  for await (const m of gen) {
    msgs.push(m);
    if (msgs.length >= limit) break;
  }
  return msgs;
}

function requestText(req: ProviderRequest): string {
  return JSON.stringify(req.messages);
}

describe('queryLoop — skill catalog injection', () => {
  let project: string;
  let home: string;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sdk-skill-ctx-'));
    project = join(root, 'project');
    home = join(root, 'home');
    mkdirSync(join(project, '.claude', 'skills', 'alpha'), { recursive: true });
    writeFileSync(
      join(project, '.claude', 'skills', 'alpha', 'SKILL.md'),
      '---\ndescription: "Alpha does the first thing"\n---\nbody\n',
      'utf8',
    );
    mkdirSync(join(project, '.claude', 'skills'), { recursive: true });
    writeFileSync(
      join(project, '.claude', 'skills', 'beta.md'),
      '---\ndescription: "Beta does the second thing"\n---\nbody\n',
      'utf8',
    );
    mkdirSync(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('first provider request contains the skill catalog when the Skill tool is present', async () => {
    const { provider, requests } = makeRecordingProvider();
    await drain(queryLoop(makeConfig(project, home), provider, [SkillTool], 'hi'));
    expect(requests.length).toBeGreaterThan(0);
    const text = requestText(requests[0]);
    expect(text).toContain('alpha: Alpha does the first thing');
    expect(text).toContain('beta: Beta does the second thing');
    expect(text).toContain('# skills');
  });

  it('no catalog when the Skill tool is not in the tool list', async () => {
    const { provider, requests } = makeRecordingProvider();
    // An explicit tool pool excludes Skill.
    await drain(queryLoop(makeConfig(project, home), provider, [], 'hi'));
    expect(requestText(requests[0])).not.toContain('# skills');
    expect(requestText(requests[0])).not.toContain('Alpha does the first thing');
  });

  it('catalog is not persisted: each turn carries it exactly once and history stays clean', async () => {
    const { provider, requests } = makeRecordingProvider();
    // Two-turn conversation: first response ends the turn, so drive two loops.
    await drain(queryLoop(makeConfig(project, home), provider, [SkillTool], 'hi'));
    await drain(queryLoop(makeConfig(project, home), provider, [SkillTool], 'again'));
    for (const req of requests) {
      const occurrences = requestText(req).split('alpha: Alpha does the first thing').length - 1;
      expect(occurrences).toBe(1);
    }
    // The persisted history passed in by the second call must not contain it —
    // injection is ephemeral, so a caller resuming its own message array is safe.
    const resumed = queryLoop(makeConfig(project, home), provider, [SkillTool], [
      { role: 'user', content: 'resumed' },
    ]);
    await drain(resumed);
    expect(requestText(requests[requests.length - 1])).toContain('# skills');
  });

  it('injects with a custom (string) system prompt — catalog does not ride the system prompt', async () => {
    const { provider, requests } = makeRecordingProvider();
    await drain(
      queryLoop(makeConfig(project, home, { systemPrompt: 'Custom replacement.' }), provider, [SkillTool], 'hi'),
    );
    expect(requests[0].systemPrompt).toBe('Custom replacement.');
    expect(requestText(requests[0])).toContain('alpha: Alpha does the first thing');
  });

  it('cwd skill wins over a same-name home skill (execution order, not registry order)', async () => {
    mkdirSync(join(home, '.claude', 'skills', 'alpha'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'skills', 'alpha', 'SKILL.md'),
      '---\ndescription: "Home shadow copy"\n---\nbody\n',
      'utf8',
    );
    const { provider, requests } = makeRecordingProvider();
    await drain(queryLoop(makeConfig(project, home), provider, [SkillTool], 'hi'));
    const text = requestText(requests[0]);
    expect(text).toContain('alpha: Alpha does the first thing');
    expect(text).not.toContain('Home shadow copy');
  });

  it('advertises bundled workflow metadata without their instructions when disk skills are absent', async () => {
    const emptyProject = join(root, 'empty-project');
    mkdirSync(emptyProject, { recursive: true });
    const { provider, requests } = makeRecordingProvider();
    await drain(queryLoop(makeConfig(emptyProject, home), provider, [SkillTool], 'hi'));
    const text = requestText(requests[0]);
    expect(text).toContain('commit: Prepare');
    expect(text).toContain('pull-request: Prepare');
    expect(text).not.toContain('Start with the requested scope.');
  });
});

describe('buildSkillContextMessage', () => {
  it('returns null when skills are disabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdk-skill-ctx-unit-'));
    try {
      expect(
        buildSkillContextMessage({ cwd: root, env: { HOME: root, CLAUDE_CONFIG_DIR: undefined } }, false),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

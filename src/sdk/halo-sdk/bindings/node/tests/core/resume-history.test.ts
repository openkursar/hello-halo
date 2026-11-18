import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession } from '../../index.js';
import { RESUME_HISTORY_UNAVAILABLE } from '../../utils/errors.js';
import type { LlmProvider } from '../../contracts/llm/provider.js';

let configDir: string;
let cwd: string;
beforeEach(async () => {
  configDir = await fs.mkdtemp(join(tmpdir(), 'sdk-resume-config-'));
  cwd = join(configDir, 'work');
});
afterEach(async () => { await fs.rm(configDir, { recursive: true, force: true }); });

const options = () => ({ env: { CLAUDE_CONFIG_DIR: configDir, HOME: configDir, USERPROFILE: configDir }, settingSources: [] });

describe('strict resume', () => {
  it('makes session creation reject so the host can continue from its own record', async () => {
    const provider = { id: 'unused', name: 'Unused', capabilities: () => ({}) } as unknown as LlmProvider;
    const creation = createSession({
      ...options(), provider, model: 'test-model', cwd,
      systemPrompt: 'test', resume: randomUUID(), strictResume: true,
    });
    await expect(creation).rejects.toMatchObject({ code: RESUME_HISTORY_UNAVAILABLE, reason: 'missing' });
  });
});

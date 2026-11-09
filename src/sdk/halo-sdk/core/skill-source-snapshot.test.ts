import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { query } from '../index.js';
import { createSession } from './session.js';
import { queryLoop } from './query-loop.js';
import { resolveQueryConfig } from './context.js';
import { SkillTool } from '../tools/skill/index.js';
import type { Options } from '../types/config.js';
import type { LlmProvider, ProviderRequest, StreamEvent } from '../types/provider.js';
import type { Tool, ToolContext, ToolResult } from '../types/tool.js';

let root: string;
let skillFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sdk-skill-snapshot-'));
  skillFile = join(root, '.agents', 'skills', 'commit.md');
  await mkdir(join(root, '.agents', 'skills'), { recursive: true });
  await writeFile(skillFile, '---\ndescription: Project approval procedure\n---\nPROJECT_COMMIT_BODY');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function setup(beforeStep?: (step: number) => Promise<void>, invoke = true) {
  let step = 0;
  const requests: ProviderRequest[] = [];
  const loads: Array<{ context: ToolContext; result: ToolResult }> = [];
  const provider = {
    id: 'snapshot-fixture', name: 'Snapshot fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, caching: false, imageInput: false, pdfInput: false, thinking: false, systemPromptStyle: 'system_message' }),
    async *createMessageStream(request: ProviderRequest): AsyncGenerator<StreamEvent> {
      requests.push(request);
      const index = step++;
      await beforeStep?.(index);
      yield { type: 'message_start', id: `message-${index}`, model: 'test', usage: { input_tokens: 100, output_tokens: 0 } };
      if (invoke && index % 2 === 0) {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `load-${index}`, name: 'Skill', input: {} } };
        yield { type: 'input_json_delta', index: 0, partialJson: '{"skill":"commit"}' };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', stopReason: 'tool_use', usage: { output_tokens: 10 } };
      } else {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
        yield { type: 'text_delta', index: 0, text: 'Finished.' };
        yield { type: 'content_block_stop', index: 0 };
        yield { type: 'message_delta', stopReason: 'end_turn', usage: { output_tokens: 10 } };
      }
      yield { type: 'message_stop' };
    },
  } as unknown as LlmProvider;
  const wrapped: Tool = {
    ...SkillTool,
    async execute(input, context) {
      const result = await SkillTool.execute(input, context);
      loads.push({ context, result });
      return result;
    },
  };
  const options: Options = {
    cwd: root, env: { HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'state') },
    conventions: { agentDirs: ['.agents'], memoryFiles: [], memorySubdirs: [] },
    model: 'test', provider, tools: ['Skill'], customTools: [wrapped], persistSession: false,
    maxTurns: 3, turnEndChecks: { openWork: false, completion: false },
  };
  return { options, provider, wrapped, requests, loads };
}

async function drain(stream: AsyncIterable<unknown>) {
  for await (const event of stream) {
    if (event && typeof event === 'object' && 'type' in event && event.type === 'result') break;
  }
}

describe.each(['query', 'session'] as const)('explicit skill catalogs through %s', entryPoint => {
  async function run(options: Options, prompt = 'Load commit.') {
    if (entryPoint === 'query') {
      await drain(query({ prompt, options }));
      return;
    }
    const session = await createSession(options);
    try {
      await session.send(prompt);
      await drain(session.stream());
    } finally { session.close(); await session.flush(); }
  }

  async function foreignCatalog() {
    const path = join(root, 'foreign.md');
    await writeFile(path, 'FOREIGN_COMMIT_BODY');
    return [{ name: 'commit', description: 'Explicit foreign workflow',
      source: { kind: 'file' as const, path } }];
  }

  it('uses the explicit foreign source instead of discovering a local same-name skill', async () => {
    const fixture = setup();
    const skillCatalog = await foreignCatalog();
    await run({ ...fixture.options, skillCatalog });
    expect(JSON.stringify(fixture.requests[0].messages)).toContain('Explicit foreign workflow');
    expect(JSON.stringify(fixture.requests[0].messages)).not.toContain('Project approval procedure');
    expect(fixture.loads).toHaveLength(1);
    expect(fixture.loads[0].result.content).toBe('FOREIGN_COMMIT_BODY');
    expect(fixture.loads[0].context.skillCatalog).toEqual(skillCatalog);
  });

  it('keeps an empty catalog empty in the prompt and tool rather than recovering disk or bundled skills', async () => {
    const fixture = setup();
    await run({ ...fixture.options, skillCatalog: [] });
    expect(JSON.stringify(fixture.requests[0].messages)).not.toContain('# skills');
    expect(JSON.stringify(fixture.requests[0].messages)).not.toContain('Project approval procedure');
    expect(fixture.loads).toHaveLength(1);
    expect(fixture.loads[0].context.skillCatalog).toEqual([]);
    expect(fixture.loads[0].result.isError).toBe(true);
    expect(fixture.loads[0].result.content).not.toContain('PROJECT_COMMIT_BODY');
    expect(fixture.loads[0].result.content).not.toContain('Prepare a repository commit');
  });

  it('does not recover generated slash commands from an empty catalog', async () => {
    const fixture = setup(undefined, false);
    await run({ ...fixture.options, skillCatalog: [] }, '/commit');
    const requests = JSON.stringify(fixture.requests.map(request => request.messages));
    expect(requests).not.toContain('PROJECT_COMMIT_BODY');
    expect(requests).not.toContain('Start with the requested scope.');
    expect(requests).not.toContain('<skill-instructions');
  });

  it('expands the explicit source through slash commands without loading a namesake', async () => {
    const fixture = setup(undefined, false);
    await run({ ...fixture.options, skillCatalog: await foreignCatalog() }, '/commit');
    const requests = JSON.stringify(fixture.requests.map(request => request.messages));
    expect(requests).toContain('FOREIGN_COMMIT_BODY');
    expect(requests).toContain('<skill-instructions');
    expect(requests).not.toContain('PROJECT_COMMIT_BODY');
  });

  it('reads the live body at the explicit source', async () => {
    const skillCatalog = await foreignCatalog();
    const fixture = setup(async step => {
      if (step === 0) await writeFile(skillCatalog[0].source.path, 'UPDATED_FOREIGN_BODY');
    });
    await run({ ...fixture.options, skillCatalog });
    expect(fixture.loads[0].result.content).toBe('UPDATED_FOREIGN_BODY');
  });

  it('fails when the explicit source disappears without falling back to local or bundled instructions', async () => {
    const skillCatalog = await foreignCatalog();
    const fixture = setup(async step => {
      if (step === 0) await rm(skillCatalog[0].source.path);
    });
    await run({ ...fixture.options, skillCatalog });
    expect(fixture.loads[0].result.isError).toBe(true);
    expect(fixture.loads[0].result.content).not.toContain('PROJECT_COMMIT_BODY');
    expect(fixture.loads[0].result.content).not.toContain('Start with the requested scope.');
  });

  it('isolates the catalog and nested source from later caller mutation', async () => {
    const skillCatalog = await foreignCatalog();
    const original = structuredClone(skillCatalog);
    const fixture = setup(async step => {
      if (step !== 0) return;
      skillCatalog[0].description = 'Mutated metadata';
      skillCatalog[0].source.path = skillFile;
      skillCatalog.push({ name: 'injected', description: 'Injected workflow', source: { kind: 'file', path: skillFile } });
    });
    await run({ ...fixture.options, skillCatalog });
    expect(fixture.loads[0].result.content).toBe('FOREIGN_COMMIT_BODY');
    expect(fixture.loads[0].context.skillCatalog).toEqual(original);
    expect(JSON.stringify(fixture.requests)).not.toContain('Mutated metadata');
    expect(JSON.stringify(fixture.requests)).not.toContain('Injected workflow');
  });
});

describe('advertised skill source snapshots', () => {
  it('fails closed when a project skill disappears between query catalog and invocation', async () => {
    const fixture = setup(async step => { if (step === 0) await rm(skillFile); });
    await drain(query({ prompt: 'Use the project commit workflow.', options: fixture.options }));
    expect(JSON.stringify(fixture.requests[0].messages)).toContain('Project approval procedure');
    expect(fixture.loads).toHaveLength(1);
    expect(fixture.loads[0].result.isError).toBe(true);
    expect(fixture.loads[0].result.content).not.toContain('Prepare a repository commit');
    expect(fixture.loads[0].context.skillCatalog?.find(entry => entry.name === 'commit')?.source.kind).toBe('file');
  });

  it('shares the same source snapshot across turns without replacing a host Skill wrapper', async () => {
    const fixture = setup();
    const session = await createSession(fixture.options);
    try {
      await session.send('Load the project workflow.');
      await drain(session.stream());
      await rm(skillFile);
      await session.send('Load it again.');
      await drain(session.stream());
      expect(fixture.loads).toHaveLength(2);
      expect(fixture.loads[0].result.content).toBe('PROJECT_COMMIT_BODY');
      expect(fixture.loads[1].result.isError).toBe(true);
      expect(fixture.loads[1].context.skillCatalog).toBe(fixture.loads[0].context.skillCatalog);
    } finally { session.close(); await session.flush(); }
  });

  it('reads updated instructions at the pinned path instead of caching their body', async () => {
    const fixture = setup(async step => { if (step === 0) await writeFile(skillFile, 'UPDATED_PROJECT_COMMIT_BODY'); });
    await drain(query({ prompt: 'Load the project workflow.', options: fixture.options }));
    expect(fixture.loads[0].result.content).toBe('UPDATED_PROJECT_COMMIT_BODY');
    expect(JSON.stringify(fixture.loads[0].context.skillCatalog)).not.toContain('UPDATED_PROJECT_COMMIT_BODY');
  });

  it('also pins the catalog for a direct queryLoop caller', async () => {
    const fixture = setup(async step => { if (step === 0) await rm(skillFile); });
    await drain(queryLoop(resolveQueryConfig(fixture.options), fixture.provider, [fixture.wrapped], 'Load commit.'));
    expect(fixture.loads[0].result.isError).toBe(true);
    expect(fixture.loads[0].context.skillCatalog?.find(entry => entry.name === 'commit')?.source.kind).toBe('file');
  });

  it('does not discover or inject skills when the wrapped tool is disabled', async () => {
    const fixture = setup(undefined, false);
    await drain(query({ prompt: 'Say hello.', options: { ...fixture.options, disallowedTools: ['Skill'] } }));
    expect(JSON.stringify(fixture.requests[0].messages)).not.toContain('Project approval procedure');
    expect(JSON.stringify(fixture.requests[0].messages)).not.toContain('# skills');
    expect(fixture.loads).toHaveLength(0);
  });
});

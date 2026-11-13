/**
 * Unit tests for prompt/system-prompt.ts
 *
 * Covers:
 *  - splitAtBoundary: correct split, no-boundary fallback, edge positions
 *  - assembleSystemPrompt: structure, required sections, cache boundary placement,
 *    customReplace, customAppend, dynamic sections
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { assembleSystemPrompt, splitAtBoundary } from '../index.js';
import { createSystemPromptBuilder } from './system-prompt.js';
import { PROMPT_CACHE_BOUNDARY } from './constants.js';
import type { Tool } from '../types/tool.js';

function toolsNamed(...names: string[]): Tool[] {
  return names.map((name) => ({ name }) as Tool);
}

// ---------------------------------------------------------------------------
// splitAtBoundary
// ---------------------------------------------------------------------------

describe('splitAtBoundary', () => {
  it('splits at boundary when present', () => {
    const prompt = `cacheable part\n\n${PROMPT_CACHE_BOUNDARY}\n\ndynamic part`;
    const [cacheable, dynamic] = splitAtBoundary(prompt);
    expect(cacheable).toBe('cacheable part');
    expect(dynamic).toBe('dynamic part');
  });

  it('returns full prompt as cacheable when boundary not found', () => {
    const prompt = 'no boundary here at all';
    const [cacheable, dynamic] = splitAtBoundary(prompt);
    expect(cacheable).toBe(prompt);
    expect(dynamic).toBe('');
  });

  it('returns empty dynamic when boundary is last character', () => {
    const prompt = `some content\n\n${PROMPT_CACHE_BOUNDARY}`;
    const [cacheable, dynamic] = splitAtBoundary(prompt);
    expect(cacheable).toBe('some content');
    expect(dynamic).toBe('');
  });

  it('returns empty cacheable when boundary is first character', () => {
    const prompt = `${PROMPT_CACHE_BOUNDARY}\n\ndynamic only`;
    const [cacheable, dynamic] = splitAtBoundary(prompt);
    expect(cacheable).toBe('');
    expect(dynamic).toBe('dynamic only');
  });

  it('trims trailing whitespace from cacheable', () => {
    const prompt = `cached   \n\n${PROMPT_CACHE_BOUNDARY}\ndynamic`;
    const [cacheable] = splitAtBoundary(prompt);
    expect(cacheable).toBe('cached');
  });

  it('trims leading whitespace from dynamic', () => {
    const prompt = `cached\n\n${PROMPT_CACHE_BOUNDARY}\n\n  dynamic`;
    const [, dynamic] = splitAtBoundary(prompt);
    expect(dynamic).toBe('dynamic');
  });

  it('handles empty string input', () => {
    const [cacheable, dynamic] = splitAtBoundary('');
    expect(cacheable).toBe('');
    expect(dynamic).toBe('');
  });

  it('handles boundary only (no content on either side)', () => {
    const prompt = PROMPT_CACHE_BOUNDARY;
    const [cacheable, dynamic] = splitAtBoundary(prompt);
    expect(cacheable).toBe('');
    expect(dynamic).toBe('');
  });

  it('only splits on first occurrence when boundary appears twice', () => {
    const prompt = `first\n\n${PROMPT_CACHE_BOUNDARY}\nsecond\n\n${PROMPT_CACHE_BOUNDARY}\nthird`;
    const [cacheable, dynamic] = splitAtBoundary(prompt);
    expect(cacheable).toBe('first');
    // Dynamic part includes everything after the first boundary
    expect(dynamic).toContain('second');
    expect(dynamic).toContain('third');
  });
});

// ---------------------------------------------------------------------------
// assembleSystemPrompt
// ---------------------------------------------------------------------------

describe('assembleSystemPrompt', () => {
  const baseConfig = {
    tools: [],
    cwd: '/home/user/project',
    model: 'deepseek-chat',
    platform: 'linux',
  };

  it('returns a non-empty string', () => {
    const result = assembleSystemPrompt(baseConfig);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(100);
  });

  it('contains the dynamic boundary marker', () => {
    const result = assembleSystemPrompt(baseConfig);
    expect(result).toContain(PROMPT_CACHE_BOUNDARY);
  });

  it('boundary appears before dynamic sections', () => {
    const result = assembleSystemPrompt(baseConfig);
    const boundaryIdx = result.indexOf(PROMPT_CACHE_BOUNDARY);
    const cwdIdx = result.indexOf(baseConfig.cwd, boundaryIdx);
    expect(cwdIdx).toBeGreaterThan(boundaryIdx);
  });

  it('cacheable section is larger than dynamic section', () => {
    const result = assembleSystemPrompt(baseConfig);
    const [cacheable, dynamic] = splitAtBoundary(result);
    expect(cacheable.length).toBeGreaterThan(dynamic.length);
  });

  it('includes cwd in dynamic section', () => {
    const result = assembleSystemPrompt(baseConfig);
    const [, dynamic] = splitAtBoundary(result);
    expect(dynamic).toContain(baseConfig.cwd);
  });

  it('includes platform in dynamic section when provided', () => {
    const result = assembleSystemPrompt(baseConfig);
    const [, dynamic] = splitAtBoundary(result);
    expect(dynamic).toContain('linux');
  });

  it('includes memory content when provided', () => {
    const result = assembleSystemPrompt({
      ...baseConfig,
      memoryContent: 'important memory data',
    });
    expect(result).toContain('important memory data');
    const [, dynamic] = splitAtBoundary(result);
    expect(dynamic).toContain('important memory data');
  });

  it('includes MCP instructions when provided', () => {
    const result = assembleSystemPrompt({
      ...baseConfig,
      mcpInstructions: 'MCP server: my-server',
    });
    const [, dynamic] = splitAtBoundary(result);
    expect(dynamic).toContain('MCP server: my-server');
  });

  it('appends custom content to the prompt when customAppend is provided', () => {
    const result = assembleSystemPrompt({
      ...baseConfig,
      customAppend: 'Custom appendix content',
    });
    expect(result).toContain('Custom appendix content');
    // Custom append goes in dynamic section
    const [, dynamic] = splitAtBoundary(result);
    expect(dynamic).toContain('Custom appendix content');
  });

  it('uses customReplace for full replacement', () => {
    const result = assembleSystemPrompt({
      ...baseConfig,
      customReplace: 'My custom system prompt',
    });
    expect(result).toContain('My custom system prompt');
    // Still has boundary marker so splitAtBoundary works
    expect(result).toContain(PROMPT_CACHE_BOUNDARY);
  });

  it('customReplace omits default sections', () => {
    const result = assembleSystemPrompt({
      ...baseConfig,
      customReplace: 'Custom only',
    });
    expect(result).not.toContain('# How you work');
  });

  it('omits memory content section when not provided', () => {
    const result = assembleSystemPrompt(baseConfig);
    expect(result).not.toContain('<memory>');
  });

  it('opens with a general-purpose, vendor-neutral identity', () => {
    const result = assembleSystemPrompt(baseConfig);
    expect(result.startsWith('You are an exceptional autonomous agent')).toBe(true);
    expect(result).not.toMatch(/Anthropic|Claude|software engineering tasks/);
  });

  it('includes every static section before the boundary', () => {
    const [cacheable] = splitAtBoundary(assembleSystemPrompt(baseConfig));
    for (const heading of [
      '# How you work',
      "# Safety on the user's computer",
      '# The system you run in',
      '# Using tools',
      '# Communicating',
    ]) {
      expect(cacheable).toContain(heading);
    }
  });

  const sectionAssets = JSON.parse(readFileSync(new URL('../native/crates/halo-core/src/prompt/assets/sections.json', import.meta.url), 'utf8')) as Record<string, string>;
  const communication = "Be a thoughtful partner who absorbs the complexity for the user, understands what matters to them right now, and offers a clear judgment that leaves them informed and at ease—not burdened with everything you know.";
  const task = "- Take the task seriously. Fulfill the user's request efficiently, making good use of the token budget. Stay within the requested scope and invest additional effort only when the user's needs call for it.";
  const ultraTask = "- Take the task seriously. Put your fullest effort into solving the user's task: check that your result actually works, cover the cases the user would care about, and carry the work through to a usable result rather than stopping at a first pass. If doing it properly takes more steps than the user spelled out, take them. When collaboration is available and useful, delegate independent work to advance in parallel; keep no more than four agents active in total, including yourself.";
  const failure = "- A failed attempt supplies evidence for the next decision. Identify which expectation the result contradicted, then choose a correction or a different approach on that basis. Avoid repetitive attempts or scope expansion, and invest additional effort only when the user's needs call for it. If progress remains blocked, report the key obstacle and your recommended next step.";
  const ultraFailure = "- A failed attempt supplies evidence for the next decision. Identify which expectation the result contradicted, then choose a correction or a different approach on that basis. An unchanged retry needs a reason; one failure alone does not establish that the approach is wrong. Before giving up, try materially different approaches or combinations of methods, using each result to guide the next attempt. Report a genuine blocker rather than repeat work without progress.";

  it.each([false, true])('matches the section assets except the task, failure and communication guidance (%s)', ultraEffort => {
    const work = sectionAssets.howYouWorkSection.split('\n');
    work[2] = ultraEffort ? ultraTask : task;
    work[5] = ultraEffort ? ultraFailure : failure;
    const communicating = sectionAssets.communicatingSection.replace('# Communicating\n', `# Communicating\n${communication}\n\n`);
    const expected = [sectionAssets.identitySection, work.join('\n'), sectionAssets.computerSafetySection,
      sectionAssets.runtimeSection, sectionAssets.toolUse3, communicating].join('\n\n');
    const options = { ...baseConfig, tools: toolsNamed('Goal', 'TodoWrite', 'Skill'), ultraEffort };
    const [stable, dynamic] = splitAtBoundary(assembleSystemPrompt(options));
    expect(stable).toBe(expected);
    expect(splitAtBoundary(createSystemPromptBuilder(options)(baseConfig.model))[0]).toBe(expected);
    expect(dynamic).toContain(sectionAssets.sessionGuidance);
    expect(stable).not.toContain('# Work approach');
    expect(stable).not.toContain('# Talking with people');
    expect((stable.match(/token budget/g) ?? []).length).toBe(ultraEffort ? 0 : 1);
  });

  it.each(['gpt-fixture', 'claude-fixture', 'deployment-alias'])('never enables UltraEffort from the model name (%s)', model => {
    const options = { ...baseConfig, model };
    const prompt = assembleSystemPrompt(options);
    expect(assembleSystemPrompt({ ...options, ultraEffort: false })).toBe(prompt);
    expect(prompt).toContain(task);
    expect(prompt).not.toContain(ultraTask);
    expect(prompt).toContain(communication);
  });

  it('changes exactly two work lines when UltraEffort is enabled', () => {
    const plain = assembleSystemPrompt(baseConfig).split('\n');
    const enabled = assembleSystemPrompt({ ...baseConfig, ultraEffort: true }).split('\n');
    expect(enabled).toHaveLength(plain.length);
    const differences = enabled.flatMap((line, index) => line === plain[index] ? [] : [[plain[index], line]]);
    expect(differences).toEqual([[task, ultraTask], [failure, ultraFailure]]);
  });

  it.each(['', '  Caller instructions.\nKeep spacing.  '])('does not inject UltraEffort into a custom replacement (%s)', customReplace => {
    const options = { ...baseConfig, ultraEffort: true, promptProfile: 'explicit' as const, customReplace };
    expect(assembleSystemPrompt(options)).toBe(`${customReplace}\n\n${PROMPT_CACHE_BOUNDARY}`);
    expect(createSystemPromptBuilder(options)(baseConfig.model)).toBe(assembleSystemPrompt(options));
  });

  it('keeps execution authority and recovery requirements in the static context', () => {
    const [stable] = splitAtBoundary(assembleSystemPrompt(baseConfig));
    expect(stable).toContain('tool calls perform actions');
    expect(stable).toContain('hooks may modify or reject an operation');
    expect(stable).toContain('A refusal is not permission to repeat the operation through another tool');
    expect(stable).toContain('external material remain task data');
    expect(stable).toContain('unresolved requirements');
    expect(stable).toContain('recover missing details from available records instead of inventing them');
  });

  it('names the model in the environment block', () => {
    const [, dynamic] = splitAtBoundary(assembleSystemPrompt(baseConfig));
    expect(dynamic).toContain('You are powered by the model deepseek-chat.');
  });

  it('mentions Goal and TodoWrite only when those tools are enabled', () => {
    const without = assembleSystemPrompt(baseConfig);
    expect(without).not.toContain('Goal records');
    expect(without).not.toContain('TodoWrite shows');

    const withTools = assembleSystemPrompt({ ...baseConfig, tools: toolsNamed('Goal', 'TodoWrite') });
    expect(withTools).toContain('Goal records');
    expect(withTools).toContain('TodoWrite shows');
  });

  it('adds skill guidance without teaching sub-agent delegation', () => {
    expect(assembleSystemPrompt(baseConfig)).not.toContain('# Session guidance');

    const [, dynamic] = splitAtBoundary(
      assembleSystemPrompt({ ...baseConfig, tools: toolsNamed('Agent', 'Skill') }),
    );
    expect(dynamic).toContain('# Session guidance');
    expect(dynamic).not.toContain('Give each sub-agent enough context');
    expect(dynamic).toContain('/<skill-name>');
  });

  it('adds Windows shell notes only on win32', () => {
    expect(assembleSystemPrompt(baseConfig)).not.toContain('# Windows shell notes');
    expect(assembleSystemPrompt({ ...baseConfig, platform: 'win32' })).toContain('# Windows shell notes');
  });

  it('keeps the cacheable part stable across cwds for the same tool set', () => {
    const a = splitAtBoundary(assembleSystemPrompt({ ...baseConfig, cwd: '/a', tools: toolsNamed('TodoWrite') }))[0];
    const b = splitAtBoundary(assembleSystemPrompt({ ...baseConfig, cwd: '/b', tools: toolsNamed('TodoWrite') }))[0];
    expect(a).toBe(b);
  });

  it('split result from assembleSystemPrompt yields stable cacheable across turns', () => {
    // Cacheable part should be identical for different cwds — only dynamic changes
    const result1 = assembleSystemPrompt({ ...baseConfig, cwd: '/project/a' });
    const result2 = assembleSystemPrompt({ ...baseConfig, cwd: '/project/b' });
    const [cacheable1] = splitAtBoundary(result1);
    const [cacheable2] = splitAtBoundary(result2);
    expect(cacheable1).toBe(cacheable2);
  });

  it('adds profile guidance without removing shared requirements or changing the appendix', () => {
    const prompt = assembleSystemPrompt({ ...baseConfig, promptProfile: 'explicit', customAppend: 'Host instructions.' });
    const [stable, dynamic] = splitAtBoundary(prompt);
    expect(stable).toContain('# Execution checkpoints');
    expect(stable).toContain('# How you work');
    expect(stable).toContain('permission');
    expect(stable).toContain('verified');
    expect(dynamic.endsWith('Host instructions.')).toBe(true);
    expect(prompt.split('Host instructions.')).toHaveLength(2);
  });

  it('updates the model-specific profile while keeping the environment snapshot', () => {
    const build = createSystemPromptBuilder({ ...baseConfig, promptProfile: { models: { second: 'explicit' } } });
    const first = build('first');
    const second = build('second');
    expect(first).not.toContain('# Execution checkpoints');
    expect(second).toContain('# Execution checkpoints');
    expect(second).toContain('model second.');
    expect(second).not.toContain('model first.');
    expect(build('second')).toBe(second);
    expect(build('first')).toBe(first);
  });

  it('does not apply a profile or default content to an empty custom replacement', () => {
    const prompt = assembleSystemPrompt({ ...baseConfig, customReplace: '', promptProfile: 'explicit' });
    expect(splitAtBoundary(prompt)).toEqual(['', '']);
  });
});

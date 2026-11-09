/**
 * Unit tests for AskUserQuestionTool — duplicate label/question validation.
 */

import { describe, it, expect } from 'vitest';
import { AskUserQuestionTool } from './index.js';
import type { ToolContext } from '../../types/tool.js';
import { CostTracker } from '../../core/cost.js';

function makeCtx(): ToolContext {
  return {
    sessionId: 'test',
    cwd: '/tmp',
    abortSignal: new AbortController().signal,
    costTracker: new CostTracker('test-model'),
    currentTurn: 0,
    env: {},
  };
}

function makeOption(label: string) {
  return { label, description: `Description for ${label}` };
}

describe('AskUserQuestionTool — input validation', () => {
  it('rejects missing questions parameter', async () => {
    const result = await AskUserQuestionTool.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/questions/i);
  });

  it('rejects questions without a question string', async () => {
    const result = await AskUserQuestionTool.execute(
      { questions: [{ options: [makeOption('A'), makeOption('B')] }] },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
  });

  it('rejects questions with fewer than 2 options', async () => {
    const result = await AskUserQuestionTool.execute(
      { questions: [{ question: 'Q?', header: 'Q', options: [makeOption('A')] }] },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/at least 2 options/i);
  });
});

describe('AskUserQuestionTool — duplicate validation', () => {
  it('rejects duplicate question texts', async () => {
    const result = await AskUserQuestionTool.execute(
      {
        questions: [
          { question: 'Same question?', header: 'Q1', options: [makeOption('A'), makeOption('B')] },
          { question: 'Same question?', header: 'Q2', options: [makeOption('C'), makeOption('D')] },
        ],
      },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('distinct question text');
    expect(result.content).toContain('distinct option labels');
  });

  it('rejects duplicate option labels within the same question', async () => {
    const result = await AskUserQuestionTool.execute(
      {
        questions: [
          { question: 'Pick one?', header: 'Q', options: [makeOption('Dup'), makeOption('Dup')] },
        ],
      },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('distinct question text');
    expect(result.content).toContain('distinct option labels');
  });

  it('allows same label in different questions (unique within each)', async () => {
    const result = await AskUserQuestionTool.execute(
      {
        questions: [
          { question: 'First?', header: 'Q1', options: [makeOption('Same'), makeOption('Other')] },
          { question: 'Second?', header: 'Q2', options: [makeOption('Same'), makeOption('Other')] },
        ],
      },
      makeCtx(),
    );
    // Should pass validation (no error from uniqueness check)
    expect(result.isError).toBe(false);
  });

  it('accepts valid distinct questions and options', async () => {
    const result = await AskUserQuestionTool.execute(
      {
        questions: [
          { question: 'Q1?', header: 'H1', options: [makeOption('A'), makeOption('B')] },
          { question: 'Q2?', header: 'H2', options: [makeOption('C'), makeOption('D')] },
        ],
      },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
  });
});

describe('AskUserQuestionTool — answers formatting', () => {
  it('formats answers when provided', async () => {
    const result = await AskUserQuestionTool.execute(
      {
        questions: [
          { question: 'Which DB?', header: 'DB', options: [makeOption('Postgres'), makeOption('MySQL')] },
        ],
        answers: { 'Which DB?': 'Postgres' },
      },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Postgres');
    expect(result.content).toContain('Which DB?');
  });

  it('includes annotation notes when present', async () => {
    const result = await AskUserQuestionTool.execute(
      {
        questions: [
          { question: 'Pick one?', header: 'Q', options: [makeOption('A'), makeOption('B')] },
        ],
        answers: { 'Pick one?': 'A' },
        annotations: { 'Pick one?': { notes: 'User feedback here' } },
      },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('User feedback here');
  });

  it('keeps multiple decisions, previews, and host metadata intact', async () => {
    const questions = [
      { question: 'Which database?', header: 'Database', options: [makeOption('Local'), makeOption('Remote')] },
      { question: 'Which layout?', header: 'Layout', options: [makeOption('Compact'), makeOption('Expanded')] },
    ];
    const answers = { 'Which database?': 'Local', 'Which layout?': 'Compact, with "details"' };
    const annotations = {
      'Which database?': { notes: 'Keep data on this device.' },
      'Which layout?': { preview: '<section>\nCompact layout\n</section>', notes: '保留说明。' },
    };
    const result = await AskUserQuestionTool.execute({ questions, answers, annotations }, makeCtx());

    expect(result.isError).toBe(false);
    for (const value of [...Object.keys(answers), ...Object.values(answers)]) {
      expect(result.content).toContain(value);
    }
    expect(result.content).toContain(annotations['Which layout?'].preview);
    expect(result.content).toContain(annotations['Which layout?'].notes);
    expect(result.metadata).toEqual({ questions, answers, annotations, type: 'ask_user' });
  });
});

/**
 * Unit tests for AskUserQuestionTool.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AskUserQuestionTool } from './ask-user/index.js';
import type { ToolContext } from '../types/tool.js';

// ---------------------------------------------------------------------------
// Shared context factory
// ---------------------------------------------------------------------------

function makeCtx(sessionId = 'sess-A'): ToolContext {
  return {
    cwd: '/tmp',
    sessionId,
    abortSignal: new AbortController().signal,
    onToolMessage: undefined,
    recordFileChange: undefined,
  };
}

// ---------------------------------------------------------------------------
// AskUserQuestionTool
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AskUserQuestionTool helpers
// ---------------------------------------------------------------------------

const makeQuestion = (
  question = 'Which approach?',
  opts: Array<{ label: string; description: string }> = [
    { label: 'A', description: 'Option A' },
    { label: 'B', description: 'Option B' },
  ],
) => ({
  question,
  header: 'Approach',
  options: opts,
  multiSelect: false,
});

describe('AskUserQuestionTool', () => {
  it('has name "AskUserQuestion"', () => {
    expect(AskUserQuestionTool.name).toBe('AskUserQuestion');
  });

  it('has permissionLevel "none"', () => {
    expect(AskUserQuestionTool.permissionLevel).toBe('none');
  });

  it('returns error when questions is missing', async () => {
    const result = await AskUserQuestionTool.execute({}, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/questions/i);
  });

  it('returns error when questions is empty array', async () => {
    const result = await AskUserQuestionTool.execute({ questions: [] }, makeCtx());
    expect(result.isError).toBe(true);
  });

  it('returns error when a question is missing options', async () => {
    const result = await AskUserQuestionTool.execute(
      { questions: [{ question: 'Pick?', header: 'Pick', options: [{ label: 'A', description: 'A' }] }] },
      makeCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/at least 2 options/i);
  });

  it('returns waiting placeholder when no answers provided', async () => {
    const result = await AskUserQuestionTool.execute(
      { questions: [makeQuestion('Are you sure?')] },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Are you sure?');
    expect((result.metadata as any).type).toBe('ask_user');
    expect(Array.isArray((result.metadata as any).questions)).toBe(true);
  });

  it('metadata.questions contains the question array', async () => {
    const result = await AskUserQuestionTool.execute(
      { questions: [makeQuestion('Pick one?')] },
      makeCtx(),
    );
    expect((result.metadata as any).questions).toHaveLength(1);
    expect((result.metadata as any).questions[0].question).toBe('Pick one?');
  });

  it('returns structured answer format when answers are provided', async () => {
    const result = await AskUserQuestionTool.execute(
      {
        questions: [makeQuestion('Which library?')],
        answers: { 'Which library?': 'React' },
      },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Which library?');
    expect(result.content).toContain('React');
    expect(result.metadata).toMatchObject({ type: 'ask_user', answers: { 'Which library?': 'React' } });
  });

  it('metadata includes answers when provided', async () => {
    const result = await AskUserQuestionTool.execute(
      {
        questions: [makeQuestion('Dark mode?')],
        answers: { 'Dark mode?': 'Yes' },
      },
      makeCtx(),
    );
    expect((result.metadata as any).answers).toEqual({ 'Dark mode?': 'Yes' });
    expect((result.metadata as any).type).toBe('ask_user');
  });

  it('preserves the association between multiple questions and answers', async () => {
    const q1 = makeQuestion('Framework?');
    const q2 = makeQuestion('Style?');
    const result = await AskUserQuestionTool.execute(
      {
        questions: [q1, q2],
        answers: { 'Framework?': 'Vue', 'Style?': 'Tailwind' },
      },
      makeCtx(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/Framework\?[\s\S]*Vue[\s\S]*Style\?[\s\S]*Tailwind/);
    expect(result.metadata).toMatchObject({ answers: { 'Framework?': 'Vue', 'Style?': 'Tailwind' } });
  });

  it('includes annotation preview in answer text', async () => {
    const result = await AskUserQuestionTool.execute(
      {
        questions: [makeQuestion('Layout?')],
        answers: { 'Layout?': 'Sidebar' },
        annotations: { 'Layout?': { preview: '<sidebar layout mockup>' } },
      },
      makeCtx(),
    );
    expect(result.content).toContain('<sidebar layout mockup>');
    expect(result.metadata).toMatchObject({ annotations: { 'Layout?': { preview: '<sidebar layout mockup>' } } });
  });

  it('includes annotation notes in answer text', async () => {
    const result = await AskUserQuestionTool.execute(
      {
        questions: [makeQuestion('Theme?')],
        answers: { 'Theme?': 'Dark' },
        annotations: { 'Theme?': { notes: 'prefer dark in the evening' } },
      },
      makeCtx(),
    );
    expect(result.content).toContain('prefer dark in the evening');
    expect(result.metadata).toMatchObject({ annotations: { 'Theme?': { notes: 'prefer dark in the evening' } } });
  });
});

describe('AskUserQuestionTool — description', () => {
  it('reserves the tool for decisions and sends discussion to prose', () => {
    const d = AskUserQuestionTool.description;
    expect(d).toContain('discrete decision');
    expect(d).toContain("Don't use it for discussion");
    expect(d).not.toMatch(/plan mode|ExitPlanMode/i);
  });
});

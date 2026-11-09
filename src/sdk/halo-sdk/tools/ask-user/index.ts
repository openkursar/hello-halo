/**
 * @module tools/ask-user
 * AskUserQuestionTool — present multiple-choice questions to the user.
 *
 * The question UI is handled at the host application layer via the
 * canUseTool() permission callback. When the user responds, the host
 * injects the answers into the tool input via PermissionResult.updatedInput.
 * This tool then formats the answers into an LLM-readable result.
 * @license MIT
 */

import type { Tool, ToolContext, ToolResult } from '../../types/tool.js';
import { toolSuccess, toolError } from '../../types/tool.js';
import {
  ASK_USER_TOOL_NAME,
  ASK_USER_TOOL_DESCRIPTION,
  ASK_USER_TOOL_INPUT_SCHEMA,
} from './schema.js';

/** Single option within a question. */
interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

/** One question in the questions array. */
interface AskQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/** Annotation attached to a user's answer. */
interface Annotation {
  preview?: string;
  notes?: string;
}

export const AskUserQuestionTool: Tool = {
  name: ASK_USER_TOOL_NAME,
  description: ASK_USER_TOOL_DESCRIPTION,
  inputSchema: ASK_USER_TOOL_INPUT_SCHEMA as unknown as Record<string, unknown>,
  permissionLevel: 'none',
  // Force the host's canUseTool callback to fire even under bypassPermissions —
  // that callback is the host's only opportunity to render the question UI,
  // collect answers, and inject them via PermissionResult.updatedInput.
  requiresUserInteraction: true,

  async execute(
    input: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<ToolResult> {
    const questions = input.questions as AskQuestion[] | undefined;

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return toolError('Missing required parameter: questions (must be a non-empty array)');
    }

    // Validate each question has the required fields.
    for (const q of questions) {
      if (!q.question || typeof q.question !== 'string') {
        return toolError('Each question must have a "question" string field');
      }
      if (!q.options || !Array.isArray(q.options) || q.options.length < 2) {
        return toolError(`Question "${q.question}" must have at least 2 options`);
      }
    }

    // Uniqueness validation — duplicate question texts would collide in the answers map (keyed by
    // question text); duplicate labels within a question make the UI
    // ambiguous and the answer unparsable.
    const questionTexts = questions.map((q) => q.question);
    if (questionTexts.length !== new Set(questionTexts).size) {
      return toolError(
        'Use distinct question text for each answer-map key and distinct option labels within each question.',
      );
    }
    for (const q of questions) {
      const labels = q.options.map((opt) => opt.label);
      if (labels.length !== new Set(labels).size) {
        return toolError(
          'Use distinct question text for each answer-map key and distinct option labels within each question.',
        );
      }
    }

    const answers = input.answers as Record<string, string> | undefined;
    const annotations = input.annotations as Record<string, Annotation> | undefined;

    // If answers are available (injected by the host via updatedInput after the
    // user responds), format them into a human-readable result for the LLM.
    if (answers && typeof answers === 'object' && Object.keys(answers).length > 0) {
      const responseLines = ['The user supplied these decisions:'];
      for (const questionText of Object.keys(answers)) {
        responseLines.push('', `Question: ${questionText}`, `Answer: ${answers[questionText]}`);
        const details = annotations?.[questionText];
        if (details?.notes) responseLines.push(`Additional feedback: ${details.notes}`);
        if (details?.preview) responseLines.push(`Chosen preview:\n${details.preview}`);
      }

      return toolSuccess(
        responseLines.join('\n'),
        { questions, answers, annotations: annotations ?? null, type: 'ask_user' },
      );
    }

    // No answers yet — the host application will intercept the canUseTool callback,
    // show the question UI, and re-invoke the tool with answers in updatedInput.
    // Return metadata so the host can render the question.
    return toolSuccess(
      `Waiting for user response to: ${questions.map(q => q.question).join(', ')}`,
      { questions, type: 'ask_user' },
    );
  },
};

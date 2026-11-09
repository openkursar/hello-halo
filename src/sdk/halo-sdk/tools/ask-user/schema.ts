/**
 * @module tools/ask-user/schema
 * AskUserQuestion tool schema and configuration.
 * @license MIT
 */

export const ASK_USER_TOOL_NAME = 'AskUserQuestion';

/**
 * Draws the line between a decision (ask) and a discussion (answer in prose):
 * a pick-one prompt in the middle of a discussion cuts it short.
 */
export const ASK_USER_TOOL_DESCRIPTION = `Ask the user one to four multiple-choice questions and wait for their answers.

Use it only when you need a discrete decision from the user before you can continue, and the answer genuinely changes what you do next — for example, which of two incompatible approaches to implement, or which files a destructive action should cover.

Don't use it for discussion. When the user is exploring an idea, thinking through a design, or asking for your view, answer in prose: give your opinion and reasoning, lay out the trade-offs, and let the conversation continue over as many turns as it needs. A pick-one prompt cuts that short and forces choices the user may not want to make yet.
Also don't use it for routine calls you can make yourself, or to ask "should I proceed?" — if the task is clear, proceed.

When you do ask:
- Offer options that are genuinely distinct, and explain the trade-off of each in its description.
- Put your recommendation first and mark it "(Recommended)".
- The user can always answer in their own words instead of picking an option.`;

/**
 * Full rich input schema for AskUserQuestion.
 * The LLM must supply a `questions` array (1-4 items) with structured options.
 * The `answers` field is injected by the host application via the canUseTool
 * permission callback (updatedInput) after the user responds.
 */
export const ASK_USER_TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      description: 'One to four decisions presented together for the user to answer.',
      minItems: 1,
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'A self-contained question that identifies the decision you need. If several selections are allowed, make that clear in the wording.',
          },
          header: {
            type: 'string',
            description:
              'Topic label for the question, no longer than 12 characters.',
          },
          options: {
            type: 'array',
            description:
              'Supply two to four meaningful alternatives. Single-select alternatives should not overlap. Leave out an Other entry because the user can already enter a free-text answer.',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                label: {
                  type: 'string',
                  description:
                    'Short selectable name, typically one to five words, that distinguishes this choice.',
                },
                description: {
                  type: 'string',
                  description:
                    'Explain the practical consequence or trade-off of selecting this option.',
                },
                preview: {
                  type: 'string',
                  description:
                    'Optional supporting preview for a single-select choice, such as a layout sample or code excerpt. Do not use with multiSelect.',
                },
              },
              required: ['label', 'description'],
            },
          },
          multiSelect: {
            type: 'boolean',
            default: false,
            description:
              'Allow several selections when the choices can apply together. Otherwise the user selects one.',
          },
        },
        required: ['question', 'header', 'options'],
      },
    },
    answers: {
      type: 'object',
      description:
        'Host-supplied answers keyed by the exact question text; the permission callback adds them through updatedInput after the user replies.',
      additionalProperties: { type: 'string' },
    },
    annotations: {
      type: 'object',
      description: 'Notes and preview selections accompanying an answer, indexed by the exact question text.',
      additionalProperties: {
        type: 'object',
        properties: {
          preview: { type: 'string', description: 'Preview shown with the option the user selected.' },
          notes: { type: 'string', description: 'Additional text supplied alongside the selected answer.' },
        },
      },
    },
    metadata: {
      type: 'object',
      description: 'Optional workflow attributes for the host, separate from the questions shown to the user.',
      properties: {
        source: {
          type: 'string',
          description: 'Caller-defined tag identifying the workflow that requested these questions.',
        },
      },
    },
  },
  required: ['questions'],
} as const;

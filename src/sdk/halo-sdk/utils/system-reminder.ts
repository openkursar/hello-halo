/**
 * @module utils/system-reminder
 * Utilities for injecting content via <system-reminder> tagged messages.
 *
 * All intermediate state injections (date, git context, mode prompts, file-read
 * safety reminders, etc.) are delivered through this mechanism.
 * Functions here are pure and have no side-effects so
 * they are trivially unit-testable without a Node runtime.
 *
 * @license MIT
 */

import type { Message } from '../types/provider.js';

// ---------------------------------------------------------------------------
// Tag constants
// ---------------------------------------------------------------------------

const OPEN_TAG = '<system-reminder>';
const CLOSE_TAG = '</system-reminder>';

// ---------------------------------------------------------------------------
// Core wrap helpers
// ---------------------------------------------------------------------------

/**
 * Wrap a string of content in `<system-reminder>` tags.
 *
 * @param content - Plain text or structured reminder text to wrap.
 * @returns The content surrounded by opening and closing system-reminder tags,
 *          each on its own line.
 *
 * @example
 * wrapInSystemReminder('Today is 2026-04-12.')
 * // => "<system-reminder>\nToday is 2026-04-12.\n</system-reminder>"
 */
export function wrapInSystemReminder(content: string): string {
  return `${OPEN_TAG}\n${content}\n${CLOSE_TAG}`;
}

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------

/**
 * Build a ready-to-inject `user` Message whose sole text block is the given
 * content wrapped in `<system-reminder>` tags.
 *
 * The returned Message is role-compatible with the `Message` type used
 * throughout the query loop and can be prepended to the conversation history
 * without modification.
 *
 * @param content - The reminder body (unwrapped plain text).
 * @returns A `Message` with role `'user'` and a single `TextBlock` payload.
 *
 * @example
 * const msg = buildSystemReminderMessage('Today is 2026-04-12.');
 * // msg.role === 'user'
 * // msg.content === [{ type: 'text', text: '<system-reminder>\nToday is 2026-04-12.\n</system-reminder>' }]
 */
export function buildSystemReminderMessage(content: string): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: wrapInSystemReminder(content),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/**
 * Return `true` if the given text string begins with the `<system-reminder>`
 * opening tag (after optional leading whitespace).
 *
 * This checks syntax only, not the authority of the content. Reminder text
 * still occupies context and must be included in token accounting.
 *
 * @param text - A raw text string, typically from a `TextBlock`.
 *
 * @example
 * isSystemReminderContent('<system-reminder>\nfoo\n</system-reminder>') // true
 * isSystemReminderContent('Hello world')                                 // false
 */
export function isSystemReminderContent(text: string): boolean {
  return text.trimStart().startsWith(OPEN_TAG);
}

/**
 * Extract the inner content from a `<system-reminder>` tagged string.
 *
 * Returns `null` if the text does not contain a complete system-reminder block.
 *
 * @param text - A string potentially containing a `<system-reminder>` block.
 * @returns The trimmed content between the tags, or `null` if not found.
 *
 * @example
 * extractSystemReminderContent('<system-reminder>\nfoo\n</system-reminder>')
 * // => 'foo'
 *
 * extractSystemReminderContent('no tags here') // => null
 */
export function extractSystemReminderContent(text: string): string | null {
  const openIdx = text.indexOf(OPEN_TAG);
  const closeIdx = text.indexOf(CLOSE_TAG);

  if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) {
    return null;
  }

  return text.slice(openIdx + OPEN_TAG.length, closeIdx).trim();
}

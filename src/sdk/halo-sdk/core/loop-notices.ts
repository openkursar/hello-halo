/**
 * @module core/loop-notices
 * Turn-boundary notice assembly for the query loop.
 *
 * Out-of-band facts (e.g. background shell task completions, goal changes) are
 * gathered at loop boundaries and joined into ONE `isMeta` user message per
 * drain — one paper slip, not a stack — with a section per notice.
 *
 * Drain sites (the callers):
 * - loop-top, each turn: background notices, goal changes, goal recitation
 * - no-tool-call exit boundary: end-of-turn checks
 * @license MIT
 */

import type { Message } from '../types/provider.js';
import { buildUserMessage } from './messages.js';

/** A labeled list of notice lines, or a self-describing block of text. */
export type NoticeSection =
  | { label: string; items: string[] }
  | { text: string | null };

/**
 * Join all non-empty sections into a single `isMeta` user message wrapped in
 * a `<system-reminder>` tag. Returns `null` when there is nothing to say, so
 * callers can skip the append entirely (scarcity: no empty slips).
 */
export function buildNoticeMessage(sections: NoticeSection[]): Message | null {
  const parts: string[] = [];
  for (const section of sections) {
    if ('text' in section) {
      if (section.text) parts.push(section.text);
      continue;
    }
    if (section.items.length === 0) continue;
    parts.push(`${section.label}:\n${section.items.map((i) => `- ${i}`).join('\n')}`);
  }
  if (parts.length === 0) return null;

  const msg = buildUserMessage(
    `<system-reminder>\n${parts.join('\n\n')}\n</system-reminder>`,
  );
  (msg as Message & { isMeta?: boolean }).isMeta = true;
  return msg;
}
